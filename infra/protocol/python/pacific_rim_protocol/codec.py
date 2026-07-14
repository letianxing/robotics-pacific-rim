from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Generic, Protocol, TypeVar

T = TypeVar("T")


class Codec(Protocol[T]):
  content_type: str

  def encode(self, value: T) -> bytes:
    ...

  def decode(self, data: bytes) -> T:
    ...


@dataclass(frozen=True)
class RawBytesCodec:
  content_type: str = "application/octet-stream"

  def encode(self, value: bytes | bytearray | memoryview) -> bytes:
    return bytes(value)

  def decode(self, data: bytes) -> bytes:
    return bytes(data)


@dataclass(frozen=True)
class JsonCodec:
  content_type: str = "application/json"

  def encode(self, value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

  def decode(self, data: bytes) -> Any:
    return json.loads(data.decode("utf-8"))


class ProtobufCodec(Generic[T]):
  content_type = "application/protobuf"

  def __init__(self, message_factory: Callable[[], T] | type[T]):
    self._message_factory = message_factory

  def encode(self, value: T) -> bytes:
    serializer = getattr(value, "SerializeToString", None)
    if serializer is None:
      raise TypeError("protobuf value must expose SerializeToString()")
    return bytes(serializer())

  def decode(self, data: bytes) -> T:
    message = self._message_factory()
    parser = getattr(message, "ParseFromString", None)
    if parser is None:
      raise TypeError("protobuf message must expose ParseFromString()")
    parser(data)
    return message
