from __future__ import annotations

from .base import DataFormat, DataFormatKind


def protobuf_format(type_name: str, *, package: str = "", schema_path: str = "") -> DataFormat:
  return DataFormat(
    kind=DataFormatKind.PROTOBUF,
    type_name=type_name,
    package=package,
    schema_path=schema_path,
  )
