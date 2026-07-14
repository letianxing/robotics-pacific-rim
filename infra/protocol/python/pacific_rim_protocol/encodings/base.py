from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Mapping


class WireEncodingKind(str, Enum):
  CDR = "cdr"

  def __str__(self) -> str:
    return self.value


DEFAULT_ENCODING_CONTENT_TYPES: Mapping[WireEncodingKind, str] = {
  WireEncodingKind.CDR: "application/vnd.omg.cdr",
}


@dataclass(frozen=True)
class WireEncoding:
  kind: WireEncodingKind
  type_name: str = ""
  package: str = ""
  schema_path: str = ""
  content_type: str = ""
  metadata: Mapping[str, str] = field(default_factory=dict)

  def resolved_content_type(self) -> str:
    if self.content_type:
      return self.content_type
    return DEFAULT_ENCODING_CONTENT_TYPES[self.kind]
