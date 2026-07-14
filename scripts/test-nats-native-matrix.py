#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import os
import platform
import re
import selectors
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(os.environ.get("PR_MATRIX_ROOT", str(Path(__file__).resolve().parents[1]))).resolve()
OUT_DIR = ROOT / "out/test-report"
WORK_ROOT = ROOT / "infra/out/nats_native_matrix"
WORK_ROOT.mkdir(parents=True, exist_ok=True)
WORK = Path(tempfile.mkdtemp(prefix="run_", dir=WORK_ROOT))

NATS_URL = os.environ.get("PR_NATS_URL", "nats://127.0.0.1:4222")
COUNT = int(os.environ.get("PR_NATS_MATRIX_COUNT", os.environ.get("PR_MATRIX_COUNT", "80")))
RPC_COUNT = int(os.environ.get("PR_NATS_MATRIX_RPC_COUNT", os.environ.get("PR_MATRIX_RPC_COUNT", "40")))
PUB_INTERVAL_SEC = float(os.environ.get("PR_NATS_MATRIX_PUB_INTERVAL_SEC", os.environ.get("PR_MATRIX_PUB_INTERVAL_SEC", "0.003")))
LANGUAGES = tuple(
  item.strip()
  for item in os.environ.get("PR_NATS_MATRIX_LANGUAGES", os.environ.get("PR_MATRIX_LANGUAGES", "cpp,python,go")).split(",")
  if item.strip()
)
PUBSUB_DATA_KINDS = tuple(
  item.strip()
  for item in os.environ.get("PR_NATS_MATRIX_PUBSUB_DATA", "proto,msg,dds_idl,omg_idl").split(",")
  if item.strip()
)
RPC_DATA_KINDS = tuple(
  item.strip()
  for item in os.environ.get("PR_NATS_MATRIX_RPC_DATA", "proto,srv,dds_idl,omg_idl").split(",")
  if item.strip()
)
CROSS_LANGUAGE = os.environ.get("PR_NATS_MATRIX_CROSS_LANG", "1").strip().lower() not in {"0", "false", "no"}
GO_VERSION = os.environ.get("PR_MATRIX_GO_VERSION", "1.25.5")
PUBSUB_MAX_P95_MS = float(os.environ.get("PR_NATS_MATRIX_PUBSUB_MAX_P95_MS", os.environ.get("PR_MATRIX_PUBSUB_MAX_P95_MS", "250")))
PUBSUB_MAX_P99_MS = float(os.environ.get("PR_NATS_MATRIX_PUBSUB_MAX_P99_MS", os.environ.get("PR_MATRIX_PUBSUB_MAX_P99_MS", "500")))
PUBSUB_MIN_THROUGHPUT = float(os.environ.get("PR_NATS_MATRIX_PUBSUB_MIN_THROUGHPUT", os.environ.get("PR_MATRIX_PUBSUB_MIN_THROUGHPUT", "20")))
RPC_MAX_P95_MS = float(os.environ.get("PR_NATS_MATRIX_RPC_MAX_P95_MS", os.environ.get("PR_MATRIX_RPC_MAX_P95_MS", "500")))
RPC_MAX_P99_MS = float(os.environ.get("PR_NATS_MATRIX_RPC_MAX_P99_MS", os.environ.get("PR_MATRIX_RPC_MAX_P99_MS", "1000")))
CASE_RETRIES = int(os.environ.get("PR_NATS_MATRIX_CASE_RETRIES", os.environ.get("PR_MATRIX_CASE_RETRIES", "1")))
PYTHON_BIN = os.environ.get("PR_NATS_MATRIX_PYTHON", sys.executable)


PAYLOADS: dict[str, bytes] = {
  "proto": b"proto:joint=hip;q=[0.1,-0.2,0.3];stamp=42",
  "msg": b"msg:sensor_msgs/JointState:rosidl-cdr-placeholder",
  "srv": b"srv:demo/srv/Plan:rosidl-request-placeholder",
  "dds_idl": b"dds_idl:demo::RobotState:cdr-placeholder",
  "omg_idl": b"omg_idl:demo::RobotState:cdr-placeholder",
}


CPP_SRC = r'''
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "infra/communication/cpp/nats/native_client.hpp"

namespace communication = pacific_rim::communication;
namespace core = pacific_rim::communication::core;

static std::uint64_t NowNs() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::system_clock::now().time_since_epoch()).count());
}

static core::Bytes HexToBytes(const std::string& hex) {
  core::Bytes out;
  out.reserve(hex.size() / 2);
  for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
    out.push_back(static_cast<std::uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  }
  return out;
}

static core::Bytes PayloadWithSeq(const core::Bytes& base, std::uint32_t seq) {
  core::Bytes out;
  out.reserve(base.size() + 12);
  out.push_back(static_cast<std::uint8_t>(seq & 0xff));
  out.push_back(static_cast<std::uint8_t>((seq >> 8) & 0xff));
  out.push_back(static_cast<std::uint8_t>((seq >> 16) & 0xff));
  out.push_back(static_cast<std::uint8_t>((seq >> 24) & 0xff));
  const auto sent_ns = NowNs();
  for (int shift = 0; shift < 64; shift += 8) {
    out.push_back(static_cast<std::uint8_t>((sent_ns >> shift) & 0xff));
  }
  out.insert(out.end(), base.begin(), base.end());
  return out;
}

static std::uint32_t SeqFromPayload(const core::Bytes& payload) {
  if (payload.size() < 4) return 0xffffffffu;
  return static_cast<std::uint32_t>(payload[0]) |
         (static_cast<std::uint32_t>(payload[1]) << 8) |
         (static_cast<std::uint32_t>(payload[2]) << 16) |
         (static_cast<std::uint32_t>(payload[3]) << 24);
}

static bool BodyEquals(const core::Bytes& payload, const core::Bytes& base) {
  return payload.size() == base.size() + 12 &&
         std::equal(base.begin(), base.end(), payload.begin() + 12);
}

static std::uint64_t SentNsFromPayload(const core::Bytes& payload) {
  if (payload.size() < 12) return 0;
  std::uint64_t out = 0;
  for (int index = 0; index < 8; ++index) {
    out |= static_cast<std::uint64_t>(payload[4 + index]) << (8 * index);
  }
  return out;
}

static core::BusConfig Config(const std::string& url) {
  core::BusConfig config;
  config.name = "matrix_cpp_nats";
  config.transport = communication::TransportKind::kNats;
  config.options["server_url"] = url;
  config.options["connect_timeout_ms"] = "3000";
  config.options["reconnect_wait_ms"] = "200";
  config.options["max_reconnect_attempts"] = "2";
  return config;
}

static core::Channel Channel(
    const std::string& name,
    const std::string& data_kind,
    bool rpc) {
  core::Channel channel;
  channel.name = name;
  channel.message_type = "matrix/" + data_kind;
  channel.metadata["middleware.family"] = "nats";
  channel.metadata["schema.type"] = "matrix/" + data_kind;
  channel.metadata["nats.payload"] = "raw_bytes";
  if (data_kind == "proto") {
    channel.metadata["codec"] = "protobuf";
    channel.metadata["schema.format"] = rpc ? "protobuf_rpc" : "protobuf";
  } else if (data_kind == "dds_idl" || data_kind == "omg_idl") {
    channel.metadata["codec"] = "cdr";
    channel.metadata["schema.format"] = rpc ? "dds_idl_rpc" : "dds_idl";
    channel.metadata["schema.language"] = "omg_idl";
    channel.metadata["dds.mode"] = "typed_native";
    channel.metadata["dds.codegen"] = "required_for_typed";
  } else {
    channel.metadata["codec"] = "cdr";
    channel.metadata["schema.format"] = data_kind == "srv" ? "ros2_srv" : "ros2_msg";
    channel.metadata["schema.language"] = "rosidl";
  }
  if (rpc) {
    channel.metadata["rpc.standard"] = data_kind == "proto" ? "protobuf_rpc" : "request_reply";
  }
  return channel;
}

static std::unique_ptr<core::MessageBus> Bus(const std::string& url) {
  pacific_rim::communication::nats::RegisterNativeNatsBus();
  auto config = Config(url);
  auto bus = core::MessageBusRegistry::Instance().Create(config);
  if (!bus || !bus->Connect(config)) return nullptr;
  return bus;
}

static void WritePubSubResult(
    const std::string& path,
    int received,
    int expected,
    int mismatches,
    int duplicates,
    std::uint64_t first_receive_ns,
    std::uint64_t last_receive_ns,
    const std::vector<double>& latencies) {
  std::ofstream out(path);
  out << "{\"received\":" << received
      << ",\"expected\":" << expected
      << ",\"mismatches\":" << mismatches
      << ",\"duplicates\":" << duplicates
      << ",\"first_receive_ns\":" << first_receive_ns
      << ",\"last_receive_ns\":" << last_receive_ns
      << ",\"complete\":" << (received == expected ? "true" : "false")
      << ",\"latencies_ms\":[";
  for (std::size_t i = 0; i < latencies.size(); ++i) {
    if (i != 0) out << ",";
    out << latencies[i];
  }
  out << "]}";
}

static void WriteRpcResult(const std::string& path, int ok, int expected, const std::vector<double>& latencies) {
  std::ofstream out(path);
  out << "{\"ok\":" << ok << ",\"expected\":" << expected << ",\"latencies_ms\":[";
  for (std::size_t i = 0; i < latencies.size(); ++i) {
    if (i != 0) out << ",";
    out << latencies[i];
  }
  out << "]}";
}

static int PubSubSub(int argc, char** argv) {
  const std::string url = argv[2];
  const std::string subject = argv[3];
  const std::string data_kind = argv[4];
  const int count = std::stoi(argv[5]);
  const auto base = HexToBytes(argv[6]);
  const std::string result_path = argv[7];
  auto bus = Bus(url);
  if (!bus) {
    std::cerr << "failed to connect NATS subscriber\n";
    return 2;
  }
  std::mutex mutex;
  std::condition_variable ready;
  std::vector<bool> seen(count, false);
  std::vector<double> latencies;
  int received = 0;
  int mismatches = 0;
  int duplicates = 0;
  std::uint64_t first_receive_ns = 0;
  std::uint64_t last_receive_ns = 0;
  const bool subscribed = bus->Subscribe(Channel(subject, data_kind, false), [&](const core::Bytes& payload) {
    const auto now = NowNs();
    const auto seq = SeqFromPayload(payload);
    if (seq == 0xffffffffu) {
      return;
    }
    std::lock_guard<std::mutex> lock(mutex);
    if (seq >= static_cast<std::uint32_t>(count) || !BodyEquals(payload, base)) {
      mismatches++;
      return;
    }
    if (seen[seq]) {
      duplicates++;
      return;
    }
    seen[seq] = true;
    received++;
    if (first_receive_ns == 0) {
      first_receive_ns = now;
    }
    last_receive_ns = now;
    const auto sent = SentNsFromPayload(payload);
    if (sent > 0 && now >= sent) {
      latencies.push_back(static_cast<double>(now - sent) / 1000000.0);
    }
    if (received >= count) {
      ready.notify_one();
    }
  });
  if (!subscribed) {
    std::cerr << "failed to subscribe NATS subject\n";
    return 3;
  }
  std::cout << "READY" << std::endl;
  {
    std::unique_lock<std::mutex> lock(mutex);
    ready.wait_for(lock, std::chrono::seconds(15), [&]() { return received >= count; });
  }
  {
    std::lock_guard<std::mutex> lock(mutex);
    WritePubSubResult(result_path, received, count, mismatches, duplicates, first_receive_ns, last_receive_ns, latencies);
  }
  bus->Close();
  return received == count && mismatches == 0 && duplicates == 0 ? 0 : 4;
}

static int PubSubPub(int argc, char** argv) {
  const std::string url = argv[2];
  const std::string subject = argv[3];
  const std::string data_kind = argv[4];
  const int count = std::stoi(argv[5]);
  const auto base = HexToBytes(argv[6]);
  auto bus = Bus(url);
  if (!bus) {
    std::cerr << "failed to connect NATS publisher\n";
    return 2;
  }
  const auto channel = Channel(subject, data_kind, false);
  std::this_thread::sleep_for(std::chrono::milliseconds(700));
  for (int i = 0; i < 20; ++i) {
    if (!bus->Publish(channel, PayloadWithSeq(base, 0xffffffffu))) {
      return 3;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  const double interval = std::atof(std::getenv("PR_NATS_MATRIX_PUB_INTERVAL_SEC") ? std::getenv("PR_NATS_MATRIX_PUB_INTERVAL_SEC") : "0.003");
  for (int i = 0; i < count; ++i) {
    if (!bus->Publish(channel, PayloadWithSeq(base, static_cast<std::uint32_t>(i)))) {
      return 3;
    }
    std::this_thread::sleep_for(std::chrono::duration<double>(interval));
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  bus->Close();
  return 0;
}

static int RpcServer(int argc, char** argv) {
  const std::string url = argv[2];
  const std::string subject = argv[3];
  const std::string data_kind = argv[4];
  auto bus = Bus(url);
  if (!bus) {
    std::cerr << "failed to connect NATS RPC server\n";
    return 2;
  }
  const bool handled = bus->HandleRequest(Channel(subject, data_kind, true), [](const core::Bytes& request) {
    core::Bytes response{'o', 'k', ':'};
    response.insert(response.end(), request.begin(), request.end());
    return response;
  });
  if (!handled) {
    std::cerr << "failed to handle NATS RPC subject\n";
    return 3;
  }
  std::cout << "READY" << std::endl;
  while (true) {
    std::this_thread::sleep_for(std::chrono::hours(1));
  }
}

static int RpcClient(int argc, char** argv) {
  const std::string url = argv[2];
  const std::string subject = argv[3];
  const std::string data_kind = argv[4];
  const int count = std::stoi(argv[5]);
  const auto base = HexToBytes(argv[6]);
  const std::string result_path = argv[7];
  auto bus = Bus(url);
  if (!bus) {
    std::cerr << "failed to connect NATS RPC client\n";
    return 2;
  }
  const auto channel = Channel(subject, data_kind, true);
  bool warm = false;
  for (int attempt = 0; attempt < 20 && !warm; ++attempt) {
    core::Bytes response;
    const auto payload = PayloadWithSeq(base, 0xffffffffu);
    if (bus->Request(channel, payload, std::chrono::milliseconds(250), &response)) {
      core::Bytes expected{'o', 'k', ':'};
      expected.insert(expected.end(), payload.begin(), payload.end());
      warm = response == expected;
    }
    if (!warm) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  }
  int ok = 0;
  std::vector<double> latencies;
  for (int i = 0; i < count; ++i) {
    const auto payload = PayloadWithSeq(base, static_cast<std::uint32_t>(i));
    core::Bytes response;
    const auto start = NowNs();
    const bool received = bus->Request(channel, payload, std::chrono::milliseconds(3000), &response);
    const auto elapsed = NowNs() - start;
    core::Bytes expected{'o', 'k', ':'};
    expected.insert(expected.end(), payload.begin(), payload.end());
    if (received && response == expected) {
      ok++;
      latencies.push_back(static_cast<double>(elapsed) / 1000000.0);
    }
  }
  WriteRpcResult(result_path, ok, count, latencies);
  bus->Close();
  return ok == count ? 0 : 4;
}

int main(int argc, char** argv) {
  if (argc < 2) return 2;
  const std::string role = argv[1];
  try {
    if (role == "pubsub-sub") return PubSubSub(argc, argv);
    if (role == "pubsub-pub") return PubSubPub(argc, argv);
    if (role == "rpc-server") return RpcServer(argc, argv);
    if (role == "rpc-client") return RpcClient(argc, argv);
  } catch (const std::exception& exc) {
    std::cerr << exc.what() << "\n";
    return 2;
  }
  return 2;
}
'''


PY_SRC = r'''
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from pacific_rim_communication_infra.core import Channel, create_message_bus


def now_ns() -> int:
  return time.time_ns()


def hex_to_bytes(value: str) -> bytes:
  return bytes.fromhex(value)


def payload_with_seq(base: bytes, seq: int) -> bytes:
  sent = now_ns()
  return (
    int(seq & 0xFFFFFFFF).to_bytes(4, "little")
    + int(sent).to_bytes(8, "little")
    + base
  )


def seq_from_payload(payload: bytes) -> int:
  if len(payload) < 4:
    return 0xFFFFFFFF
  return int.from_bytes(payload[:4], "little")


def sent_ns_from_payload(payload: bytes) -> int:
  if len(payload) < 12:
    return 0
  return int.from_bytes(payload[4:12], "little")


def body_equals(payload: bytes, base: bytes) -> bool:
  return len(payload) == len(base) + 12 and payload[12:] == base


def channel(name: str, data_kind: str, rpc: bool) -> Channel:
  metadata = {
    "middleware.family": "nats",
    "schema.type": f"matrix/{data_kind}",
    "nats.payload": "raw_bytes",
  }
  if data_kind == "proto":
    metadata["codec"] = "protobuf"
    metadata["schema.format"] = "protobuf_rpc" if rpc else "protobuf"
  elif data_kind in {"dds_idl", "omg_idl"}:
    metadata["codec"] = "cdr"
    metadata["schema.format"] = "dds_idl_rpc" if rpc else "dds_idl"
    metadata["schema.language"] = "omg_idl"
    metadata["dds.mode"] = "typed_native"
    metadata["dds.codegen"] = "required_for_typed"
  else:
    metadata["codec"] = "cdr"
    metadata["schema.format"] = "ros2_srv" if data_kind == "srv" else "ros2_msg"
    metadata["schema.language"] = "rosidl"
  if rpc:
    metadata["rpc.standard"] = "protobuf_rpc" if data_kind == "proto" else "request_reply"
  return Channel(name=name, message_type=f"matrix/{data_kind}", metadata=metadata)


def bus_for(url: str):
  return create_message_bus(
    "nats",
    {
      "server_url": url,
      "name": "matrix_python_nats",
      "connect_timeout_sec": 3.0,
      "reconnect_wait_sec": 0.2,
      "max_reconnect_attempts": 2,
    },
  )


async def pubsub_sub(argv: list[str]) -> int:
  _, _, url, subject, data_kind, count, payload_hex, result_path = argv
  count = int(count)
  base = hex_to_bytes(payload_hex)
  bus = bus_for(url)
  await bus.connect()
  seen = [False] * count
  received = 0
  mismatches = 0
  duplicates = 0
  first_receive_ns = 0
  last_receive_ns = 0
  latencies: list[float] = []
  done = asyncio.Event()

  async def handler(payload: bytes) -> None:
    nonlocal received, mismatches, duplicates, first_receive_ns, last_receive_ns
    now = now_ns()
    seq = seq_from_payload(payload)
    if seq == 0xFFFFFFFF:
      return
    if seq >= count or not body_equals(payload, base):
      mismatches += 1
      return
    if seen[seq]:
      duplicates += 1
      return
    seen[seq] = True
    received += 1
    if first_receive_ns == 0:
      first_receive_ns = now
    last_receive_ns = now
    sent = sent_ns_from_payload(payload)
    if sent > 0 and now >= sent:
      latencies.append((now - sent) / 1_000_000.0)
    if received >= count:
      done.set()

  await bus.subscribe_bytes(channel(subject, data_kind, False), handler)
  print("READY", flush=True)
  try:
    await asyncio.wait_for(done.wait(), timeout=15.0)
  except TimeoutError:
    pass
  Path(result_path).write_text(json.dumps({
    "received": received,
    "expected": count,
    "mismatches": mismatches,
    "duplicates": duplicates,
    "first_receive_ns": first_receive_ns,
    "last_receive_ns": last_receive_ns,
    "latencies_ms": latencies,
    "complete": received == count,
  }))
  await bus.close()
  return 0 if received == count and mismatches == 0 and duplicates == 0 else 4


async def pubsub_pub(argv: list[str]) -> int:
  _, _, url, subject, data_kind, count, payload_hex = argv
  count = int(count)
  base = hex_to_bytes(payload_hex)
  bus = bus_for(url)
  await bus.connect()
  ch = channel(subject, data_kind, False)
  await asyncio.sleep(0.7)
  for _ in range(20):
    await bus.publish_bytes(ch, payload_with_seq(base, 0xFFFFFFFF))
    await asyncio.sleep(0.02)
  interval = float(os.environ.get("PR_NATS_MATRIX_PUB_INTERVAL_SEC", "0.003"))
  for i in range(count):
    await bus.publish_bytes(ch, payload_with_seq(base, i))
    await asyncio.sleep(interval)
  await asyncio.sleep(0.5)
  await bus.close()
  return 0


async def rpc_server(argv: list[str]) -> int:
  _, _, url, subject, data_kind = argv
  bus = bus_for(url)
  await bus.connect()

  async def handler(payload: bytes) -> bytes:
    return b"ok:" + payload

  await bus.handle_request_bytes(channel(subject, data_kind, True), handler)
  print("READY", flush=True)
  while True:
    await asyncio.sleep(3600)


async def rpc_client(argv: list[str]) -> int:
  _, _, url, subject, data_kind, count, payload_hex, result_path = argv
  count = int(count)
  base = hex_to_bytes(payload_hex)
  bus = bus_for(url)
  await bus.connect()
  ch = channel(subject, data_kind, True)
  warm = False
  for _ in range(20):
    payload = payload_with_seq(base, 0xFFFFFFFF)
    try:
      warm = await bus.request_bytes(ch, payload, timeout_sec=0.25) == b"ok:" + payload
    except Exception:
      warm = False
    if warm:
      break
    await asyncio.sleep(0.1)
  ok = 0
  latencies: list[float] = []
  for i in range(count):
    payload = payload_with_seq(base, i)
    start = time.perf_counter_ns()
    try:
      response = await bus.request_bytes(ch, payload, timeout_sec=3.0)
    except Exception:
      response = b""
    elapsed = time.perf_counter_ns() - start
    if response == b"ok:" + payload:
      ok += 1
      latencies.append(elapsed / 1_000_000.0)
  Path(result_path).write_text(json.dumps({"ok": ok, "expected": count, "latencies_ms": latencies}))
  await bus.close()
  return 0 if ok == count else 4


async def main(argv: list[str]) -> int:
  role = argv[1]
  if role == "pubsub-sub":
    return await pubsub_sub(argv)
  if role == "pubsub-pub":
    return await pubsub_pub(argv)
  if role == "rpc-server":
    return await rpc_server(argv)
  if role == "rpc-client":
    return await rpc_client(argv)
  return 2


if __name__ == "__main__":
  raise SystemExit(asyncio.run(main(sys.argv)))
'''


GO_SRC = r'''
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	commcore "github.com/pacific-rim/pacific-rim/infra/communication/go/core"
	commnats "github.com/pacific-rim/pacific-rim/infra/communication/go/nats"
)

func nowNs() uint64 {
	return uint64(time.Now().UnixNano())
}

func hexToBytes(value string) []byte {
	out, err := hex.DecodeString(value)
	if err != nil {
		panic(err)
	}
	return out
}

func payloadWithSeq(base []byte, seq uint32) []byte {
	out := make([]byte, 0, len(base)+12)
	out = append(out, byte(seq), byte(seq>>8), byte(seq>>16), byte(seq>>24))
	sent := nowNs()
	for shift := 0; shift < 64; shift += 8 {
		out = append(out, byte(sent>>shift))
	}
	out = append(out, base...)
	return out
}

func seqFromPayload(payload []byte) uint32 {
	if len(payload) < 4 {
		return 0xffffffff
	}
	return uint32(payload[0]) |
		uint32(payload[1])<<8 |
		uint32(payload[2])<<16 |
		uint32(payload[3])<<24
}

func sentNsFromPayload(payload []byte) uint64 {
	if len(payload) < 12 {
		return 0
	}
	var out uint64
	for index := 0; index < 8; index++ {
		out |= uint64(payload[4+index]) << (8 * index)
	}
	return out
}

func bodyEquals(payload []byte, base []byte) bool {
	return len(payload) == len(base)+12 && bytes.Equal(payload[12:], base)
}

func config(url string) commcore.BusConfig {
	return commcore.BusConfig{
		Transport: communication.TransportNATS,
		Name:      "matrix_go_nats",
		Options: map[string]any{
			"server_url":             url,
			"connect_timeout_ms":     3000,
			"reconnect_wait_ms":      200,
			"max_reconnect_attempts": 2,
		},
	}
}

func channel(name string, dataKind string, rpc bool) commcore.Channel {
	metadata := map[string]string{
		"middleware.family": "nats",
		"schema.type":       "matrix/" + dataKind,
		"nats.payload":      "raw_bytes",
	}
	switch dataKind {
	case "proto":
		metadata["codec"] = "protobuf"
		if rpc {
			metadata["schema.format"] = "protobuf_rpc"
		} else {
			metadata["schema.format"] = "protobuf"
		}
	case "dds_idl", "omg_idl":
		metadata["codec"] = "cdr"
		if rpc {
			metadata["schema.format"] = "dds_idl_rpc"
		} else {
			metadata["schema.format"] = "dds_idl"
		}
		metadata["schema.language"] = "omg_idl"
		metadata["dds.mode"] = "typed_native"
		metadata["dds.codegen"] = "required_for_typed"
	default:
		metadata["codec"] = "cdr"
		if dataKind == "srv" {
			metadata["schema.format"] = "ros2_srv"
		} else {
			metadata["schema.format"] = "ros2_msg"
		}
		metadata["schema.language"] = "rosidl"
	}
	if rpc {
		if dataKind == "proto" {
			metadata["rpc.standard"] = "protobuf_rpc"
		} else {
			metadata["rpc.standard"] = "request_reply"
		}
	}
	return commcore.Channel{
		Name:        name,
		MessageType: "matrix/" + dataKind,
		Metadata:    metadata,
	}
}

func busFor(ctx context.Context, url string) (commcore.MessageBus, error) {
	commnats.RegisterNativeBus()
	bus, err := commcore.NewBus(config(url))
	if err != nil {
		return nil, err
	}
	if err := bus.Connect(ctx); err != nil {
		return nil, err
	}
	return bus, nil
}

func pubsubSub(args []string) int {
	ctx := context.Background()
	url := args[2]
	subject := args[3]
	dataKind := args[4]
	count, _ := strconv.Atoi(args[5])
	base := hexToBytes(args[6])
	resultPath := args[7]
	bus, err := busFor(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer bus.Close(ctx)

	var mu sync.Mutex
	seen := make([]bool, count)
	received := 0
	mismatches := 0
	duplicates := 0
	firstReceiveNs := uint64(0)
	lastReceiveNs := uint64(0)
	latencies := []float64{}
	done := make(chan struct{})
	doneOnce := sync.Once{}
	if err := bus.Subscribe(ctx, channel(subject, dataKind, false), func(_ context.Context, payload []byte) error {
		now := nowNs()
		seq := seqFromPayload(payload)
		if seq == 0xffffffff {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		if seq >= uint32(count) || !bodyEquals(payload, base) {
			mismatches++
			return nil
		}
		if seen[seq] {
			duplicates++
			return nil
		}
		seen[seq] = true
		received++
		if firstReceiveNs == 0 {
			firstReceiveNs = now
		}
		lastReceiveNs = now
		if sent := sentNsFromPayload(payload); sent > 0 && now >= sent {
			latencies = append(latencies, float64(now-sent)/1000000.0)
		}
		if received >= count {
			doneOnce.Do(func() { close(done) })
		}
		return nil
	}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	fmt.Println("READY")
	select {
	case <-done:
	case <-time.After(15 * time.Second):
	}
	mu.Lock()
	result := map[string]any{
		"received":         received,
		"expected":         count,
		"mismatches":       mismatches,
		"duplicates":       duplicates,
		"first_receive_ns": firstReceiveNs,
		"last_receive_ns":  lastReceiveNs,
		"latencies_ms":     latencies,
		"complete":         received == count,
	}
	ok := received == count && mismatches == 0 && duplicates == 0
	mu.Unlock()
	data, _ := json.Marshal(result)
	_ = os.WriteFile(resultPath, data, 0o644)
	if ok {
		return 0
	}
	return 4
}

func pubsubPub(args []string) int {
	ctx := context.Background()
	url := args[2]
	subject := args[3]
	dataKind := args[4]
	count, _ := strconv.Atoi(args[5])
	base := hexToBytes(args[6])
	bus, err := busFor(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer bus.Close(ctx)
	ch := channel(subject, dataKind, false)
	time.Sleep(700 * time.Millisecond)
	for i := 0; i < 20; i++ {
		if err := bus.Publish(ctx, ch, payloadWithSeq(base, 0xffffffff)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 3
		}
		time.Sleep(20 * time.Millisecond)
	}
	interval, _ := strconv.ParseFloat(os.Getenv("PR_NATS_MATRIX_PUB_INTERVAL_SEC"), 64)
	if interval <= 0 {
		interval = 0.003
	}
	for i := 0; i < count; i++ {
		if err := bus.Publish(ctx, ch, payloadWithSeq(base, uint32(i))); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 3
		}
		time.Sleep(time.Duration(interval * float64(time.Second)))
	}
	time.Sleep(500 * time.Millisecond)
	return 0
}

func rpcServer(args []string) int {
	ctx := context.Background()
	url := args[2]
	subject := args[3]
	dataKind := args[4]
	bus, err := busFor(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer bus.Close(ctx)
	if err := bus.HandleRequest(ctx, channel(subject, dataKind, true), func(_ context.Context, request []byte) ([]byte, error) {
		response := append([]byte("ok:"), request...)
		return response, nil
	}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	fmt.Println("READY")
	select {}
}

func rpcClient(args []string) int {
	ctx := context.Background()
	url := args[2]
	subject := args[3]
	dataKind := args[4]
	count, _ := strconv.Atoi(args[5])
	base := hexToBytes(args[6])
	resultPath := args[7]
	bus, err := busFor(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer bus.Close(ctx)
	ch := channel(subject, dataKind, true)
	warm := false
	for attempt := 0; attempt < 20 && !warm; attempt++ {
		payload := payloadWithSeq(base, 0xffffffff)
		response, err := bus.Request(ctx, ch, payload, 250*time.Millisecond)
		expected := append([]byte("ok:"), payload...)
		warm = err == nil && bytes.Equal(response, expected)
		if !warm {
			time.Sleep(100 * time.Millisecond)
		}
	}
	ok := 0
	latencies := []float64{}
	for i := 0; i < count; i++ {
		payload := payloadWithSeq(base, uint32(i))
		start := time.Now()
		response, err := bus.Request(ctx, ch, payload, 3*time.Second)
		elapsed := time.Since(start)
		expected := append([]byte("ok:"), payload...)
		if err == nil && bytes.Equal(response, expected) {
			ok++
			latencies = append(latencies, float64(elapsed.Nanoseconds())/1000000.0)
		}
	}
	result := map[string]any{"ok": ok, "expected": count, "latencies_ms": latencies}
	data, _ := json.Marshal(result)
	_ = os.WriteFile(resultPath, data, 0o644)
	if ok == count {
		return 0
	}
	return 4
}

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	switch os.Args[1] {
	case "pubsub-sub":
		os.Exit(pubsubSub(os.Args))
	case "pubsub-pub":
		os.Exit(pubsubPub(os.Args))
	case "rpc-server":
		os.Exit(rpcServer(os.Args))
	case "rpc-client":
		os.Exit(rpcClient(os.Args))
	default:
		os.Exit(2)
	}
}
'''


def env() -> dict[str, str]:
  current = os.environ.copy()
  current["PYTHONPATH"] = f"{ROOT / 'infra/communication/python'}:{ROOT / 'infra/protocol/python'}:{current.get('PYTHONPATH', '')}"
  current["PR_NATS_MATRIX_PUB_INTERVAL_SEC"] = str(PUB_INTERVAL_SEC)
  current["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
  return current


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
  return subprocess.run(cmd, text=True, capture_output=True, env=env(), **kwargs)


def arch_name() -> str:
  machine = platform.machine().lower()
  if machine in {"aarch64", "arm64"}:
    return "arm64"
  if machine in {"x86_64", "amd64"}:
    return "amd64"
  return machine


def parse_go_version(output: str) -> tuple[int, int, int]:
  match = re.search(r"go version go(\d+)\.(\d+)(?:\.(\d+))?", output)
  if not match:
    return (0, 0, 0)
  return (
    int(match.group(1)),
    int(match.group(2)),
    int(match.group(3) or "0"),
  )


def ensure_go() -> str:
  preferred = os.environ.get("PR_MATRIX_GO")
  if preferred:
    return preferred
  try:
    system = run(["go", "version"])
  except FileNotFoundError:
    system = subprocess.CompletedProcess(["go", "version"], 127, "", "")
  if system.returncode == 0 and parse_go_version(system.stdout) >= (1, 25, 0):
    return "go"
  go_root = Path(f"/tmp/go{GO_VERSION}")
  go_bin = go_root / "go/bin/go"
  if not go_bin.exists():
    archive = Path(f"/tmp/go{GO_VERSION}.tar.gz")
    url = f"https://go.dev/dl/go{GO_VERSION}.linux-{arch_name()}.tar.gz"
    result = run(["curl", "-fsSL", url, "-o", str(archive)], timeout=120)
    if result.returncode != 0:
      raise RuntimeError("download Go toolchain failed\n" + result.stderr)
    go_root.mkdir(parents=True, exist_ok=True)
    result = run(["tar", "-C", str(go_root), "-xzf", str(archive)], timeout=120)
    if result.returncode != 0:
      raise RuntimeError("extract Go toolchain failed\n" + result.stderr)
  return str(go_bin)


def compile_runners() -> tuple[Path, Path, Path]:
  cpp_src = WORK / "nats_matrix.cpp"
  py_src = WORK / "nats_matrix.py"
  go_dir = WORK / "go_runner"
  go_dir.mkdir(parents=True, exist_ok=True)
  go_src = go_dir / "main.go"
  go_mod = go_dir / "go.mod"
  cpp_bin = WORK / "nats_matrix_cpp"
  go_bin = WORK / "nats_matrix_go"
  cpp_src.write_text(CPP_SRC)
  py_src.write_text(PY_SRC)
  go_src.write_text(GO_SRC)
  go_mod.write_text(
    "\n".join(
      [
        "module pr_nats_matrix",
        "",
        "go 1.25.0",
        "",
        "require github.com/pacific-rim/pacific-rim/infra v0.0.0",
        "",
        f"replace github.com/pacific-rim/pacific-rim/infra => {ROOT / 'infra'}",
        "",
      ]
    )
  )
  cmd = [
    "c++", "-std=c++17", "-O2",
    f"-I{ROOT}",
    f"-I{ROOT / 'infra/communication/cpp/include'}",
    str(cpp_src),
    "-pthread",
    "-o", str(cpp_bin),
  ]
  result = run(cmd, cwd=ROOT)
  if result.returncode != 0:
    raise RuntimeError("C++ NATS matrix build failed\n" + result.stderr)
  go = ensure_go()
  go_env = env()
  go_env["GOCACHE"] = os.environ.get("GOCACHE", "/tmp/pr-go-build-cache")
  go_env["GOMODCACHE"] = os.environ.get("GOMODCACHE", str(WORK / "go-mod-cache"))
  result = subprocess.run(
    [go, "mod", "tidy"],
    cwd=go_dir,
    text=True,
    capture_output=True,
    env=go_env,
  )
  if result.returncode != 0:
    raise RuntimeError("Go NATS matrix module tidy failed\n" + result.stderr)
  result = subprocess.run(
    [go, "build", "-o", str(go_bin), "."],
    cwd=go_dir,
    text=True,
    capture_output=True,
    env=go_env,
  )
  if result.returncode != 0:
    raise RuntimeError("Go NATS matrix build failed\n" + result.stderr)
  return cpp_bin, py_src, go_bin


def command(lang: str, role: str, subject: str, data_kind: str, count: int, payload: bytes, result: Path | None, cpp_bin: Path, py_src: Path, go_bin: Path) -> list[str]:
  if lang == "cpp":
    base = [str(cpp_bin), role, NATS_URL, subject, data_kind]
  elif lang == "python":
    base = [PYTHON_BIN, str(py_src), role, NATS_URL, subject, data_kind]
  elif lang == "go":
    base = [str(go_bin), role, NATS_URL, subject, data_kind]
  else:
    raise ValueError(f"unsupported matrix language {lang}")
  if role in {"pubsub-sub", "rpc-client"}:
    return [*base, str(count), payload.hex(), str(result)]
  if role == "pubsub-pub":
    return [*base, str(count), payload.hex()]
  return base


def wait_ready(proc: subprocess.Popen[str], timeout: float = 8.0) -> bool:
  if proc.stdout is None:
    return False
  selector = selectors.DefaultSelector()
  selector.register(proc.stdout, selectors.EVENT_READ)
  deadline = time.time() + timeout
  try:
    while time.time() < deadline:
      if proc.poll() is not None:
        return False
      events = selector.select(max(0.05, min(0.2, deadline - time.time())))
      for key, _ in events:
        line = key.fileobj.readline()
        if "READY" in line:
          return True
  finally:
    selector.close()
  return False


def percentile(values: list[float], pct: float) -> float:
  if not values:
    return 0.0
  ordered = sorted(values)
  index = min(len(ordered) - 1, max(0, int(round((pct / 100.0) * (len(ordered) - 1)))))
  return ordered[index]


def mean(values: list[float]) -> float:
  return statistics.mean(values) if values else 0.0


def runtime_path(data_kind: str) -> str:
  if data_kind in {"dds_idl", "omg_idl"}:
    return "nats_raw_bytes_with_typed_idl_metadata"
  if data_kind == "proto":
    return "nats_raw_bytes_protobuf"
  return "nats_raw_bytes_rosidl_metadata"


def language_pairs() -> tuple[tuple[str, str], ...]:
  if CROSS_LANGUAGE:
    return tuple((left, right) for left in LANGUAGES for right in LANGUAGES)
  return tuple((lang, lang) for lang in LANGUAGES)


def run_pubsub_attempt(cpp_bin: Path, py_src: Path, go_bin: Path, publisher: str, subscriber: str, data_kind: str, index: int, attempt: int) -> dict[str, object]:
  subject = f"matrix.nats.{publisher}.{subscriber}.{data_kind}.{index}.{attempt}"
  payload = PAYLOADS[data_kind]
  result_path = WORK / f"pubsub_nats_{publisher}_{subscriber}_{data_kind}_{index}_{attempt}.json"
  sub = subprocess.Popen(
    command(subscriber, "pubsub-sub", subject, data_kind, COUNT, payload, result_path, cpp_bin, py_src, go_bin),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env(),
  )
  ready = wait_ready(sub)
  pub_result = None
  if ready:
    try:
      pub_result = run(
        command(publisher, "pubsub-pub", subject, data_kind, COUNT, payload, None, cpp_bin, py_src, go_bin),
        timeout=25,
      )
    except subprocess.TimeoutExpired as exc:
      pub_result = subprocess.CompletedProcess(
        exc.cmd,
        124,
        stdout=exc.stdout or "",
        stderr=exc.stderr or f"timeout after {exc.timeout}s",
      )
  if not ready:
    sub.terminate()
  try:
    _, err = sub.communicate(timeout=20)
  except subprocess.TimeoutExpired:
    sub.kill()
    _, err = sub.communicate()
  data = json.loads(result_path.read_text()) if result_path.exists() else {}
  latencies = [float(value) for value in data.get("latencies_ms", [])]
  duration_sec = 0.0
  if data.get("first_receive_ns") and data.get("last_receive_ns") and data.get("last_receive_ns") >= data.get("first_receive_ns"):
    duration_sec = (float(data.get("last_receive_ns")) - float(data.get("first_receive_ns"))) / 1000000000.0
  throughput = (float(data.get("received", 0)) / duration_sec) if duration_sec > 0 else 0.0
  latency_p95 = percentile(latencies, 95)
  latency_p99 = percentile(latencies, 99)
  stability_ok = data.get("received") == COUNT and data.get("mismatches") == 0 and data.get("duplicates") == 0
  performance_ok = (
    bool(latencies) and
    latency_p95 <= PUBSUB_MAX_P95_MS and
    latency_p99 <= PUBSUB_MAX_P99_MS and
    throughput >= PUBSUB_MIN_THROUGHPUT
  )
  process_ok = ready and pub_result is not None and pub_result.returncode == 0
  ok = process_ok and stability_ok and performance_ok
  return {
    "pattern": "pubsub",
    "middleware": "nats",
    "runtime_path": runtime_path(data_kind),
    "publisher": publisher,
    "subscriber": subscriber,
    "data": data_kind,
    "ok": ok,
    "attempts": attempt,
    "process_ok": process_ok,
    "stability_ok": stability_ok,
    "performance_ok": performance_ok,
    "received": data.get("received", 0),
    "expected": COUNT,
    "loss": COUNT - int(data.get("received", 0)),
    "loss_rate": round(max(0, COUNT - int(data.get("received", 0))) / float(COUNT), 6),
    "duplicates": data.get("duplicates", 0),
    "mismatches": data.get("mismatches", 0),
    "latency_avg_ms": round(mean(latencies), 3) if latencies else 0.0,
    "latency_p95_ms": round(latency_p95, 3),
    "latency_p99_ms": round(latency_p99, 3),
    "throughput_msg_s": round(throughput, 3),
    "thresholds": f"pubsub_p95<={PUBSUB_MAX_P95_MS},pubsub_p99<={PUBSUB_MAX_P99_MS},throughput>={PUBSUB_MIN_THROUGHPUT}",
    "error": "" if ok else f"ready={ready} pub={getattr(pub_result, 'returncode', None)} sub_err={err.strip()} pub_out={getattr(pub_result, 'stdout', '').strip() if pub_result else ''} pub_err={getattr(pub_result, 'stderr', '').strip() if pub_result else ''}",
  }


def run_pubsub_case(cpp_bin: Path, py_src: Path, go_bin: Path, publisher: str, subscriber: str, data_kind: str, index: int) -> dict[str, object]:
  last: dict[str, object] | None = None
  for attempt in range(1, max(0, CASE_RETRIES) + 2):
    row = run_pubsub_attempt(cpp_bin, py_src, go_bin, publisher, subscriber, data_kind, index, attempt)
    row["attempts"] = attempt
    last = row
    if row.get("ok") is True:
      return row
    time.sleep(0.2)
  return last or {"pattern": "pubsub", "ok": False, "error": "case did not run"}


def run_rpc_attempt(cpp_bin: Path, py_src: Path, go_bin: Path, client: str, server: str, data_kind: str, index: int, attempt: int) -> dict[str, object]:
  subject = f"matrix.rpc.nats.{client}.{server}.{data_kind}.{index}.{attempt}"
  payload = PAYLOADS[data_kind]
  result_path = WORK / f"rpc_nats_{client}_{server}_{data_kind}_{index}_{attempt}.json"
  proc = subprocess.Popen(
    command(server, "rpc-server", subject, data_kind, RPC_COUNT, payload, None, cpp_bin, py_src, go_bin),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env(),
  )
  ready = wait_ready(proc)
  client_result = None
  if ready:
    try:
      client_result = run(
        command(client, "rpc-client", subject, data_kind, RPC_COUNT, payload, result_path, cpp_bin, py_src, go_bin),
        timeout=35,
      )
    except subprocess.TimeoutExpired as exc:
      client_result = subprocess.CompletedProcess(
        exc.cmd,
        124,
        stdout=exc.stdout or "",
        stderr=exc.stderr or f"timeout after {exc.timeout}s",
      )
  server_return = proc.poll()
  proc.terminate()
  try:
    _, server_err = proc.communicate(timeout=2)
  except subprocess.TimeoutExpired:
    proc.kill()
    _, server_err = proc.communicate()
  data = json.loads(result_path.read_text()) if result_path.exists() else {}
  latencies = [float(value) for value in data.get("latencies_ms", [])]
  latency_p95 = percentile(latencies, 95)
  latency_p99 = percentile(latencies, 99)
  stability_ok = data.get("ok") == RPC_COUNT
  performance_ok = bool(latencies) and latency_p95 <= RPC_MAX_P95_MS and latency_p99 <= RPC_MAX_P99_MS
  process_ok = ready and client_result is not None and client_result.returncode == 0
  ok = process_ok and stability_ok and performance_ok
  return {
    "pattern": "rpc",
    "middleware": "nats",
    "runtime_path": runtime_path(data_kind),
    "client": client,
    "server": server,
    "data": data_kind,
    "ok": ok,
    "attempts": attempt,
    "process_ok": process_ok,
    "stability_ok": stability_ok,
    "performance_ok": performance_ok,
    "received": data.get("ok", 0),
    "expected": RPC_COUNT,
    "loss": RPC_COUNT - int(data.get("ok", 0)),
    "loss_rate": round(max(0, RPC_COUNT - int(data.get("ok", 0))) / float(RPC_COUNT), 6),
    "latency_avg_ms": round(mean(latencies), 3) if latencies else 0.0,
    "latency_p95_ms": round(latency_p95, 3),
    "latency_p99_ms": round(latency_p99, 3),
    "thresholds": f"rpc_p95<={RPC_MAX_P95_MS},rpc_p99<={RPC_MAX_P99_MS}",
    "error": "" if ok else f"ready={ready} server_return={server_return} client={getattr(client_result, 'returncode', None)} server_err={server_err.strip()} client_out={getattr(client_result, 'stdout', '').strip() if client_result else ''} client_err={getattr(client_result, 'stderr', '').strip() if client_result else ''}",
  }


def run_rpc_case(cpp_bin: Path, py_src: Path, go_bin: Path, client: str, server: str, data_kind: str, index: int) -> dict[str, object]:
  last: dict[str, object] | None = None
  for attempt in range(1, max(0, CASE_RETRIES) + 2):
    row = run_rpc_attempt(cpp_bin, py_src, go_bin, client, server, data_kind, index, attempt)
    row["attempts"] = attempt
    last = row
    if row.get("ok") is True:
      return row
    time.sleep(0.2)
  return last or {"pattern": "rpc", "ok": False, "error": "case did not run"}


def config_matrix() -> list[dict[str, object]]:
  script = r'''
import json
from pacific_rim_communication_infra.core.service_config import load_service_communication_config
from pacific_rim_communication_infra.contracts import TransportKind
cases = [
  ("nats", "proto", "topic"),
  ("nats", "msg", "topic"),
  ("nats", "dds_idl", "topic"),
  ("nats", "omg_idl", "topic"),
  ("nats", "proto", "service"),
  ("nats", "srv", "service"),
  ("nats", "dds_idl", "service"),
  ("nats", "omg_idl", "service"),
]
out = []
for middleware, data, kind in cases:
  route = {"data": data, "type": "demo.Type", "middleware": middleware}
  if kind == "service":
    config = {"trace": {"service_name": "planner"}, "communication": {"services": {"case": route}}}
  else:
    config = {"trace": {"service_name": "planner"}, "communication": {"topics": {"case": route}}}
  middleware_map, topics, services = load_service_communication_config(config)
  endpoint = (services[0].server if kind == "service" else topics[0].publisher)
  out.append({
    "middleware": middleware,
    "data": data,
    "kind": kind,
    "transport": str(endpoint.transport),
    "expected": str(TransportKind.NATS),
    "ok": endpoint.transport == TransportKind.NATS,
    "codec": endpoint.metadata.get("codec", ""),
    "schema_format": endpoint.metadata.get("schema.format", ""),
    "schema_language": endpoint.metadata.get("schema.language", ""),
    "dds_mode": endpoint.metadata.get("dds.mode", ""),
    "dds_codegen": endpoint.metadata.get("dds.codegen", ""),
  })
print(json.dumps(out))
'''
  result = run(["python3", "-c", script], cwd=ROOT)
  if result.returncode != 0:
    return [{"pattern": "config", "ok": False, "error": result.stderr.strip()}]
  rows = json.loads(result.stdout)
  for row in rows:
    row["pattern"] = "config"
    row["runtime_path"] = runtime_path(str(row.get("data", "")))
  return rows


def write_report(rows: list[dict[str, object]]) -> None:
  OUT_DIR.mkdir(parents=True, exist_ok=True)
  json_path = OUT_DIR / "nats-native-matrix.json"
  csv_path = OUT_DIR / "nats-native-matrix.csv"
  md_path = OUT_DIR / "nats-native-matrix.md"
  json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
  fieldnames = sorted({key for row in rows for key in row.keys()})
  with csv_path.open("w", newline="") as file:
    writer = csv.DictWriter(file, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
      writer.writerow(row)
  passed = sum(1 for row in rows if row.get("ok") is True)
  total = len(rows)
  runtime_rows = [row for row in rows if row.get("pattern") in {"pubsub", "rpc"}]
  config_rows = [row for row in rows if row.get("pattern") == "config"]
  stable = sum(1 for row in runtime_rows if row.get("stability_ok") is True)
  performant = sum(1 for row in runtime_rows if row.get("performance_ok") is True)
  lines = [
    "# NATS Native Matrix Report",
    "",
    f"- Total cases: {total}",
    f"- Passed: {passed}",
    f"- Failed: {total - passed}",
    f"- Runtime communication cases: {len(runtime_rows)}",
    f"- Runtime stability passed: {stable}/{len(runtime_rows)}",
    f"- Runtime performance passed: {performant}/{len(runtime_rows)}",
    f"- Config routing cases: {len(config_rows)}",
    f"- Languages: {', '.join(LANGUAGES)}",
    f"- Cross-language role pairs: {CROSS_LANGUAGE}",
    f"- Pub/Sub data: {', '.join(PUBSUB_DATA_KINDS)}",
    f"- RPC data: {', '.join(RPC_DATA_KINDS)}",
    f"- Pub/Sub count per case: {COUNT}",
    "- Pub/Sub warmup: 20 ignored frames after subscribe readiness",
    f"- Pub/Sub interval per sample: {PUB_INTERVAL_SEC * 1000:.1f} ms",
    f"- Pub/Sub thresholds: p95 <= {PUBSUB_MAX_P95_MS} ms, p99 <= {PUBSUB_MAX_P99_MS} ms, throughput >= {PUBSUB_MIN_THROUGHPUT} msg/s",
    f"- RPC count per case: {RPC_COUNT}",
    f"- RPC thresholds: p95 <= {RPC_MAX_P95_MS} ms, p99 <= {RPC_MAX_P99_MS} ms",
    f"- Case retries: {CASE_RETRIES}",
    "- Runtime cases use actual NATS transport: C++ native TCP protocol, Python nats-py, Go nats.go.",
    "- Data-kind rows validate schema metadata and byte-payload compatibility for proto/msg/srv/dds_idl/omg_idl paths.",
    "",
    "## Cases",
    "",
    "| pattern | middleware | data | runtime | endpoints | attempts | ok | stability | performance | received/expected | latency avg/p95/p99 ms | throughput msg/s | error |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ]
  for row in rows:
    endpoints = row.get("publisher") and f"{row.get('publisher')}->{row.get('subscriber')}" or row.get("client") and f"{row.get('client')}->{row.get('server')}" or str(row.get("kind", ""))
    latency = ""
    if "latency_avg_ms" in row:
      latency = f"{row.get('latency_avg_ms')}/{row.get('latency_p95_ms')}/{row.get('latency_p99_ms')}"
    lines.append(
      f"| {row.get('pattern','')} | {row.get('middleware','')} | {row.get('data','')} | {row.get('runtime_path','')} | {endpoints} | {row.get('attempts','')} | {row.get('ok')} | {row.get('stability_ok','')} | {row.get('performance_ok','')} | {row.get('received','')}/{row.get('expected','')} | {latency} | {row.get('throughput_msg_s','')} | {str(row.get('error','')).replace('|', '/')} |"
    )
  md_path.write_text("\n".join(lines) + "\n")
  print(f"wrote {json_path}")
  print(f"wrote {csv_path}")
  print(f"wrote {md_path}")


def main() -> int:
  cpp_bin, py_src, go_bin = compile_runners()
  rows: list[dict[str, object]] = []
  idx = 0
  for data_kind in PUBSUB_DATA_KINDS:
    for publisher, subscriber in language_pairs():
      idx += 1
      row = run_pubsub_case(cpp_bin, py_src, go_bin, publisher, subscriber, data_kind, idx)
      rows.append(row)
      print(("PASS" if row["ok"] else "FAIL"), row)
  for data_kind in RPC_DATA_KINDS:
    for client, server in language_pairs():
      idx += 1
      row = run_rpc_case(cpp_bin, py_src, go_bin, client, server, data_kind, idx)
      rows.append(row)
      print(("PASS" if row["ok"] else "FAIL"), row)
  rows.extend(config_matrix())
  write_report(rows)
  return 0 if all(row.get("ok") is True for row in rows) else 1


if __name__ == "__main__":
  raise SystemExit(main())
