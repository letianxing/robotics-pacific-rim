from __future__ import annotations

import asyncio
import os
import threading
import time
from typing import Any, Mapping

from pacific_rim_communication_infra.contracts import TransportKind
from pacific_rim_communication_infra.core import (
  BytesHandler,
  ChannelLike,
  MiddlewareCapabilities,
  RequestHandler,
  channel_name,
)
from pacific_rim_communication_infra.ros2 import typed_mapper

try:
  from pacific_rim_trace import current_traceparent, route_span_name, start_span_from_carrier
except (ImportError, ModuleNotFoundError):  # pragma: no cover - optional observability package.
  current_traceparent = None
  route_span_name = None
  start_span_from_carrier = None

try:
  from pacific_rim_metric import histogram as metric_histogram, runtime_metric_names
except (ImportError, ModuleNotFoundError):  # pragma: no cover - optional observability package.
  metric_histogram = None
  runtime_metric_names = {}

try:
  from common.msg import ProtoEnvelope
  from common.srv import ProtoCall
except ModuleNotFoundError:  # pragma: no cover - exercised in ROS2 envs.
  ProtoEnvelope = None
  ProtoCall = None


_latency_histogram: Any | None = None
_latency_histogram_lock = threading.Lock()


class Ros2ProtoEnvelopeBus:
  kind = TransportKind.ROS2
  capabilities = MiddlewareCapabilities(publish_subscribe=True, request_reply=True)

  def __init__(
    self,
    node_name: str = "pacific_rim_ros2_proto_envelope",
    domain_id: int | None = None,
    queue_size: int = 10,
    executor_threads: int = 2,
  ):
    self._node_name = node_name
    self._domain_id = domain_id
    self._queue_size = queue_size
    self._executor_threads = max(1, int(executor_threads))
    self._context = None
    self._node = None
    self._executor = None
    self._callback_group = None
    self._thread = None
    self._publishers: dict[str, Any] = {}
    self._subscriptions: list[Any] = []
    self._services: list[Any] = []
    self._clients: dict[str, Any] = {}

  @classmethod
  def from_options(cls, options: Mapping[str, Any]) -> "Ros2ProtoEnvelopeBus":
    mode = str(options.get("mode") or options.get("backend") or "native").strip().lower()
    if mode not in {"native", "bridge"}:
      raise ValueError(f"unsupported ROS2 middleware mode: {mode}")
    if mode == "bridge":
      raise NotImplementedError(
        "ROS2 bridge mode is selected for this process. Start the configured "
        "Go/Python sidecar bridge instead of creating an in-process ROS2 bus."
      )
    return cls(
      node_name=str(options.get("name") or options.get("node_name") or "pacific_rim_ros2_proto_envelope"),
      domain_id=_first_optional_int(options, "domain_id", "ros_domain_id", env_key="ROS_DOMAIN_ID"),
      queue_size=int(options.get("queue_size") or options.get("qos.depth") or 10),
      executor_threads=int(options.get("executor_threads") or 2),
    )

  async def connect(self) -> None:
    if self._node is not None:
      return
    import rclpy
    from rclpy.callback_groups import ReentrantCallbackGroup
    from rclpy.executors import MultiThreadedExecutor

    self._require_envelope_types()
    self._context = rclpy.context.Context()
    init_kwargs = {"args": None, "context": self._context}
    if self._domain_id is not None:
      init_kwargs["domain_id"] = self._domain_id
    try:
      rclpy.init(**init_kwargs)
    except TypeError:
      previous_domain = os.environ.get("ROS_DOMAIN_ID")
      if self._domain_id is not None:
        os.environ["ROS_DOMAIN_ID"] = str(self._domain_id)
      try:
        rclpy.init(args=None, context=self._context)
      finally:
        if self._domain_id is not None:
          if previous_domain is None:
            os.environ.pop("ROS_DOMAIN_ID", None)
          else:
            os.environ["ROS_DOMAIN_ID"] = previous_domain
    self._node = rclpy.create_node(self._node_name, context=self._context)
    self._callback_group = ReentrantCallbackGroup()
    self._executor = MultiThreadedExecutor(num_threads=self._executor_threads, context=self._context)
    self._executor.add_node(self._node)
    self._thread = threading.Thread(target=self._executor.spin, name=self._node_name, daemon=True)
    self._thread.start()
    await asyncio.sleep(0)

  async def close(self) -> None:
    if self._executor is not None:
      self._executor.shutdown()
    if self._thread is not None and self._thread.is_alive():
      self._thread.join(timeout=5.0)
    if self._node is not None:
      self._node.destroy_node()
    if self._context is not None and self._context.ok():
      self._context.shutdown()
    self._clients.clear()
    self._services.clear()
    self._subscriptions.clear()
    self._publishers.clear()
    self._thread = None
    self._executor = None
    self._callback_group = None
    self._node = None
    self._context = None

  async def publish_bytes(self, channel: ChannelLike, payload: bytes) -> None:
    self._ensure_connected()
    if self._adapter(channel) == "ros2_typed_mapper":
      await self._publish_typed_mapper(channel, payload)
      return
    publisher = self._publisher(channel)
    await self._wait_for_topic_subscribers(channel, timeout_sec=0.5)
    publisher.publish(_message_from_payload(channel, payload))

  async def subscribe_bytes(self, channel: ChannelLike, handler: BytesHandler) -> None:
    self._ensure_connected()
    adapter = self._adapter(channel)
    if adapter == "ros2_typed_mapper":
      await self._subscribe_typed_mapper(channel, handler)
      return
    self._require_proto_envelope(channel)

    async def invoke(payload: bytes) -> None:
      result = handler(payload)
      if asyncio.iscoroutine(result):
        await result

    loop = asyncio.get_running_loop()

    def callback(message: Any) -> None:
      _record_message_latency(channel, getattr(message, "created_at_unix_ms", 0), "topic", "message")
      asyncio.run_coroutine_threadsafe(invoke(bytes(message.payload)), loop)

    subscription = self._node.create_subscription(
      ProtoEnvelope,
      channel_name(channel),
      callback,
      _queue_size(channel, self._queue_size),
      callback_group=self._callback_group,
    )
    self._subscriptions.append(subscription)

  async def request_bytes(
    self,
    channel: ChannelLike,
    payload: bytes,
    timeout_sec: float = 2.0,
  ) -> bytes:
    self._ensure_connected()
    adapter = self._adapter(channel)
    if adapter == "ros2_typed_mapper":
      return await self._request_typed_mapper(channel, payload, timeout_sec)
    self._require_proto_envelope(channel)
    client = self._client(channel)
    started_at = time.monotonic()
    if not client.wait_for_service(timeout_sec=timeout_sec):
      raise TimeoutError(f"ROS2 service not available: {channel_name(channel)}")
    remaining = max(0.001, timeout_sec - (time.monotonic() - started_at))
    future = client.call_async(_request_from_payload(channel, payload))
    deadline = time.monotonic() + remaining
    while not future.done():
      if time.monotonic() >= deadline:
        raise TimeoutError(f"ROS2 service request timed out: {channel_name(channel)}")
      await asyncio.sleep(0.001)
    response = future.result()
    _record_message_latency(channel, getattr(response, "created_at_unix_ms", 0), "service", "response")
    return bytes(response.payload)

  async def handle_request_bytes(
    self,
    channel: ChannelLike,
    handler: RequestHandler,
  ) -> None:
    self._ensure_connected()
    adapter = self._adapter(channel)
    if adapter == "ros2_typed_mapper":
      await self._handle_typed_mapper_request(channel, handler)
      return
    self._require_proto_envelope(channel)

    def callback(request: Any, response: Any) -> Any:
      _record_message_latency(channel, getattr(request, "created_at_unix_ms", 0), "service", "request")
      span = _server_span(channel, getattr(request, "traceparent", ""))
      try:
        result = handler(bytes(request.payload))
        if asyncio.iscoroutine(result):
          loop = asyncio.new_event_loop()
          try:
            result = loop.run_until_complete(result)
          finally:
            loop.close()
      finally:
        if span is not None:
          span.end()
      _fill_envelope_fields(response, channel, bytes(result or b""))
      if span is not None:
        response.traceparent = _traceparent_from_span(span)
      return response

    service = self._node.create_service(
      ProtoCall,
      channel_name(channel),
      callback,
      callback_group=self._callback_group,
    )
    self._services.append(service)

  def _publisher(self, channel: ChannelLike):
    self._require_proto_envelope(channel)
    name = channel_name(channel)
    publisher = self._publishers.get(name)
    if publisher is None:
      publisher = self._node.create_publisher(
        ProtoEnvelope,
        name,
        _queue_size(channel, self._queue_size),
        callback_group=self._callback_group,
      )
      self._publishers[name] = publisher
    return publisher

  def _client(self, channel: ChannelLike):
    name = channel_name(channel)
    client = self._clients.get(name)
    if client is None:
      client = self._node.create_client(
        ProtoCall,
        name,
        callback_group=self._callback_group,
      )
      self._clients[name] = client
    return client

  def _ensure_connected(self) -> None:
    if self._node is None:
      raise RuntimeError("ROS2 proto envelope bus is not connected")

  def _adapter(self, channel: ChannelLike) -> str:
    metadata = _metadata(channel)
    return str(metadata.get("adapter") or metadata.get("ros2.adapter") or "").strip().lower().replace("-", "_")

  def _require_proto_envelope(self, channel: ChannelLike) -> None:
    if self._adapter(channel) != "ros2_proto_envelope":
      raise ValueError("ROS2 byte bus supports adapter: ros2_proto_envelope or ros2_typed_mapper")

  async def _publish_typed_mapper(self, channel: ChannelLike, payload: bytes) -> None:
    from rosidl_runtime_py.utilities import get_message

    message_class = get_message(typed_mapper.ros2_message_type(channel))
    name = channel_name(channel)
    publisher = self._publishers.get(name)
    if publisher is None:
      publisher = self._node.create_publisher(
        message_class,
        name,
        _queue_size(channel, self._queue_size),
        callback_group=self._callback_group,
      )
      self._publishers[name] = publisher
    await self._wait_for_topic_subscribers(channel, timeout_sec=0.5)
    publisher.publish(typed_mapper.proto_to_ros2(channel, payload))

  async def _wait_for_topic_subscribers(self, channel: ChannelLike, timeout_sec: float) -> None:
    name = channel_name(channel)
    deadline = time.monotonic() + max(0.0, timeout_sec)
    while time.monotonic() < deadline:
      try:
        if self._node.count_subscribers(name) > 0:
          return
      except Exception:
        return
      await asyncio.sleep(0.01)

  async def _subscribe_typed_mapper(self, channel: ChannelLike, handler: BytesHandler) -> None:
    from rosidl_runtime_py.utilities import get_message

    message_class = get_message(typed_mapper.ros2_message_type(channel))

    async def invoke(message: Any) -> None:
      result = handler(typed_mapper.ros2_to_proto(channel, message))
      if asyncio.iscoroutine(result):
        await result

    loop = asyncio.get_running_loop()

    def callback(message: Any) -> None:
      asyncio.run_coroutine_threadsafe(invoke(message), loop)

    subscription = self._node.create_subscription(
      message_class,
      channel_name(channel),
      callback,
      _queue_size(channel, self._queue_size),
      callback_group=self._callback_group,
    )
    self._subscriptions.append(subscription)

  async def _request_typed_mapper(
    self,
    channel: ChannelLike,
    payload: bytes,
    timeout_sec: float,
  ) -> bytes:
    from rosidl_runtime_py.utilities import get_service

    service_class = get_service(typed_mapper.ros2_service_type(channel))
    client = self._clients.get(channel_name(channel))
    if client is None:
      client = self._node.create_client(
        service_class,
        channel_name(channel),
        callback_group=self._callback_group,
      )
      self._clients[channel_name(channel)] = client
    if not client.wait_for_service(timeout_sec=timeout_sec):
      raise TimeoutError(f"ROS2 service not available: {channel_name(channel)}")
    future = client.call_async(typed_mapper.proto_to_ros2(channel, payload))
    deadline = time.monotonic() + timeout_sec
    while not future.done():
      if time.monotonic() >= deadline:
        raise TimeoutError(f"ROS2 service request timed out: {channel_name(channel)}")
      await asyncio.sleep(0.001)
    return typed_mapper.ros2_to_proto(channel, future.result())

  async def _handle_typed_mapper_request(
    self,
    channel: ChannelLike,
    handler: RequestHandler,
  ) -> None:
    from rosidl_runtime_py.utilities import get_service

    service_class = get_service(typed_mapper.ros2_service_type(channel))

    def callback(request: Any, response: Any) -> Any:
      payload = typed_mapper.ros2_to_proto(channel, request)
      result = handler(payload)
      if asyncio.iscoroutine(result):
        loop = asyncio.new_event_loop()
        try:
          result = loop.run_until_complete(result)
        finally:
          loop.close()
      mapped = typed_mapper.proto_to_ros2(channel, bytes(result or b""))
      for name in getattr(mapped, "__slots__", []):
        setattr(response, name, getattr(mapped, name))
      return response

    service = self._node.create_service(
      service_class,
      channel_name(channel),
      callback,
      callback_group=self._callback_group,
    )
    self._services.append(service)

  @staticmethod
  def _require_envelope_types() -> None:
    if ProtoEnvelope is None or ProtoCall is None:
      raise RuntimeError(
        "common is required for ROS2 protobuf envelope transport"
      )


def _message_from_payload(channel: ChannelLike, payload: bytes) -> Any:
  message = ProtoEnvelope()
  _fill_envelope_fields(message, channel, payload)
  return message


def _request_from_payload(channel: ChannelLike, payload: bytes) -> Any:
  request = ProtoCall.Request()
  _fill_envelope_fields(request, channel, payload)
  return request


def _fill_envelope_fields(message: Any, channel: ChannelLike, payload: bytes) -> None:
  metadata = _metadata(channel)
  message.schema_type = str(getattr(channel, "message_type", "") or metadata.get("schema.type", ""))
  message.codec = str(metadata.get("codec") or "protobuf")
  message.route = str(metadata.get("logical_route") or metadata.get("source_name") or channel_name(channel))
  message.trace_id = str(metadata.get("trace_id") or "")
  if current_traceparent is not None and hasattr(message, "traceparent"):
    message.traceparent = current_traceparent()
  message.created_at_unix_ms = int(time.time() * 1000)
  message.payload = list(payload)


def _get_latency_histogram() -> Any | None:
  global _latency_histogram
  if metric_histogram is None:
    return None
  if _latency_histogram is None:
    with _latency_histogram_lock:
      if _latency_histogram is None:
        _latency_histogram = metric_histogram(
          runtime_metric_names.get("message_latency", "pacific_rim.message.latency")
        )
  return _latency_histogram


def _record_message_latency(
  channel: ChannelLike,
  created_at_unix_ms: Any,
  kind: str,
  phase: str,
) -> None:
  try:
    created_at = int(created_at_unix_ms)
  except (TypeError, ValueError):
    return
  if created_at <= 0:
    return
  metric = _get_latency_histogram()
  if metric is None:
    return
  latency_ms = max(0, int(time.time() * 1000) - created_at)
  route = _route_label(channel)
  name = channel_name(channel)
  attributes: dict[str, Any] = {
    "transport": "ros2",
    "kind": kind,
    "phase": phase,
    "direction": "in",
    "route": route,
  }
  if kind == "service":
    attributes["service"] = name
  else:
    attributes["topic"] = name
  try:
    metric.record(float(latency_ms), attributes)
  except Exception:
    return


def _route_label(channel: ChannelLike) -> str:
  metadata = _metadata(channel)
  return str(metadata.get("logical_route") or metadata.get("source_name") or channel_name(channel))


def _metadata(channel: ChannelLike) -> Mapping[str, Any]:
  return getattr(channel, "metadata", {}) or {}


def _queue_size(channel: ChannelLike, fallback: int) -> int:
  metadata = _metadata(channel)
  value = metadata.get("qos.depth") or getattr(channel, "queue_size", 0) or fallback
  try:
    return int(value)
  except (TypeError, ValueError):
    return fallback


def _optional_int(value: Any) -> int | None:
  if value is None or value == "":
    return None
  return int(value)


def _first_optional_int(options: Mapping[str, Any], *keys: str, env_key: str | None = None) -> int | None:
  for key in keys:
    value = _optional_int(options.get(key))
    if value is not None:
      return value
  if env_key:
    return _optional_int(os.environ.get(env_key))
  return None


def _server_span(channel: ChannelLike, traceparent: str):
  if start_span_from_carrier is None:
    return None
  metadata = dict(_metadata(channel))
  name = (
    route_span_name(channel_name(channel), metadata, "server")
    if route_span_name is not None
    else channel_name(channel)
  )
  return start_span_from_carrier(
    name,
    {"traceparent": traceparent} if traceparent else {},
    {
      "pr.transport": "ros2_service",
      "pr.route": str(metadata.get("logical_route") or ""),
    },
  )


def _traceparent_from_span(span: Any) -> str:
  trace_id = getattr(span, "trace_id", "")
  span_id = getattr(span, "span_id", "")
  return f"00-{trace_id}-{span_id}-01" if trace_id and span_id else ""
