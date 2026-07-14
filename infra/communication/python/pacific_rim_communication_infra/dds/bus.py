from __future__ import annotations

import asyncio
import os
import time
from dataclasses import replace
from typing import Any, Mapping

from pacific_rim_communication_infra.contracts import TransportKind
from pacific_rim_communication_infra.core import (
  BytesHandler,
  ChannelLike,
  MiddlewareCapabilities,
  RequestHandler,
  channel_name,
)

from .cyclonedds import (
  CycloneDdsClient,
  CycloneDdsConfig,
  CycloneDdsRPCAdapter,
  CycloneDdsRPCBinding,
  CycloneDdsSubscription,
  CycloneDdsTopicConfig,
)


class CycloneDdsMessageBus:
  kind = TransportKind.CYCLONE_DDS
  capabilities = MiddlewareCapabilities(publish_subscribe=True, request_reply=True)

  def __init__(
    self,
    client: CycloneDdsClient,
    type_name: str = "PacificRimMessageEnvelope",
    rpc_adapters: Mapping[str, CycloneDdsRPCAdapter] | None = None,
  ):
    self._client = client
    self._type_name = type_name
    self._qos = dict(getattr(client.config, "qos", {}) or {})
    default_adapter = TopicRPCAdapter(client)
    self._rpc_adapters = {
      "omg_dds_rpc": default_adapter,
      "rmw_cyclonedds": default_adapter,
    }
    self._rpc_adapters.update({str(key): value for key, value in dict(rpc_adapters or {}).items()})
    self._default_adapter = default_adapter

  @classmethod
  def from_options(cls, options: Mapping[str, Any]) -> "CycloneDdsMessageBus":
    config = CycloneDdsConfig()
    values: dict[str, Any] = {"domain_id": native_domain_id_from_options(options)}
    for key in ("participant_name", "config_uri", "read_period_sec"):
      if key in options:
        values[key] = options[key]
    qos = {
      str(key)[4:]: value
      for key, value in options.items()
      if str(key).startswith("qos.")
    }
    if "qos" in options:
      qos["profile"] = options["qos"]
    if qos:
      values["qos"] = qos
    type_name = str(options.get("type_name", "PacificRimMessageEnvelope"))
    return cls(CycloneDdsClient(replace(config, **values)), type_name=type_name)

  async def connect(self) -> None:
    await self._client.connect()

  async def close(self) -> None:
    for adapter in {self._default_adapter, *self._rpc_adapters.values()}:
      close = getattr(adapter, "close", None)
      if close is not None:
        result = close()
        if asyncio.iscoroutine(result):
          await result
    await self._client.close()

  async def publish_bytes(self, channel: ChannelLike, payload: bytes) -> None:
    await self._client.publish(self._topic(channel), payload)

  async def subscribe_bytes(self, channel: ChannelLike, handler: BytesHandler) -> None:
    await self._client.subscribe(CycloneDdsSubscription(self._topic(channel)), handler)

  async def request_bytes(
    self,
    channel: ChannelLike,
    payload: bytes,
    timeout_sec: float = 2.0,
  ) -> bytes:
    binding = self._rpc_binding(channel)
    adapter = self._rpc_adapters.get(binding.standard)
    if adapter is None:
      raise NotImplementedError(
        "CycloneDDS request/reply requires an infra DDS RPC adapter for "
        f"{binding.standard}. Configure standard: omg_dds_rpc or "
        "standard: rmw_cyclonedds, and register the matching adapter in "
        "infra/communication/dds."
      )
    return await adapter.request(binding, payload, timeout_sec)

  async def handle_request_bytes(
    self,
    channel: ChannelLike,
    handler: RequestHandler,
  ) -> None:
    binding = self._rpc_binding(channel)
    adapter = self._rpc_adapters.get(binding.standard)
    if adapter is None:
      raise NotImplementedError(
        "CycloneDDS request/reply requires an infra DDS RPC adapter for "
        f"{binding.standard}. Configure standard: omg_dds_rpc or "
        "standard: rmw_cyclonedds, and register the matching adapter in "
        "infra/communication/dds."
      )
    await adapter.handle_request(binding, handler)

  def _topic(self, channel: ChannelLike) -> CycloneDdsTopicConfig:
    qos = dict(self._qos)
    metadata = channel.metadata if hasattr(channel, "metadata") else {}
    for key, value in dict(metadata or {}).items():
      if key == "qos":
        qos["profile"] = value
      elif str(key).startswith("qos."):
        qos[str(key)[4:]] = value
    type_name = self._type_name
    typed_type = _typed_dds_type(dict(metadata or {}))
    supports_typed = getattr(self._client, "supports_typed_dds", None)
    if typed_type and supports_typed is not None and supports_typed(typed_type):
      type_name = typed_type
    return CycloneDdsTopicConfig(topic_name=channel_name(channel), type_name=type_name, qos=qos)

  def _rpc_binding(self, channel: ChannelLike) -> CycloneDdsRPCBinding:
    metadata = channel.metadata if hasattr(channel, "metadata") else {}
    standard = self._standard(dict(metadata or {}).get("rpc.standard", ""))
    request_name = str(dict(metadata or {}).get("rpc.request_channel") or channel_name(channel)).strip()
    response_name = str(dict(metadata or {}).get("rpc.response_channel") or f"{request_name}.reply").strip()
    request_channel = CycloneDdsTopicConfig(
      topic_name=request_name,
      type_name=self._topic(channel).type_name,
      qos=self._qos_from_metadata(metadata),
    )
    response_channel = CycloneDdsTopicConfig(
      topic_name=response_name,
      type_name=self._topic(channel).type_name,
      qos=self._qos_from_metadata(metadata),
    )
    return CycloneDdsRPCBinding(
      standard=standard,
      request_channel=request_channel,
      response_channel=response_channel,
    )

  def _qos_from_metadata(self, metadata: Mapping[str, Any]) -> dict[str, Any]:
    qos = dict(self._qos)
    for key, value in dict(metadata or {}).items():
      if key == "qos":
        qos["profile"] = value
      elif str(key).startswith("qos."):
        qos[str(key)[4:]] = value
    return qos

  @staticmethod
  def _standard(value: Any) -> str:
    normalized = str(value or "").strip().lower().replace("-", "_")
    aliases = {
      "": "omg_dds_rpc",
      "omg": "omg_dds_rpc",
      "dds_rpc": "omg_dds_rpc",
      "omg_dds_rpc": "omg_dds_rpc",
      "rmw": "rmw_cyclonedds",
      "rmw_cyclonedds": "rmw_cyclonedds",
      "rmw_cyclonedds_cpp": "rmw_cyclonedds",
      "ros2_rmw": "rmw_cyclonedds",
    }
    return aliases.get(normalized, normalized)


class TopicRPCAdapter(CycloneDdsRPCAdapter):
  standard = "omg_dds_rpc"
  ready_period_sec = 0.005
  ready_wait_sec = 1.5
  probe_wait_sec = 1.5

  def __init__(self, client: CycloneDdsClient):
    self._client = client
    self._ready_tasks: set[asyncio.Task[None]] = set()

  async def request(
    self,
    binding: CycloneDdsRPCBinding,
    payload: bytes,
    timeout_sec: float,
  ) -> bytes:
    if timeout_sec <= 0:
      timeout_sec = 2.0
    loop = asyncio.get_running_loop()
    response_future: asyncio.Future[bytes] = loop.create_future()
    handshake_future: asyncio.Future[None] = loop.create_future()
    probe_frame = _new_rpc_probe_frame()
    ack_frame = _rpc_ack_frame_for_probe(probe_frame)

    async def on_response(data: bytes) -> None:
      if not response_future.done():
        response_future.set_result(bytes(data))

    unsubscribe_response = await self._client.subscribe(CycloneDdsSubscription(binding.response_channel), on_response)
    unsubscribe_ack = await self._client.subscribe(
      CycloneDdsSubscription(_rpc_probe_ack_channel(binding)),
      lambda data: _set_handshake_if_ack(data, ack_frame, handshake_future),
    )
    try:
      await self._client.prepare_publish(binding.request_channel)
      await self._client.prepare_publish(_rpc_probe_channel(binding))
      if await self._wait_for_ready(binding, min(timeout_sec, self.ready_wait_sec)):
        await self._wait_for_subscribers(binding.request_channel, min(timeout_sec, 1.0))
        await self._wait_for_subscribers(_rpc_probe_channel(binding), min(timeout_sec, 0.5))
        await self._probe_rpc_pairing(
          binding,
          probe_frame,
          handshake_future,
          min(timeout_sec, self.probe_wait_sec),
        )
      await self._client.publish(binding.request_channel, payload)
      return await asyncio.wait_for(response_future, timeout=timeout_sec)
    finally:
      unsubscribe_response()
      unsubscribe_ack()

  async def handle_request(
    self,
    binding: CycloneDdsRPCBinding,
    handler: RequestHandler,
  ) -> None:
    async def on_request(data: bytes) -> None:
      result = handler(bytes(data))
      if asyncio.iscoroutine(result):
        result = await result
      await self._wait_for_subscribers(binding.response_channel, 1.0)
      await self._client.publish(binding.response_channel, bytes(result or b""))

    await self._client.prepare_publish(binding.response_channel)
    await self._client.prepare_publish(_rpc_probe_ack_channel(binding))
    await self._client.subscribe(CycloneDdsSubscription(binding.request_channel), on_request)
    await self._client.subscribe(
      CycloneDdsSubscription(_rpc_probe_channel(binding)),
      lambda data: self._handle_probe(binding, data),
    )
    await self._start_ready_publisher(binding)

  async def close(self) -> None:
    for task in list(self._ready_tasks):
      task.cancel()
    if self._ready_tasks:
      await asyncio.gather(*self._ready_tasks, return_exceptions=True)
    self._ready_tasks.clear()

  async def _wait_for_ready(self, binding: CycloneDdsRPCBinding, timeout_sec: float) -> bool:
    loop = asyncio.get_running_loop()
    ready: asyncio.Future[None] = loop.create_future()

    async def on_ready(_: bytes) -> None:
      if not ready.done():
        ready.set_result(None)

    unsubscribe = await self._client.subscribe(CycloneDdsSubscription(_rpc_ready_channel(binding)), on_ready)
    try:
      await asyncio.wait_for(ready, timeout=max(0.0, timeout_sec))
      return True
    except asyncio.TimeoutError:
      return False
    finally:
      unsubscribe()

  async def _wait_for_subscribers(self, topic: CycloneDdsTopicConfig, timeout_sec: float) -> bool:
    wait_for_subscribers = getattr(self._client, "wait_for_subscribers", None)
    if wait_for_subscribers is None:
      return True
    waited = wait_for_subscribers(topic, timeout_sec=timeout_sec)
    if asyncio.iscoroutine(waited):
      return bool(await waited)
    return bool(waited)

  async def _wait_for_publishers(self, topic: CycloneDdsTopicConfig, timeout_sec: float) -> bool:
    wait_for_publishers = getattr(self._client, "wait_for_publishers", None)
    if wait_for_publishers is None:
      return True
    waited = wait_for_publishers(topic, timeout_sec=timeout_sec)
    if asyncio.iscoroutine(waited):
      return bool(await waited)
    return bool(waited)

  async def _probe_rpc_pairing(
    self,
    binding: CycloneDdsRPCBinding,
    probe_frame: bytes,
    handshake_future: asyncio.Future[None],
    timeout_sec: float,
  ) -> None:
    deadline = asyncio.get_running_loop().time() + max(0.0, timeout_sec)
    while not handshake_future.done() and asyncio.get_running_loop().time() < deadline:
      await self._client.publish(_rpc_probe_channel(binding), probe_frame)
      try:
        await asyncio.wait_for(
          asyncio.shield(handshake_future),
          timeout=min(0.005, max(0.0, deadline - asyncio.get_running_loop().time())),
        )
      except asyncio.TimeoutError:
        pass
    if not handshake_future.done():
      raise TimeoutError(f"CycloneDDS RPC endpoint pairing timed out: {binding.request_channel.topic_name}")

  async def _start_ready_publisher(self, binding: CycloneDdsRPCBinding) -> None:
    channel = _rpc_ready_channel(binding)
    await self._client.prepare_publish(channel)

    async def publish_ready() -> None:
      while self._client.is_connected:
        await self._wait_for_publishers(binding.request_channel, 0.1)
        await self._wait_for_subscribers(channel, 0.1)
        await self._client.publish(channel, b"ready")
        await asyncio.sleep(self.ready_period_sec)

    task = asyncio.create_task(publish_ready())
    self._ready_tasks.add(task)
    task.add_done_callback(self._ready_tasks.discard)

  async def _handle_probe(self, binding: CycloneDdsRPCBinding, data: bytes) -> None:
    if not data.startswith(_RPC_PROBE_PREFIX):
      return
    ack_channel = _rpc_probe_ack_channel(binding)
    await self._wait_for_subscribers(ack_channel, 0.5)
    await self._client.publish(ack_channel, _rpc_ack_frame_for_probe(data))


def _rpc_ready_channel(binding: CycloneDdsRPCBinding) -> CycloneDdsTopicConfig:
  return replace(binding.request_channel, topic_name=f"{binding.request_channel.topic_name}.__pr_ready")


def _rpc_probe_channel(binding: CycloneDdsRPCBinding) -> CycloneDdsTopicConfig:
  return replace(binding.request_channel, topic_name=f"{binding.request_channel.topic_name}.__pr_probe")


def _rpc_probe_ack_channel(binding: CycloneDdsRPCBinding) -> CycloneDdsTopicConfig:
  return replace(binding.response_channel, topic_name=f"{binding.response_channel.topic_name}.__pr_probe_ack")


def _typed_dds_type(metadata: Mapping[str, Any]) -> str:
  mode = str(metadata.get("dds.mode") or "").strip().lower().replace("-", "_")
  language = str(metadata.get("schema.language") or "").strip().lower()
  if mode not in {"typed", "typed_preferred"} and language != "omg_idl":
    return ""
  return str(metadata.get("dds.type") or metadata.get("schema.type") or "").strip()


_RPC_PROBE_PREFIX = b"\x00PRPC_READY_V1\x00probe:"
_RPC_ACK_PREFIX = b"\x00PRPC_READY_V1\x00ack:"


def _new_rpc_probe_frame() -> bytes:
  return _RPC_PROBE_PREFIX + str(time.time_ns()).encode("ascii")


def _rpc_ack_frame_for_probe(probe: bytes) -> bytes:
  return _RPC_ACK_PREFIX + bytes(probe[len(_RPC_PROBE_PREFIX):])


def _set_handshake_if_ack(data: bytes, ack_frame: bytes, future: asyncio.Future[None]) -> None:
  if data == ack_frame and not future.done():
    future.set_result(None)


def _optional_int(value: Any) -> int | None:
  if value is None or value == "":
    return None
  return int(value)


def native_domain_id_from_options(options: Mapping[str, Any]) -> int:
  for key in ("native_domain_id", "domain_id"):
    value = _optional_int(options.get(key))
    if value is not None:
      return value
  native_env = _optional_int(os.environ.get("PACIFIC_RIM_NATIVE_DDS_DOMAIN_ID"))
  if native_env is not None:
    return native_env
  ros_domain = _optional_int(options.get("ros_domain_id"))
  if ros_domain is None:
    ros_domain = _optional_int(os.environ.get("ROS_DOMAIN_ID")) or 0
  return ros_domain + native_domain_offset_from_options(options)


def native_domain_offset_from_options(options: Mapping[str, Any]) -> int:
  offset = _optional_int(options.get("native_domain_offset"))
  if offset is not None:
    return offset
  env_offset = _optional_int(os.environ.get("PACIFIC_RIM_NATIVE_DDS_DOMAIN_OFFSET"))
  return env_offset if env_offset is not None else 100
