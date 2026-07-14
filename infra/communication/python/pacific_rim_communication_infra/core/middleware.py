from __future__ import annotations

import inspect
import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Protocol, TypeVar

from pacific_rim_communication_infra.contracts import MiddlewareConfig, RpcRoute, TransportKind
from pacific_rim_protocol import Codec, RawBytesCodec

T = TypeVar("T")
R = TypeVar("R")
BytesHandler = Callable[[bytes], Awaitable[None] | None]
RequestHandler = Callable[[bytes], Awaitable[bytes] | bytes]
TypedHandler = Callable[[Any], Awaitable[None] | None]


@dataclass(frozen=True)
class Channel:
  name: str
  queue_group: str = ""
  message_type: str = ""
  metadata: Mapping[str, Any] = field(default_factory=dict)


ChannelLike = str | Channel


@dataclass(frozen=True)
class MiddlewareCapabilities:
  publish_subscribe: bool = True
  request_reply: bool = False


class MessageBus(Protocol):
  @property
  def kind(self) -> TransportKind:
    ...

  @property
  def capabilities(self) -> MiddlewareCapabilities:
    ...

  async def connect(self) -> None:
    ...

  async def close(self) -> None:
    ...

  async def publish_bytes(self, channel: ChannelLike, payload: bytes) -> None:
    ...

  async def subscribe_bytes(self, channel: ChannelLike, handler: BytesHandler) -> None:
    ...

  async def request_bytes(
    self,
    channel: ChannelLike,
    payload: bytes,
    timeout_sec: float = 2.0,
  ) -> bytes:
    ...

  async def handle_request_bytes(
    self,
    channel: ChannelLike,
    handler: RequestHandler,
  ) -> None:
    ...


class TypedMessageBus:
  def __init__(self, bus: MessageBus):
    self._bus = bus

  @property
  def raw(self) -> MessageBus:
    return self._bus

  async def connect(self) -> None:
    await self._bus.connect()

  async def close(self) -> None:
    await self._bus.close()

  async def publish(
    self,
    channel: ChannelLike,
    value: T,
    codec: Codec[T] | None = None,
  ) -> None:
    codec = codec or RawBytesCodec()
    await self._bus.publish_bytes(channel, codec.encode(value))

  async def subscribe(
    self,
    channel: ChannelLike,
    handler: TypedHandler,
    codec: Codec[Any] | None = None,
  ) -> None:
    codec = codec or RawBytesCodec()

    async def wrapped(data: bytes) -> None:
      decoded = codec.decode(data)
      result = handler(decoded)
      if inspect.isawaitable(result):
        await result

    await self._bus.subscribe_bytes(channel, wrapped)

  async def request(
    self,
    channel: ChannelLike,
    value: T,
    request_codec: Codec[T] | None = None,
    response_codec: Codec[R] | None = None,
    timeout_sec: float = 2.0,
  ) -> R:
    request_codec = request_codec or RawBytesCodec()
    response_codec = response_codec or RawBytesCodec()
    response = await self._bus.request_bytes(
      channel,
      request_codec.encode(value),
      timeout_sec=timeout_sec,
    )
    return response_codec.decode(response)


class FanoutMessageBus:
  def __init__(self, buses: list[MessageBus], primary_index: int = 0):
    if not buses:
      raise ValueError("FanoutMessageBus requires at least one bus")
    if primary_index < 0 or primary_index >= len(buses):
      raise ValueError("primary_index is out of range")
    self._buses = list(buses)
    self._primary_index = primary_index

  @property
  def kind(self) -> TransportKind:
    return TransportKind.IN_PROCESS

  @property
  def capabilities(self) -> MiddlewareCapabilities:
    return MiddlewareCapabilities(
      publish_subscribe=any(bus.capabilities.publish_subscribe for bus in self._buses),
      request_reply=self._buses[self._primary_index].capabilities.request_reply,
    )

  async def connect(self) -> None:
    await asyncio.gather(*(bus.connect() for bus in self._buses))

  async def close(self) -> None:
    await asyncio.gather(*(bus.close() for bus in self._buses))

  async def publish_bytes(self, channel: ChannelLike, payload: bytes) -> None:
    await asyncio.gather(*(bus.publish_bytes(channel, payload) for bus in self._buses))

  async def subscribe_bytes(self, channel: ChannelLike, handler: BytesHandler) -> None:
    await asyncio.gather(*(bus.subscribe_bytes(channel, handler) for bus in self._buses))

  async def request_bytes(
    self,
    channel: ChannelLike,
    payload: bytes,
    timeout_sec: float = 2.0,
  ) -> bytes:
    return await self._buses[self._primary_index].request_bytes(
      channel,
      payload,
      timeout_sec=timeout_sec,
    )

  async def handle_request_bytes(
    self,
    channel: ChannelLike,
    handler: RequestHandler,
  ) -> None:
    await self._buses[self._primary_index].handle_request_bytes(channel, handler)


def channel_name(channel: ChannelLike) -> str:
  return channel.name if isinstance(channel, Channel) else str(channel)


def channel_queue_group(channel: ChannelLike) -> str:
  return channel.queue_group if isinstance(channel, Channel) else ""


def channel_from_endpoint(
  address: str,
  message_type: str = "",
  queue_group: str = "",
  metadata: Mapping[str, Any] | None = None,
) -> Channel:
  return Channel(
    name=address,
    message_type=message_type,
    queue_group=queue_group,
    metadata=dict(metadata or {}),
  )


def request_channel_from_route(route: RpcRoute) -> Channel:
  return channel_from_endpoint(
    route.server.address,
    message_type=route.server.message_type,
    queue_group=str(route.server.metadata.get("queue_group", "")),
    metadata=route.server.metadata,
  )


def normalize_transport_kind(kind: TransportKind | str) -> TransportKind:
  if isinstance(kind, TransportKind):
    return kind

  normalized = str(kind).strip().lower().replace("-", "_")
  aliases = {
    "dds": TransportKind.CYCLONE_DDS,
    "cyclone_dds": TransportKind.CYCLONE_DDS,
    "cyclonedds": TransportKind.CYCLONE_DDS,
    "fastdds": TransportKind.FAST_DDS,
    "fast_dds": TransportKind.FAST_DDS,
    "fastrtps": TransportKind.FAST_DDS,
    "fast_rtps": TransportKind.FAST_DDS,
    "fastdds_topic": TransportKind.FAST_DDS,
    "fastdds_rpc": TransportKind.FAST_DDS,
    "nats": TransportKind.NATS,
    "ros2": TransportKind.ROS2,
    "mqtt": TransportKind.MQTT,
    "zenoh": TransportKind.ZENOH,
    "grpc": TransportKind.GRPC,
    "in_process": TransportKind.IN_PROCESS,
  }
  if normalized in aliases:
    return aliases[normalized]
  raise ValueError(f"unsupported communication middleware: {kind}")


def create_message_bus(
  kind: TransportKind | str,
  options: Mapping[str, Any] | None = None,
) -> MessageBus:
  normalized = normalize_transport_kind(kind)
  bus_options = dict(options or {})
  if normalized == TransportKind.NATS:
    from pacific_rim_communication_infra.nats.bus import NatsMessageBus

    return NatsMessageBus.from_options(bus_options)
  if normalized == TransportKind.CYCLONE_DDS:
    from pacific_rim_communication_infra.dds.bus import CycloneDdsMessageBus

    return CycloneDdsMessageBus.from_options(bus_options)
  if normalized == TransportKind.FAST_DDS:
    from pacific_rim_communication_infra.fastdds.bus import FastDdsMessageBus

    return FastDdsMessageBus.from_options(bus_options)
  if normalized == TransportKind.ROS2:
    from pacific_rim_communication_infra.ros2.envelope_bus import Ros2ProtoEnvelopeBus

    return Ros2ProtoEnvelopeBus.from_options(bus_options)
  raise ValueError(f"middleware {normalized.value} is not implemented in infra/communication")


def create_message_bus_from_config(config: MiddlewareConfig) -> MessageBus:
  options = dict(config.options)
  if config.name and "name" not in options:
    options["name"] = config.name
  return create_message_bus(config.transport, options)


def create_typed_message_bus(
  kind: TransportKind | str,
  options: Mapping[str, Any] | None = None,
) -> TypedMessageBus:
  return TypedMessageBus(create_message_bus(kind, options))
