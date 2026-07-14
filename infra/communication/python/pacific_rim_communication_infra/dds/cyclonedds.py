from __future__ import annotations

import asyncio
import binascii
import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping


_BYTES_TOPIC_TYPES: dict[str, type] = {}
_TYPED_DDS_TOPIC_TYPES: dict[str, type] = {}


@dataclass(frozen=True)
class CycloneDdsConfig:
  domain_id: int = 0
  participant_name: str = "pacific-rim"
  config_uri: str = ""
  read_period_sec: float = 0.001
  qos: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CycloneDdsTopicConfig:
  topic_name: str
  type_name: str = "PacificRimMessageEnvelope"
  qos: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CycloneDdsSubscription:
  topic: CycloneDdsTopicConfig


@dataclass(frozen=True)
class CycloneDdsRPCBinding:
  standard: str = "omg_dds_rpc"
  request_channel: CycloneDdsTopicConfig = field(default_factory=lambda: CycloneDdsTopicConfig(""))
  response_channel: CycloneDdsTopicConfig = field(default_factory=lambda: CycloneDdsTopicConfig(""))


class CycloneDdsRPCAdapter:
  standard = "omg_dds_rpc"

  async def request(
    self,
    binding: CycloneDdsRPCBinding,
    payload: bytes,
    timeout_sec: float,
  ) -> bytes:
    raise NotImplementedError

  async def handle_request(
    self,
    binding: CycloneDdsRPCBinding,
    handler: Callable[[bytes], Awaitable[bytes] | bytes],
  ) -> None:
    raise NotImplementedError


class CycloneDdsClient:
  def __init__(self, config: CycloneDdsConfig):
    self.config = config
    self._participant = None
    self._publishers: dict[str, tuple[Any, type]] = {}
    self._readers: dict[str, Any] = {}
    self._reader_callbacks: dict[str, list[Callable[[bytes], Awaitable[None] | None]]] = {}
    self._subscribers: list[asyncio.Task] = []
    self._closed = False

  async def connect(self) -> None:
    try:
      from cyclonedds.domain import DomainParticipant
    except ImportError as exc:
      raise RuntimeError(
        "cyclonedds is required for CycloneDdsClient. "
        "Install the optional CycloneDDS Python binding and native CycloneDDS runtime."
      ) from exc

    kwargs: dict[str, Any] = {"domain_id": self.config.domain_id}
    if self.config.config_uri:
      kwargs["config"] = self.config.config_uri
    self._participant = DomainParticipant(**kwargs)
    self._closed = False

  @property
  def is_connected(self) -> bool:
    return self._participant is not None and not self._closed

  def supports_typed_dds(self, type_name: str) -> bool:
    return _normalize_type_name(type_name) in _TYPED_DDS_TOPIC_TYPES

  async def publish(self, topic: CycloneDdsTopicConfig, payload: bytes) -> None:
    writer, sample_type = self._writer_for(topic)
    maybe_result = writer.write(self._sample(sample_type, payload))
    if asyncio.iscoroutine(maybe_result):
      await maybe_result

  async def prepare_publish(self, topic: CycloneDdsTopicConfig) -> None:
    self._writer_for(topic)

  async def subscribe(
    self,
    subscription: CycloneDdsSubscription,
    callback: Callable[[bytes], Awaitable[None] | None],
  ) -> Callable[[], None]:
    key = self._topic_key(subscription.topic)
    callbacks = self._reader_callbacks.get(key)
    if callbacks is None:
      callbacks = []
      self._reader_callbacks[key] = callbacks
      reader = self._reader_for(subscription.topic)
      self._readers[key] = reader
      task = asyncio.create_task(self._read_loop(key, reader))
      self._subscribers.append(task)
    callbacks.append(callback)

    def unsubscribe() -> None:
      current = self._reader_callbacks.get(key)
      if current is None:
        return
      try:
        current.remove(callback)
      except ValueError:
        pass

    return unsubscribe

  async def close(self) -> None:
    self._closed = True
    for task in self._subscribers:
      task.cancel()
    if self._subscribers:
      await asyncio.gather(*self._subscribers, return_exceptions=True)
    self._subscribers.clear()
    self._publishers.clear()
    self._reader_callbacks.clear()
    self._readers.clear()
    self._participant = None

  def _writer_for(self, topic: CycloneDdsTopicConfig):
    if not self.is_connected:
      raise RuntimeError("CycloneDDS is not connected")

    key = self._topic_key(topic)
    if key not in self._publishers:
      from cyclonedds.pub import DataWriter

      topic_object, topic_type = self._topic(topic)
      qos = self._qos(topic.qos)
      if qos is None:
        self._publishers[key] = (DataWriter(self._participant, topic_object), topic_type)
      else:
        self._publishers[key] = (DataWriter(self._participant, topic_object, qos=qos), topic_type)

    return self._publishers[key]

  def _reader_for(self, topic: CycloneDdsTopicConfig):
    if not self.is_connected:
      raise RuntimeError("CycloneDDS is not connected")

    from cyclonedds.sub import DataReader

    topic_object, _ = self._topic(topic)
    qos = self._qos(topic.qos)
    if qos is None:
      return DataReader(self._participant, topic_object)
    return DataReader(self._participant, topic_object, qos=qos)

  def _topic(self, topic: CycloneDdsTopicConfig):
    from cyclonedds.topic import Topic

    topic_type = self._typed_topic_type(topic.type_name) or self._bytes_topic_type(topic.type_name)
    return Topic(self._participant, _native_dds_topic_name(topic.topic_name), topic_type), topic_type

  @staticmethod
  def _topic_key(topic: CycloneDdsTopicConfig) -> str:
    return f"{topic.topic_name}:{topic.type_name}"

  @staticmethod
  def _qos(raw: Mapping[str, Any]):
    if not raw:
      return None
    try:
      from cyclonedds.qos import Policy, Qos
    except ImportError:
      return None

    policies = []
    reliability = str(raw.get("reliability", "")).strip().lower()
    if reliability in {"reliable", "best_effort", "besteffort"}:
      try:
        policies.append(
          Policy.Reliability.Reliable()
          if reliability == "reliable"
          else Policy.Reliability.BestEffort()
        )
      except Exception:
        pass

    durability = str(raw.get("durability", "")).strip().lower()
    if durability in {"volatile", "transient_local", "transientlocal"}:
      try:
        policies.append(
          Policy.Durability.TransientLocal()
          if durability in {"transient_local", "transientlocal"}
          else Policy.Durability.Volatile()
        )
      except Exception:
        pass

    history = str(raw.get("history", "")).strip().lower()
    depth = raw.get("depth")
    if history or depth is not None:
      try:
        if history == "keep_all":
          policies.append(Policy.History.KeepAll())
        else:
          policies.append(Policy.History.KeepLast(int(depth or 10)))
      except Exception:
        pass

    for key, factory_name in (
      ("deadline_ms", "Deadline"),
      ("lifespan_ms", "Lifespan"),
      ("liveliness_lease_duration_ms", "LeaseDuration"),
    ):
      if key not in raw:
        continue
      try:
        factory = getattr(Policy, factory_name)
        policies.append(factory(milliseconds=int(raw[key])))
      except Exception:
        pass

    if not policies:
      return None
    try:
      return Qos(*policies)
    except Exception:
      return None

  @staticmethod
  def _sample(sample_type: type, payload: bytes):
    payload_data = list(payload)
    try:
      return sample_type(payload=payload_data)
    except TypeError:
      sample = sample_type()
      sample.payload = payload_data
      return sample

  @staticmethod
  def _bytes_topic_type(type_name: str):
    cached = _BYTES_TOPIC_TYPES.get(type_name)
    if cached is not None:
      return cached

    try:
      from cyclonedds.idl.types import sequence, uint8
      from cyclonedds.idl import IdlStruct
    except ImportError as exc:
      raise RuntimeError("cyclonedds IDL support is required for byte topics") from exc

    PacificRimMessageEnvelope = dataclass(type(
      type_name,
      (IdlStruct,),
      {
        "__module__": __name__,
        "__annotations__": {"payload": sequence[uint8]},
      },
    ))
    _BYTES_TOPIC_TYPES[type_name] = PacificRimMessageEnvelope
    return PacificRimMessageEnvelope

  @staticmethod
  def _typed_topic_type(type_name: str):
    return _TYPED_DDS_TOPIC_TYPES.get(_normalize_type_name(type_name))

  async def _read_loop(
    self,
    key: str,
    reader,
  ) -> None:
    while not self._closed:
      took_any = False
      for sample in reader.take():
        took_any = True
        payload = getattr(sample, "payload", sample)
        if isinstance(payload, bytes):
          data = payload
        else:
          data = bytes(payload)
        for callback in list(self._reader_callbacks.get(key, [])):
          result = callback(data)
          if inspect.isawaitable(result):
            await result
      if not took_any:
        await asyncio.sleep(self.config.read_period_sec)


def _native_dds_topic_name(name: str) -> str:
  return "pr_" + binascii.hexlify(name.encode("utf-8")).decode("ascii")


def register_typed_dds_topic_type(type_name: str, topic_type: type) -> None:
  normalized = _normalize_type_name(type_name)
  if not normalized:
    raise ValueError("typed DDS type name is required")
  _TYPED_DDS_TOPIC_TYPES[normalized] = topic_type


def unregister_typed_dds_topic_type(type_name: str) -> None:
  _TYPED_DDS_TOPIC_TYPES.pop(_normalize_type_name(type_name), None)


def clear_typed_dds_topic_types() -> None:
  _TYPED_DDS_TOPIC_TYPES.clear()


def _normalize_type_name(type_name: str) -> str:
  return str(type_name or "").strip().replace("::", ".").replace("/", ".")
