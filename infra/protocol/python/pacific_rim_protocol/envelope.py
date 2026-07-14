from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any, Mapping


@dataclass(frozen=True)
class CommunicationMessage:
  message_type: str
  payload: Mapping[str, Any]
  metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MessageEnvelope:
  source: str
  message: CommunicationMessage
  trace_id: str = ""
  payload_sha256: str = ""
  published_at_unix_ms: int = 0


class MessageEnvelopeJsonCodec:
  def __init__(self, source: str):
    self.source = source

  def encode(self, message_type: str, payload: Mapping[str, Any]) -> bytes:
    digest = self.compute_digest(message_type, payload)
    envelope = MessageEnvelope(
      source=self.source,
      message=CommunicationMessage(message_type=message_type, payload=dict(payload)),
      payload_sha256=digest,
      published_at_unix_ms=int(time.time() * 1000),
    )
    return self.encode_envelope(envelope)

  def encode_envelope(self, envelope: MessageEnvelope) -> bytes:
    return json.dumps(
      {
        "source": envelope.source,
        "message": {
          "message_type": envelope.message.message_type,
          "payload": dict(envelope.message.payload),
          "metadata": dict(envelope.message.metadata),
        },
        "trace_id": envelope.trace_id,
        "payload_sha256": envelope.payload_sha256,
        "published_at_unix_ms": envelope.published_at_unix_ms,
      },
      sort_keys=True,
      separators=(",", ":"),
      ensure_ascii=False,
    ).encode("utf-8")

  def decode(self, data: bytes) -> MessageEnvelope:
    raw = json.loads(data.decode("utf-8"))
    if not isinstance(raw, dict):
      raise ValueError("communication envelope must be a JSON object")
    return self._decode_mapping(raw)

  def _decode_mapping(self, raw: Mapping[str, Any]) -> MessageEnvelope:
    message = raw.get("message", {})
    if not isinstance(message, dict):
      raise ValueError("communication envelope message must be a JSON object")

    payload = message.get("payload", {})
    if not isinstance(payload, dict):
      raise ValueError("communication envelope payload must be a JSON object")

    return MessageEnvelope(
      source=str(raw.get("source", "")).strip(),
      message=CommunicationMessage(
        message_type=str(message.get("message_type", "")).strip(),
        payload=payload,
        metadata=dict(message.get("metadata", {}) or {}),
      ),
      trace_id=str(raw.get("trace_id", "")).strip(),
      payload_sha256=str(raw.get("payload_sha256", "")).strip(),
      published_at_unix_ms=int(raw.get("published_at_unix_ms", 0) or 0),
    )

  @staticmethod
  def compute_digest(message_type: str, payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(
      {"message_type": message_type, "payload": dict(payload)},
      sort_keys=True,
      separators=(",", ":"),
      ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class DdsEnvelopeCodec(MessageEnvelopeJsonCodec):
  pass


class BridgeEnvelopeCodec(MessageEnvelopeJsonCodec):
  def decode(self, data: bytes) -> MessageEnvelope:
    raw = json.loads(data.decode("utf-8"))
    if not isinstance(raw, dict):
      raise ValueError("communication envelope must be a JSON object")

    if "payload" not in raw or "message_type" not in raw:
      return self._decode_mapping(raw)

    payload = raw.get("payload", {})
    if not isinstance(payload, dict):
      raise ValueError("legacy communication envelope payload must be a JSON object")

    return MessageEnvelope(
      source=str(raw.get("source") or raw.get("bridge_id", "")).strip(),
      message=CommunicationMessage(
        message_type=str(raw.get("message_type", "")).strip(),
        payload=payload,
        metadata={
          key: value
          for key, value in {
            "rule_name": raw.get("rule_name"),
            "ros_topic": raw.get("ros_topic"),
          }.items()
          if value is not None
        },
      ),
      trace_id=str(raw.get("trace_id", "")).strip(),
      payload_sha256=str(raw.get("payload_sha256", "")).strip(),
      published_at_unix_ms=int(raw.get("published_at_unix_ms", 0) or 0),
    )
