from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping

from pacific_rim_communication_infra.core import ChannelLike, channel_name


@dataclass(frozen=True)
class TypedMapper:
  proto_to_ros2: Callable[[ChannelLike, bytes], Any]
  ros2_to_proto: Callable[[ChannelLike, Any], bytes]


_mappers: dict[str, TypedMapper] = {}


def register_typed_mapper(schema_type: str, ros2_type: str, mapper: TypedMapper) -> None:
  key = _mapper_key(schema_type, ros2_type)
  if key:
    _mappers[key] = mapper


def proto_to_ros2(channel: ChannelLike, payload: bytes) -> Any:
  return _mapper_for(channel).proto_to_ros2(channel, payload)


def ros2_to_proto(channel: ChannelLike, message: Any) -> bytes:
  return _mapper_for(channel).ros2_to_proto(channel, message)


def adapter(channel: ChannelLike) -> str:
  metadata = _metadata(channel)
  return str(metadata.get("adapter") or metadata.get("ros2.adapter") or "").strip().lower().replace("-", "_")


def ros2_message_type(channel: ChannelLike) -> str:
  metadata = _metadata(channel)
  return str(
    metadata.get("ros_message_type")
    or metadata.get("ros2.message_type")
    or getattr(channel, "message_type", "")
    or ""
  ).strip()


def ros2_service_type(channel: ChannelLike) -> str:
  metadata = _metadata(channel)
  return str(
    metadata.get("ros_service_type")
    or metadata.get("ros2.service_type")
    or getattr(channel, "message_type", "")
    or ""
  ).strip()


def _mapper_for(channel: ChannelLike) -> TypedMapper:
  key = _channel_mapper_key(channel)
  mapper = _mappers.get(key)
  if mapper is None:
    raise RuntimeError(
      "ROS2 typed mapper is not registered for "
      f"{key}; register a mapper or use adapter: ros2_proto_envelope"
    )
  return mapper


def _channel_mapper_key(channel: ChannelLike) -> str:
  metadata = _metadata(channel)
  schema_type = str(
    metadata.get("schema.type")
    or metadata.get("protobuf.type")
    or getattr(channel, "message_type", "")
    or ""
  ).strip()
  ros2_type = str(
    metadata.get("ros_message_type")
    or metadata.get("ros_service_type")
    or metadata.get("ros2.message_type")
    or metadata.get("ros2.service_type")
    or getattr(channel, "message_type", "")
    or ""
  ).strip()
  return _mapper_key(schema_type, ros2_type)


def _mapper_key(schema_type: str, ros2_type: str) -> str:
  schema_type = str(schema_type or "").strip()
  ros2_type = str(ros2_type or "").strip()
  if not schema_type and not ros2_type:
    return ""
  return f"{schema_type}=>{ros2_type}"


def _metadata(channel: ChannelLike) -> Mapping[str, Any]:
  return getattr(channel, "metadata", {}) or {}
