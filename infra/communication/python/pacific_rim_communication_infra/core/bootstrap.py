from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Coroutine

from .config import load_communication_config_file
from .routing import CommunicationFabric


@dataclass
class CommunicationRuntime:
  """Connected communication fabric owned by a service process."""

  fabric: CommunicationFabric
  config_path: Path
  observability: Any = None

  async def close(self) -> None:
    await self.fabric.close_all()
    if self.observability is not None:
      self.observability.shutdown()
      self.observability = None

  def publisher(self, route_name: str):
    return self.fabric.publisher(route_name)

  def subscriber(self, route_name: str):
    return self.fabric.subscriber(route_name)

  def rpc_client(self, route_name: str):
    return self.fabric.rpc_client(route_name)

  def rpc_server(self, route_name: str):
    return self.fabric.rpc_server(route_name)


async def bootstrap_communication(config_path: str | Path) -> CommunicationRuntime:
  """Load a service config file, create its fabric, and connect all middleware."""

  resolved_path = Path(config_path)
  config = load_communication_config_file(resolved_path)
  observability = _init_observability(config.trace_service_name)
  fabric = config.create_fabric()
  try:
    await fabric.connect_all()
  except Exception:
    if observability is not None:
      observability.shutdown()
    raise
  return CommunicationRuntime(
    fabric=fabric,
    config_path=resolved_path,
    observability=observability,
  )


def _init_observability(service_name: str) -> Any:
  try:
    from pacific_rim_otel import init_observability
  except (ImportError, ModuleNotFoundError):
    return None
  return init_observability(service_name)


class CommunicationRuntimeThread:
  """Owns an asyncio loop for services whose main runtime is synchronous."""

  def __init__(self, config_path: str | Path):
    self.config_path = Path(config_path)
    self.runtime: CommunicationRuntime | None = None
    self._loop: asyncio.AbstractEventLoop | None = None
    self._thread: threading.Thread | None = None

  def start(self) -> CommunicationRuntime:
    if self.runtime is not None:
      return self.runtime

    self._loop = asyncio.new_event_loop()
    self._thread = threading.Thread(
      target=self._run_loop,
      name=f"communication:{self.config_path}",
      daemon=True,
    )
    self._thread.start()
    try:
      self.runtime = self.run(bootstrap_communication(self.config_path))
    except Exception:
      self._stop_loop()
      raise
    return self.runtime

  def stop(self) -> None:
    if self.runtime is not None:
      self.run(self.runtime.close())
      self.runtime = None
    self._stop_loop()

  def run(self, coroutine: Coroutine[Any, Any, Any]) -> Any:
    if self._loop is None:
      raise RuntimeError("communication runtime thread is not started")
    return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result()

  def _run_loop(self) -> None:
    if self._loop is None:
      return
    asyncio.set_event_loop(self._loop)
    self._loop.run_forever()
    self._loop.close()

  def _stop_loop(self) -> None:
    if self._loop is not None:
      self._loop.call_soon_threadsafe(self._loop.stop)
    if self._thread is not None:
      self._thread.join(timeout=5.0)
    self._loop = None
    self._thread = None
