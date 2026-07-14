from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping


class TransportKind(str, Enum):
  IN_PROCESS = "in_process"
  ROS2 = "ros2"
  NATS = "nats"
  CYCLONE_DDS = "cyclonedds"
  FAST_DDS = "fastdds"
  ZENOH = "zenoh"
  GRPC = "grpc"
  MQTT = "mqtt"

  def __str__(self) -> str:
    return self.value


class BridgeDirection(str, Enum):
  SOURCE_TO_TARGET = "source_to_target"
  TARGET_TO_SOURCE = "target_to_source"
  BIDIRECTIONAL = "bidirectional"

  def __str__(self) -> str:
    return self.value


@dataclass(frozen=True)
class MiddlewareConfig:
  transport: TransportKind
  name: str = ""
  options: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Endpoint:
  transport: TransportKind
  address: str
  message_type: str = ""
  metadata: Mapping[str, Any] = field(default_factory=dict)


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


@dataclass(frozen=True)
class PubSubRoute:
  name: str
  publisher: Endpoint
  subscriber: Endpoint
  queue_size: int = 10
  enabled: bool = True


@dataclass(frozen=True)
class RpcRoute:
  name: str
  client: Endpoint
  server: Endpoint
  timeout_ms: int = 2000
  enabled: bool = True


@dataclass(frozen=True)
class BridgeRule:
  name: str
  source: Endpoint
  target: Endpoint
  direction: BridgeDirection = BridgeDirection.SOURCE_TO_TARGET
  queue_size: int = 10
  queue_group: str = ""
  enabled: bool = True
