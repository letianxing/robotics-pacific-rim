from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Awaitable, Callable


@dataclass(frozen=True)
class NatsConfig:
  server_url: str = "nats://127.0.0.1:4222"
  name: str = "pacific-rim"
  connect_timeout_sec: float = 2.0
  reconnect_wait_sec: float = 2.0
  max_reconnect_attempts: int = -1


@dataclass(frozen=True)
class NatsSubscription:
  subject: str
  queue_group: str = ""


class NatsClient:
  def __init__(self, config: NatsConfig):
    self.config = config
    self._client = None

  async def connect(self) -> None:
    try:
      from nats.aio.client import Client as NATS
    except ImportError as exc:
      raise RuntimeError("nats-py is required for NatsClient") from exc

    self._client = NATS()
    await self._client.connect(
      servers=[self.config.server_url],
      name=self.config.name,
      connect_timeout=self.config.connect_timeout_sec,
      reconnect_time_wait=self.config.reconnect_wait_sec,
      max_reconnect_attempts=self.config.max_reconnect_attempts,
      allow_reconnect=True,
    )

  @property
  def is_connected(self) -> bool:
    return bool(self._client is not None and self._client.is_connected)

  async def publish(self, subject: str, payload: bytes) -> None:
    if not self.is_connected:
      raise RuntimeError("NATS is not connected")
    await self._client.publish(subject, payload)

  async def subscribe(
    self,
    subscription: NatsSubscription,
    callback: Callable[[bytes], Awaitable[None] | None],
  ) -> None:
    if not self.is_connected:
      raise RuntimeError("NATS is not connected")

    async def wrapped(message):
      result = callback(message.data)
      if inspect.isawaitable(result):
        await result

    await self._client.subscribe(
      subscription.subject,
      queue=subscription.queue_group or None,
      cb=wrapped,
    )

  async def handle_request(
    self,
    subscription: NatsSubscription,
    callback: Callable[[bytes], Awaitable[bytes] | bytes],
  ) -> None:
    if not self.is_connected:
      raise RuntimeError("NATS is not connected")

    async def wrapped(message):
      result = callback(message.data)
      if inspect.isawaitable(result):
        result = await result
      if message.reply:
        await self._client.publish(message.reply, result or b"")

    await self._client.subscribe(
      subscription.subject,
      queue=subscription.queue_group or None,
      cb=wrapped,
    )

  async def request(self, subject: str, payload: bytes, timeout_sec: float = 2.0) -> bytes:
    if not self.is_connected:
      raise RuntimeError("NATS is not connected")
    response = await self._client.request(subject, payload, timeout=timeout_sec)
    return response.data

  async def drain(self) -> None:
    if self._client is not None and not self._client.is_closed:
      await self._client.drain()
