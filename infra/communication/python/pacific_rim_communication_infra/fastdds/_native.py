from __future__ import annotations

import asyncio
import ctypes
import hashlib
import inspect
import os
import subprocess
from pathlib import Path
from typing import Any, Callable, Mapping

from pacific_rim_communication_infra.dds.cyclonedds import (
  CycloneDdsConfig,
  CycloneDdsSubscription,
  CycloneDdsTopicConfig,
)


_CALLBACK = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t)


class _FastDdsLibrary:
  def __init__(self):
    self.lib = ctypes.CDLL(str(_library_path()))
    self.lib.pr_fastdds_create.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p]
    self.lib.pr_fastdds_create.restype = ctypes.c_void_p
    self.lib.pr_fastdds_connect.argtypes = [ctypes.c_void_p]
    self.lib.pr_fastdds_connect.restype = ctypes.c_int
    self.lib.pr_fastdds_destroy.argtypes = [ctypes.c_void_p]
    self.lib.pr_fastdds_destroy.restype = None
    self.lib.pr_fastdds_last_error.argtypes = [ctypes.c_void_p]
    self.lib.pr_fastdds_last_error.restype = ctypes.c_char_p
    self.lib.pr_fastdds_prepare_publish.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
    self.lib.pr_fastdds_prepare_publish.restype = ctypes.c_int
    self.lib.pr_fastdds_publish.argtypes = [
      ctypes.c_void_p,
      ctypes.c_char_p,
      ctypes.c_char_p,
      ctypes.c_char_p,
      ctypes.POINTER(ctypes.c_uint8),
      ctypes.c_size_t,
    ]
    self.lib.pr_fastdds_publish.restype = ctypes.c_int
    self.lib.pr_fastdds_wait_for_subscribers.argtypes = [
      ctypes.c_void_p,
      ctypes.c_char_p,
      ctypes.c_char_p,
      ctypes.c_char_p,
      ctypes.c_int,
    ]
    self.lib.pr_fastdds_wait_for_subscribers.restype = ctypes.c_int
    self.lib.pr_fastdds_wait_for_publishers.argtypes = [
      ctypes.c_void_p,
      ctypes.c_char_p,
      ctypes.c_char_p,
      ctypes.c_char_p,
      ctypes.c_int,
    ]
    self.lib.pr_fastdds_wait_for_publishers.restype = ctypes.c_int
    self.lib.pr_fastdds_subscribe.argtypes = [
      ctypes.c_void_p,
      ctypes.c_char_p,
      ctypes.c_char_p,
      ctypes.c_char_p,
      _CALLBACK,
      ctypes.c_void_p,
    ]
    self.lib.pr_fastdds_subscribe.restype = ctypes.c_int
    self.lib.pr_fastdds_unsubscribe.argtypes = [ctypes.c_void_p, ctypes.c_int]
    self.lib.pr_fastdds_unsubscribe.restype = None


_LIBRARY: _FastDdsLibrary | None = None


def _load_library() -> _FastDdsLibrary:
  global _LIBRARY
  if _LIBRARY is None:
    _LIBRARY = _FastDdsLibrary()
  return _LIBRARY


class FastDdsClient:
  def __init__(self, config: CycloneDdsConfig):
    self.config = config
    self._handle: int | None = None
    self._callbacks: dict[int, Any] = {}

  async def connect(self) -> None:
    lib = _load_library().lib
    options = _encode_options({"max_payload_bytes": 1024 * 1024, **dict(self.config.qos or {})})
    handle = lib.pr_fastdds_create(
      int(self.config.domain_id),
      self.config.participant_name.encode(),
      options,
    )
    if not handle:
      raise RuntimeError("native Fast DDS create failed")
    self._handle = handle
    if lib.pr_fastdds_connect(handle) != 1:
      message = lib.pr_fastdds_last_error(handle)
      raise RuntimeError((message or b"native Fast DDS connect failed").decode(errors="replace"))

  @property
  def is_connected(self) -> bool:
    return self._handle is not None

  def supports_typed_dds(self, type_name: str) -> bool:
    _ = type_name
    return False

  async def close(self) -> None:
    if self._handle is not None:
      _load_library().lib.pr_fastdds_destroy(self._handle)
      self._handle = None
    self._callbacks.clear()

  async def prepare_publish(self, topic: CycloneDdsTopicConfig) -> None:
    self._require_ok(
      _load_library().lib.pr_fastdds_prepare_publish(
        self._require_handle(),
        topic.topic_name.encode(),
        topic.type_name.encode(),
        _encode_options(topic.qos),
      ),
      "prepare_publish",
    )

  async def publish(self, topic: CycloneDdsTopicConfig, payload: bytes) -> None:
    view = memoryview(payload).cast("B")
    owner = None
    if not view:
      buffer = None
    elif view.readonly:
      owner = ctypes.c_char_p(payload if isinstance(payload, bytes) else view.tobytes())
      buffer = ctypes.cast(owner, ctypes.POINTER(ctypes.c_uint8))
    else:
      buffer = (ctypes.c_uint8 * len(view)).from_buffer(view)
    self._require_ok(
      _load_library().lib.pr_fastdds_publish(
        self._require_handle(),
        topic.topic_name.encode(),
        topic.type_name.encode(),
        _encode_options(topic.qos),
        buffer,
        len(view),
      ),
      "publish",
    )

  async def wait_for_subscribers(self, topic: CycloneDdsTopicConfig, timeout_sec: float = 0.5) -> bool:
    timeout_ms = max(0, int(timeout_sec * 1000))
    handle = self._require_handle()
    topic_name = topic.topic_name.encode()
    type_name = topic.type_name.encode()
    qos = _encode_options(topic.qos)
    return bool(
      await asyncio.to_thread(
        _load_library().lib.pr_fastdds_wait_for_subscribers,
        handle,
        topic_name,
        type_name,
        qos,
        timeout_ms,
      )
    )

  async def wait_for_publishers(self, topic: CycloneDdsTopicConfig, timeout_sec: float = 0.5) -> bool:
    timeout_ms = max(0, int(timeout_sec * 1000))
    handle = self._require_handle()
    topic_name = topic.topic_name.encode()
    type_name = topic.type_name.encode()
    qos = _encode_options(topic.qos)
    return bool(
      await asyncio.to_thread(
        _load_library().lib.pr_fastdds_wait_for_publishers,
        handle,
        topic_name,
        type_name,
        qos,
        timeout_ms,
      )
    )

  async def subscribe(
    self,
    subscription: CycloneDdsSubscription,
    callback: Callable[[bytes], Any],
  ) -> Callable[[], None]:
    loop = asyncio.get_running_loop()

    def dispatch(payload: bytes) -> None:
      result = callback(payload)
      if inspect.isawaitable(result):
        asyncio.create_task(result)

    def on_data(_: Any, data: Any, size: int) -> None:
      payload = ctypes.string_at(data, size)
      loop.call_soon_threadsafe(dispatch, payload)

    native_callback = _CALLBACK(on_data)
    subscription_id = _load_library().lib.pr_fastdds_subscribe(
      self._require_handle(),
      subscription.topic.topic_name.encode(),
      subscription.topic.type_name.encode(),
      _encode_options(subscription.topic.qos),
      native_callback,
      None,
    )
    if subscription_id < 0:
      self._raise_last_error("subscribe")
    self._callbacks[subscription_id] = native_callback

    def unsubscribe() -> None:
      if self._handle is None:
        return
      _load_library().lib.pr_fastdds_unsubscribe(self._handle, subscription_id)
      self._callbacks.pop(subscription_id, None)

    return unsubscribe

  def _require_handle(self) -> int:
    if self._handle is None:
      raise RuntimeError("native Fast DDS is not connected")
    return self._handle

  def _require_ok(self, result: int, operation: str) -> None:
    if result != 1:
      self._raise_last_error(operation)

  def _raise_last_error(self, operation: str) -> None:
    message = _load_library().lib.pr_fastdds_last_error(self._require_handle())
    detail = (message or b"").decode(errors="replace")
    raise RuntimeError(detail or f"native Fast DDS {operation} failed")


def _encode_options(options: Mapping[str, Any] | None) -> bytes:
  lines: list[str] = []
  for key, value in dict(options or {}).items():
    if value is None:
      continue
    normalized = str(key)
    if normalized.startswith("qos."):
      normalized = normalized[4:]
    lines.append(f"{normalized}={value}")
  return ("\n".join(lines)).encode()


def _library_path() -> Path:
  explicit = os.environ.get("PR_FASTDDS_NATIVE_LIB")
  if explicit:
    return Path(explicit)
  root = _repo_root()
  source = Path(__file__).with_name("_native_shim.cpp")
  header = root / "infra/communication/cpp/dds/fastdds_native_byte_client.hpp"
  key = hashlib.sha256(
    source.read_bytes() + header.read_bytes() + str(root).encode()
  ).hexdigest()[:16]
  cache_dir = Path(os.environ.get("PR_FASTDDS_NATIVE_CACHE", "/tmp/pacific-rim-fastdds"))
  cache_dir.mkdir(parents=True, exist_ok=True)
  library = cache_dir / f"libpr_fastdds_python_{key}.so"
  if library.exists():
    return library
  include_flags = [
    f"-I{root}",
    f"-I{root / 'infra/communication/cpp/include'}",
    "-I/opt/ros/humble/include",
    "-I/opt/ros/humble/include/fastrtps",
    "-I/opt/ros/humble/include/fastcdr",
  ]
  cmd = [
    "c++",
    "-std=c++17",
    "-shared",
    "-fPIC",
    *include_flags,
    str(source),
    "-L/opt/ros/humble/lib",
    "-lfastcdr",
    "-lfastrtps",
    "-Wl,-rpath,/opt/ros/humble/lib",
    "-pthread",
    "-o",
    str(library),
  ]
  result = subprocess.run(cmd, text=True, capture_output=True)
  if result.returncode != 0:
    raise RuntimeError(
      "failed to build native Fast DDS Python shim; install Fast DDS C++ headers/libs "
      "or set PR_FASTDDS_NATIVE_LIB\n" + result.stderr
    )
  return library


def _repo_root() -> Path:
  current = Path(__file__).resolve()
  for parent in current.parents:
    if (parent / "infra/communication/cpp/dds/fastdds_native_byte_client.hpp").exists():
      return parent
  raise RuntimeError("cannot locate pacific-rim repo root for native Fast DDS shim build")
