#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import importlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(os.environ.get("PR_TYPED_DDS_ROOT", "/workspace"))
OUT_DIR = ROOT / "out/test-report"
WORK_ROOT = ROOT / "infra/out/dds_typed_runtime"


IDL_SOURCE = """\
module demo {
  struct RobotState {
    sequence<octet, 256> payload;
  };
};
"""


async def _run_runtime_smoke(work: Path) -> dict[str, object]:
  sys.path.insert(0, str(ROOT / "infra/otel/python"))
  sys.path.insert(0, str(ROOT / "infra/metric/python"))
  sys.path.insert(0, str(ROOT / "infra/trace/python"))
  sys.path.insert(0, str(ROOT / "infra/protocol/python"))
  sys.path.insert(0, str(ROOT / "infra/communication/python"))
  sys.path.insert(0, str(work / "generated"))
  sys.path.insert(0, str(work))

  from pacific_rim_communication_infra.core.middleware import Channel
  from pacific_rim_communication_infra.dds import (
    CycloneDdsMessageBus,
    clear_typed_dds_topic_types,
    register_typed_dds_topic_type,
  )

  generated = importlib.import_module("demo")
  robot_state_type = generated.RobotState
  type_name = "demo.RobotState"
  clear_typed_dds_topic_types()
  register_typed_dds_topic_type(type_name, robot_state_type)

  domain_id = int(os.environ.get("PR_TYPED_DDS_DOMAIN_ID", str(180 + (os.getpid() % 40))))
  topic_name = f"typed.dds.robot_state.{os.getpid()}.{time.time_ns()}"
  metadata = {
    "schema.language": "omg_idl",
    "schema.format": "dds_idl",
    "schema.type": type_name,
    "dds.type": type_name,
    "dds.mode": "typed_preferred",
    "qos.reliability": "reliable",
    "qos.history": "keep_last",
    "qos.depth": "32",
  }
  channel = Channel(topic_name, message_type=type_name, metadata=metadata)
  subscriber = CycloneDdsMessageBus.from_options(
    {
      "domain_id": domain_id,
      "qos.reliability": "reliable",
      "qos.history": "keep_last",
      "qos.depth": 32,
    }
  )
  publisher = CycloneDdsMessageBus.from_options(
    {
      "domain_id": domain_id,
      "qos.reliability": "reliable",
      "qos.history": "keep_last",
      "qos.depth": 32,
    }
  )
  received: asyncio.Queue[bytes] = asyncio.Queue()
  try:
    await subscriber.connect()
    await publisher.connect()
    selected_topic = subscriber._topic(channel)
    await subscriber.subscribe_bytes(channel, lambda payload: received.put_nowait(bytes(payload)))
    payload = b"typed-dds-idl-runtime-ok"
    for _ in range(120):
      await publisher.publish_bytes(channel, payload)
      try:
        got = await asyncio.wait_for(received.get(), timeout=0.05)
      except asyncio.TimeoutError:
        continue
      if got == payload:
        return {
          "ok": True,
          "domain_id": domain_id,
          "topic": topic_name,
          "type_name": selected_topic.type_name,
          "generated_class": f"{robot_state_type.__module__}.{robot_state_type.__name__}",
          "payload": payload.decode("ascii"),
          "runtime": "cyclonedds_typed_python_idl",
        }
      return {
        "ok": False,
        "error": f"payload mismatch: {got!r}",
        "type_name": selected_topic.type_name,
      }
    return {
      "ok": False,
      "error": "timed out waiting for typed DDS IDL payload",
      "type_name": selected_topic.type_name,
    }
  finally:
    await publisher.close()
    await subscriber.close()
    clear_typed_dds_topic_types()


def _run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
  return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)


def main() -> int:
  WORK_ROOT.mkdir(parents=True, exist_ok=True)
  OUT_DIR.mkdir(parents=True, exist_ok=True)
  work = Path(tempfile.mkdtemp(prefix="run_", dir=WORK_ROOT))
  idl = work / "RobotState.idl"
  generated = work / "generated"
  generated.mkdir()
  idl.write_text(IDL_SOURCE)
  idlc = shutil.which("idlc")
  if not idlc:
    raise RuntimeError("idlc is required for typed DDS IDL runtime smoke")
  result = _run([idlc, "-l", "py", "-o", str(generated), str(idl)], cwd=work)
  if result.returncode != 0:
    raise RuntimeError("idlc Python generation failed\n" + result.stdout + result.stderr)
  report = asyncio.run(_run_runtime_smoke(work))
  report_path = OUT_DIR / "dds-idl-typed-runtime.json"
  report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
  print(json.dumps(report, ensure_ascii=False, indent=2))
  return 0 if report.get("ok") is True else 1


if __name__ == "__main__":
  raise SystemExit(main())
