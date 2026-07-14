from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Mapping


class DataFormatKind(str, Enum):
  RAW_BYTES = "raw_bytes"
  JSON = "json"
  PROTOBUF = "protobuf"
  ROS2_MSG = "ros2_msg"
  ROS2_SRV = "ros2_srv"
  ROS2_IDL = "ros2_idl"
  ROS2_TYPE_SUPPORT = "ros2_type_support"

  def __str__(self) -> str:
    return self.value


DEFAULT_CONTENT_TYPES: Mapping[DataFormatKind, str] = {
  DataFormatKind.RAW_BYTES: "application/octet-stream",
  DataFormatKind.JSON: "application/json",
  DataFormatKind.PROTOBUF: "application/protobuf",
  DataFormatKind.ROS2_MSG: "application/vnd.ros2.msg",
  DataFormatKind.ROS2_SRV: "application/vnd.ros2.srv",
  DataFormatKind.ROS2_IDL: "application/vnd.ros2.idl",
  DataFormatKind.ROS2_TYPE_SUPPORT: "application/vnd.ros2.type-support",
}


@dataclass(frozen=True)
class DataFormat:
  kind: DataFormatKind
  type_name: str = ""
  package: str = ""
  schema_path: str = ""
  content_type: str = ""
  metadata: Mapping[str, str] = field(default_factory=dict)

  def resolved_content_type(self) -> str:
    if self.content_type:
      return self.content_type
    return DEFAULT_CONTENT_TYPES[self.kind]
