from __future__ import annotations

from ..encodings import WireEncoding, cdr_encoding


def cdr_format(type_name: str = "", *, package: str = "", schema_path: str = "") -> WireEncoding:
  """Compatibility wrapper for older callers.

  CDR is a wire encoding, not an IDL/data-format contract. Prefer
  `pacific_rim_protocol.cdr_encoding`.
  """
  return cdr_encoding(type_name, package=package, schema_path=schema_path)
