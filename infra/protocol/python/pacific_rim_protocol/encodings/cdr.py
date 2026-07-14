from __future__ import annotations

from .base import WireEncoding, WireEncodingKind


def cdr_encoding(type_name: str = "", *, package: str = "", schema_path: str = "") -> WireEncoding:
  return WireEncoding(
    kind=WireEncodingKind.CDR,
    type_name=type_name,
    package=package,
    schema_path=schema_path,
  )
