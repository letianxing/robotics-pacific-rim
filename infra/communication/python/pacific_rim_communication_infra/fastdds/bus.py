from __future__ import annotations

import asyncio
import os
from dataclasses import replace
from typing import Any, Mapping

from pacific_rim_communication_infra.contracts import TransportKind
from pacific_rim_communication_infra.dds.bus import CycloneDdsMessageBus, native_domain_id_from_options
from pacific_rim_communication_infra.dds.cyclonedds import CycloneDdsConfig

from ._native import FastDdsClient


class FastDdsMessageBus(CycloneDdsMessageBus):
  kind = TransportKind.FAST_DDS

  def __init__(
    self,
    client: FastDdsClient,
    type_name: str = "PacificRimMessageEnvelope",
    publish_match_timeout_sec: float | None = None,
  ):
    super().__init__(client, type_name=type_name)
    self._publish_ready: set[str] = set()
    self._publish_ready_lock = asyncio.Lock()
    self._publish_match_timeout_sec = (
      publish_match_timeout_sec
      if publish_match_timeout_sec is not None
      else _env_float("PR_FASTDDS_MATCH_TIMEOUT_SEC", "PR_MATRIX_DISCOVERY_WAIT_SEC", default=0.5)
    )

  @classmethod
  def from_options(cls, options: Mapping[str, Any]) -> "FastDdsMessageBus":
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
    match_timeout = _first_optional_float(
      options,
      "publish_match_timeout_sec",
      "match_timeout_sec",
      "discovery_wait_sec",
    )
    return cls(
      FastDdsClient(replace(CycloneDdsConfig(), **values)),
      type_name=type_name,
      publish_match_timeout_sec=match_timeout,
    )

  async def publish_bytes(self, channel: Any, payload: bytes) -> None:
    topic = self._topic(channel)
    await self._ensure_publish_matched(topic)
    await self._client.publish(topic, payload)

  async def _ensure_publish_matched(self, topic: Any) -> None:
    key = _topic_key(topic)
    if key in self._publish_ready:
      return
    async with self._publish_ready_lock:
      if key in self._publish_ready:
        return
      await self._client.prepare_publish(topic)
      if self._publish_match_timeout_sec <= 0:
        self._publish_ready.add(key)
        return
      if await self._client.wait_for_subscribers(topic, self._publish_match_timeout_sec):
        self._publish_ready.add(key)


def _optional_float(value: Any) -> float | None:
  if value is None or value == "":
    return None
  return float(value)


def _first_optional_float(options: Mapping[str, Any], *keys: str) -> float | None:
  for key in keys:
    value = _optional_float(options.get(key))
    if value is not None:
      return value
  return None


def _env_float(*keys: str, default: float) -> float:
  for key in keys:
    value = os.environ.get(key)
    if value is None or value == "":
      continue
    try:
      return float(value)
    except ValueError:
      continue
  return default


def _topic_key(topic: Any) -> str:
  qos = getattr(topic, "qos", {}) or {}
  parts = [
    str(getattr(topic, "topic_name", "")),
    str(getattr(topic, "type_name", "")),
  ]
  for key in sorted(qos):
    parts.append(f"{key}={qos[key]}")
  return "\x1f".join(parts)
