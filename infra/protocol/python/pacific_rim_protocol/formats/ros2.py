from __future__ import annotations

from .base import DataFormat, DataFormatKind


def ros2_msg_format(type_name: str, *, package: str = "", schema_path: str = "") -> DataFormat:
  return DataFormat(
    kind=DataFormatKind.ROS2_MSG,
    type_name=type_name,
    package=package,
    schema_path=schema_path,
  )


def ros2_srv_format(type_name: str, *, package: str = "", schema_path: str = "") -> DataFormat:
  return DataFormat(
    kind=DataFormatKind.ROS2_SRV,
    type_name=type_name,
    package=package,
    schema_path=schema_path,
  )


def ros2_idl_format(type_name: str, *, package: str = "", schema_path: str = "") -> DataFormat:
  return DataFormat(
    kind=DataFormatKind.ROS2_IDL,
    type_name=type_name,
    package=package,
    schema_path=schema_path,
  )


def ros2_type_support_format(type_name: str, *, package: str = "", schema_path: str = "") -> DataFormat:
  return DataFormat(
    kind=DataFormatKind.ROS2_TYPE_SUPPORT,
    type_name=type_name,
    package=package,
    schema_path=schema_path,
  )
