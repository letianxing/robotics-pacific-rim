from __future__ import annotations

from dataclasses import replace
from typing import Any, Mapping

from pacific_rim_communication_infra.contracts import TransportKind
from pacific_rim_communication_infra.core import (
  BytesHandler,
  ChannelLike,
  MiddlewareCapabilities,
  RequestHandler,
  channel_name,
  channel_queue_group,
)

from .client import NatsClient, NatsConfig, NatsSubscription


class NatsMessageBus:
  kind = TransportKind.NATS
  capabilities = MiddlewareCapabilities(publish_subscribe=True, request_reply=True)

  def __init__(self, client: NatsClient):
    self._client = client

  @classmethod
  def from_options(cls, options: Mapping[str, Any]) -> "NatsMessageBus":
    config = NatsConfig()
    field_aliases = {
      "url": "server_url",
      "server": "server_url",
      "server_url": "server_url",
      "name": "name",
      "connect_timeout_sec": "connect_timeout_sec",
      "reconnect_wait_sec": "reconnect_wait_sec",
      "max_reconnect_attempts": "max_reconnect_attempts",
    }
    values: dict[str, Any] = {}
    for key, value in options.items():
      if key == "connect_timeout_ms":
        values["connect_timeout_sec"] = float(value) / 1000.0
        continue
      if key == "reconnect_wait_ms":
        values["reconnect_wait_sec"] = float(value) / 1000.0
        continue
      field_name = field_aliases.get(str(key))
      if field_name is not None:
        values[field_name] = value
    return cls(NatsClient(replace(config, **values)))

  async def connect(self) -> None:
    await self._client.connect()

  async def close(self) -> None:
    await self._client.drain()

  async def publish_bytes(self, channel: ChannelLike, payload: bytes) -> None:
    await self._client.publish(channel_name(channel), payload)

  async def subscribe_bytes(self, channel: ChannelLike, handler: BytesHandler) -> None:
    await self._client.subscribe(
      NatsSubscription(
        subject=channel_name(channel),
        queue_group=channel_queue_group(channel),
      ),
      handler,
    )

  async def request_bytes(
    self,
    channel: ChannelLike,
    payload: bytes,
    timeout_sec: float = 2.0,
  ) -> bytes:
    return await self._client.request(channel_name(channel), payload, timeout_sec=timeout_sec)

  async def handle_request_bytes(
    self,
    channel: ChannelLike,
    handler: RequestHandler,
  ) -> None:
    await self._client.handle_request(
      NatsSubscription(
        subject=channel_name(channel),
        queue_group=channel_queue_group(channel),
      ),
      handler,
    )
