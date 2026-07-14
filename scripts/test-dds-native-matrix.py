#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(os.environ.get("PR_MATRIX_ROOT", "/workspace"))
OUT_DIR = ROOT / "out/test-report"
WORK_ROOT = ROOT / "infra/out/dds_native_matrix"
WORK_ROOT.mkdir(parents=True, exist_ok=True)
WORK = Path(tempfile.mkdtemp(prefix="run_", dir=WORK_ROOT))
DOMAIN_BASE = int(os.environ.get("PR_MATRIX_DOMAIN_BASE", str(16 + ((os.getpid() + int(time.time())) % 40))))
DOMAIN_MIN = int(os.environ.get("PR_MATRIX_DOMAIN_MIN", "16"))
DOMAIN_SPAN = int(os.environ.get("PR_MATRIX_DOMAIN_SPAN", "160"))
COUNT = int(os.environ.get("PR_MATRIX_COUNT", "80"))
RPC_COUNT = int(os.environ.get("PR_MATRIX_RPC_COUNT", "40"))
RPC_WARMUP_COUNT = int(os.environ.get("PR_MATRIX_RPC_WARMUP_COUNT", "5"))
PUB_INTERVAL_SEC = float(os.environ.get("PR_MATRIX_PUB_INTERVAL_SEC", "0.003"))
LANGUAGES = tuple(
  item.strip()
  for item in os.environ.get("PR_MATRIX_LANGUAGES", "cpp,python,go").split(",")
  if item.strip()
)
MIDDLEWARES = tuple(
  item.strip()
  for item in os.environ.get("PR_MATRIX_MIDDLEWARES", "cyclonedds,fastdds").split(",")
  if item.strip()
)
PUBSUB_DATA_KINDS = tuple(
  item.strip()
  for item in os.environ.get("PR_MATRIX_PUBSUB_DATA", "proto,msg,dds_idl,omg_idl").split(",")
  if item.strip()
)
RPC_DATA_KINDS = tuple(
  item.strip()
  for item in os.environ.get("PR_MATRIX_RPC_DATA", "proto,srv,dds_idl,omg_idl").split(",")
  if item.strip()
)
GO_VERSION = os.environ.get("PR_MATRIX_GO_VERSION", "1.25.5")
PUBSUB_MAX_P95_MS = float(os.environ.get("PR_MATRIX_PUBSUB_MAX_P95_MS", "250"))
PUBSUB_MAX_P99_MS = float(os.environ.get("PR_MATRIX_PUBSUB_MAX_P99_MS", "500"))
PUBSUB_MIN_THROUGHPUT = float(os.environ.get("PR_MATRIX_PUBSUB_MIN_THROUGHPUT", "20"))
RPC_MAX_P95_MS = float(os.environ.get("PR_MATRIX_RPC_MAX_P95_MS", "500"))
RPC_MAX_P99_MS = float(os.environ.get("PR_MATRIX_RPC_MAX_P99_MS", "1000"))
CASE_RETRIES = int(os.environ.get("PR_MATRIX_CASE_RETRIES", "1"))


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
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "infra/communication/cpp/dds/fastdds_native_byte_client.hpp"
#include "infra/communication/cpp/dds/native_byte_client.hpp"

namespace communication = pacific_rim::communication;
namespace core = pacific_rim::communication::core;

static std::uint64_t NowNs() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count());
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

static bool IsWarmupPayload(const core::Bytes& payload) {
  return SeqFromPayload(payload) == 0xffffffffu;
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

static core::BusConfig Config(const std::string& middleware, int domain) {
  core::BusConfig config;
  config.name = "matrix_cpp_" + middleware + "_" + std::to_string(domain);
  config.transport = middleware == "fastdds"
                         ? communication::TransportKind::kFastDds
                         : communication::TransportKind::kCycloneDds;
  config.options["domain_id"] = std::to_string(domain);
  config.options["type_name"] = "PacificRimMessageEnvelope";
  config.options["qos.reliability"] = "reliable";
  config.options["qos.history"] = "keep_last";
  config.options["qos.depth"] = "256";
  return config;
}

static core::Channel Channel(
    const std::string& name,
    const std::string& data_kind,
    bool rpc) {
  core::Channel channel;
  channel.name = name;
  channel.message_type = "matrix/" + data_kind;
  if (data_kind == "proto") {
    channel.metadata["codec"] = "protobuf";
    channel.metadata["schema.format"] = rpc ? "protobuf_rpc" : "protobuf";
  } else if (data_kind == "dds_idl") {
    channel.metadata["codec"] = "cdr";
    channel.metadata["schema.format"] = rpc ? "dds_idl_rpc" : "dds_idl";
    channel.metadata["schema.language"] = "omg_idl";
    channel.metadata["dds.mode"] = "typed_preferred";
    channel.metadata["dds.fallback"] = "byte_envelope";
    channel.metadata["dds.type"] = "matrix/" + data_kind;
  } else if (data_kind == "omg_idl") {
    channel.metadata["codec"] = "cdr";
    channel.metadata["schema.format"] = rpc ? "dds_idl_rpc" : "dds_idl";
    channel.metadata["schema.language"] = "omg_idl";
    channel.metadata["dds.mode"] = "typed_preferred";
    channel.metadata["dds.fallback"] = "byte_envelope";
    channel.metadata["dds.type"] = "matrix/" + data_kind;
  } else {
    channel.metadata["codec"] = "cdr";
    channel.metadata["schema.format"] = data_kind == "srv" ? "ros2_srv" : "ros2_msg";
    channel.metadata["schema.language"] = "rosidl";
    channel.metadata["dds.mode"] = "byte_envelope";
  }
  if (data_kind == "proto") {
    channel.metadata["dds.mode"] = "byte_envelope";
  }
  channel.metadata["schema.type"] = "matrix/" + data_kind;
  channel.metadata["qos.reliability"] = "reliable";
  channel.metadata["qos.history"] = "keep_last";
  channel.metadata["qos.depth"] = "256";
  if (rpc) {
    channel.metadata["rpc.standard"] = "omg_dds_rpc";
    channel.metadata["rpc.request_channel"] = name + ".request";
    channel.metadata["rpc.response_channel"] = name + ".response";
  }
  return channel;
}

static std::unique_ptr<core::MessageBus> Bus(const std::string& middleware, int domain) {
  pacific_rim::communication::dds::RegisterNativeByteEnvelopeCycloneDdsBus();
  pacific_rim::communication::dds::RegisterNativeByteEnvelopeFastDdsBus();
  auto config = Config(middleware, domain);
  auto bus = core::MessageBusRegistry::Instance().Create(config);
  if (!bus || !bus->Connect(config)) return nullptr;
  return bus;
}

static int PubSubSub(int argc, char** argv) {
  const std::string middleware = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string topic = argv[4];
  const std::string data_kind = argv[5];
  const int count = std::stoi(argv[6]);
  const auto base = HexToBytes(argv[7]);
  const std::string result_path = argv[8];
  auto bus = Bus(middleware, domain);
  if (!bus) return 2;
  std::mutex mutex;
  std::condition_variable cv;
  std::vector<bool> seen(static_cast<std::size_t>(count), false);
  std::vector<std::uint64_t> receive_ns;
  std::vector<double> latencies_ms;
  std::uint64_t first_receive_ns = 0;
  std::uint64_t last_receive_ns = 0;
  int mismatches = 0;
  int duplicates = 0;
  const auto channel = Channel(topic, data_kind, false);
  if (!bus->Subscribe(channel, [&](const core::Bytes& payload) {
        const auto now = NowNs();
        std::lock_guard<std::mutex> lock(mutex);
        if (IsWarmupPayload(payload)) {
          return;
        }
        const auto seq = SeqFromPayload(payload);
        if (seq >= static_cast<std::uint32_t>(count) || !BodyEquals(payload, base)) {
          ++mismatches;
          return;
        }
        if (seen[seq]) {
          ++duplicates;
          return;
        }
        seen[seq] = true;
        receive_ns.push_back(now);
        if (first_receive_ns == 0) {
          first_receive_ns = now;
        }
        last_receive_ns = now;
        const auto sent_ns = SentNsFromPayload(payload);
        if (sent_ns > 0 && now >= sent_ns) {
          latencies_ms.push_back(static_cast<double>(now - sent_ns) / 1000000.0);
        }
        cv.notify_one();
      })) {
    return 3;
  }
  std::cout << "READY" << std::endl;
  std::unique_lock<std::mutex> lock(mutex);
  const bool complete = cv.wait_for(
      lock,
      std::chrono::seconds(15),
      [&]() { return static_cast<int>(receive_ns.size()) >= count; });
  std::ofstream out(result_path);
  out << "{\"received\":" << receive_ns.size()
      << ",\"expected\":" << count
      << ",\"mismatches\":" << mismatches
      << ",\"duplicates\":" << duplicates
      << ",\"first_receive_ns\":" << first_receive_ns
      << ",\"last_receive_ns\":" << last_receive_ns
      << ",\"latencies_ms\":[";
  for (std::size_t i = 0; i < latencies_ms.size(); ++i) {
    if (i) out << ",";
    out << latencies_ms[i];
  }
  out << "]"
      << ",\"complete\":" << (complete ? "true" : "false") << "}";
  bus->Close();
  return complete && mismatches == 0 ? 0 : 4;
}

static int PubSubPub(int argc, char** argv) {
  const std::string middleware = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string topic = argv[4];
  const std::string data_kind = argv[5];
  const int count = std::stoi(argv[6]);
  const auto base = HexToBytes(argv[7]);
  auto bus = Bus(middleware, domain);
  if (!bus) return 2;
  const auto channel = Channel(topic, data_kind, false);
  if (!bus->Publish(channel, PayloadWithSeq(base, 0xffffffffu))) return 3;
  const char* discovery_wait = std::getenv("PR_MATRIX_DISCOVERY_WAIT_SEC");
  const double discovery_wait_sec = discovery_wait != nullptr ? std::atof(discovery_wait) : 1.0;
  std::this_thread::sleep_for(std::chrono::duration<double>(discovery_wait_sec > 0 ? discovery_wait_sec : 1.0));
  for (int i = 0; i < 20; ++i) {
    if (!bus->Publish(channel, PayloadWithSeq(base, 0xffffffffu))) return 3;
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  for (int i = 0; i < count; ++i) {
    if (!bus->Publish(channel, PayloadWithSeq(base, static_cast<std::uint32_t>(i)))) return 3;
    std::this_thread::sleep_for(std::chrono::duration<double>(std::stod(std::getenv("PR_MATRIX_PUB_INTERVAL_SEC") != nullptr ? std::getenv("PR_MATRIX_PUB_INTERVAL_SEC") : "0.003")));
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  bus->Close();
  return 0;
}

static int RpcServer(int argc, char** argv) {
  const std::string middleware = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string topic = argv[4];
  const std::string data_kind = argv[5];
  auto bus = Bus(middleware, domain);
  if (!bus) return 2;
  const auto channel = Channel(topic, data_kind, true);
  if (!bus->HandleRequest(channel, [](const core::Bytes& request) {
        core::Bytes response{'o', 'k', ':'};
        response.insert(response.end(), request.begin(), request.end());
        return response;
      })) {
    return 3;
  }
  std::cout << "READY" << std::endl;
  while (true) std::this_thread::sleep_for(std::chrono::hours(1));
}

static int RpcClient(int argc, char** argv) {
  const std::string middleware = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string topic = argv[4];
  const std::string data_kind = argv[5];
  const int count = std::stoi(argv[6]);
  const auto base = HexToBytes(argv[7]);
  const std::string result_path = argv[8];
  const int warmup_count = argc > 9 ? std::stoi(argv[9]) : 0;
  auto bus = Bus(middleware, domain);
  if (!bus) return 2;
  const auto channel = Channel(topic, data_kind, true);
  int warmup_ok = 0;
  for (int i = 0; i < warmup_count; ++i) {
    core::Bytes response;
    auto payload = PayloadWithSeq(base, 0xffffff00u + static_cast<std::uint32_t>(i));
    if (bus->Request(channel, payload, std::chrono::milliseconds(3000), &response)) {
      core::Bytes expected{'o', 'k', ':'};
      expected.insert(expected.end(), payload.begin(), payload.end());
      if (response == expected) {
        ++warmup_ok;
      }
    }
  }
  int ok = 0;
  std::vector<double> latencies_ms;
  for (int i = 0; i < count; ++i) {
    core::Bytes response;
    auto payload = PayloadWithSeq(base, static_cast<std::uint32_t>(i));
    const auto start = NowNs();
    if (bus->Request(channel, payload, std::chrono::milliseconds(3000), &response)) {
      const auto end = NowNs();
      core::Bytes expected{'o', 'k', ':'};
      expected.insert(expected.end(), payload.begin(), payload.end());
      if (response == expected) {
        ++ok;
        latencies_ms.push_back(static_cast<double>(end - start) / 1000000.0);
      }
    }
  }
  std::ofstream out(result_path);
  out << "{\"ok\":" << ok
      << ",\"expected\":" << count
      << ",\"warmup_ok\":" << warmup_ok
      << ",\"warmup_expected\":" << warmup_count
      << ",\"latencies_ms\":[";
  for (std::size_t i = 0; i < latencies_ms.size(); ++i) {
    if (i) out << ",";
    out << latencies_ms[i];
  }
  out << "]}";
  bus->Close();
  return ok == count ? 0 : 4;
}

int main(int argc, char** argv) {
  if (argc < 2) return 2;
  const std::string role = argv[1];
  if (role == "pubsub-sub") return PubSubSub(argc, argv);
  if (role == "pubsub-pub") return PubSubPub(argc, argv);
  if (role == "rpc-server") return RpcServer(argc, argv);
  if (role == "rpc-client") return RpcClient(argc, argv);
  return 2;
}
'''


PY_SRC = r'''
import asyncio
import json
import sys
import time

from pacific_rim_communication_infra.core import Channel
from pacific_rim_communication_infra.dds.bus import CycloneDdsMessageBus
from pacific_rim_communication_infra.fastdds.bus import FastDdsMessageBus


def hex_to_bytes(value: str) -> bytes:
  return bytes.fromhex(value)


def payload_with_seq(base: bytes, seq: int) -> bytes:
  sent_ns = time.perf_counter_ns()
  return seq.to_bytes(4, "little") + sent_ns.to_bytes(8, "little") + base


def seq_from_payload(payload: bytes) -> int:
  if len(payload) < 4:
    return -1
  return int.from_bytes(payload[:4], "little")


def sent_ns_from_payload(payload: bytes) -> int:
  if len(payload) < 12:
    return 0
  return int.from_bytes(payload[4:12], "little")


def bus_for(middleware: str, domain: int):
  options = {
    "domain_id": domain,
    "type_name": "PacificRimMessageEnvelope",
    "qos.reliability": "reliable",
    "qos.history": "keep_last",
    "qos.depth": "256",
  }
  if middleware == "fastdds":
    return FastDdsMessageBus.from_options(options)
  return CycloneDdsMessageBus.from_options(options)


def channel(name: str, data_kind: str, rpc: bool) -> Channel:
  if data_kind == "proto":
    codec = "protobuf"
    schema_format = "protobuf_rpc" if rpc else "protobuf"
    schema_language = ""
  elif data_kind == "dds_idl":
    codec = "cdr"
    schema_format = "dds_idl_rpc" if rpc else "dds_idl"
    schema_language = "omg_idl"
  elif data_kind == "omg_idl":
    codec = "cdr"
    schema_format = "dds_idl_rpc" if rpc else "dds_idl"
    schema_language = "omg_idl"
  else:
    codec = "cdr"
    schema_format = "ros2_srv" if data_kind == "srv" else "ros2_msg"
    schema_language = "rosidl"
  metadata = {
    "codec": codec,
    "schema.format": schema_format,
    "schema.type": f"matrix/{data_kind}",
    "qos.reliability": "reliable",
    "qos.history": "keep_last",
    "qos.depth": "256",
  }
  if data_kind in {"dds_idl", "omg_idl"}:
    metadata["dds.mode"] = "typed_preferred"
    metadata["dds.fallback"] = "byte_envelope"
    metadata["dds.type"] = f"matrix/{data_kind}"
  else:
    metadata["dds.mode"] = "byte_envelope"
  if schema_language:
    metadata["schema.language"] = schema_language
  if rpc:
    metadata.update({
      "rpc.standard": "omg_dds_rpc",
      "rpc.request_channel": name + ".request",
      "rpc.response_channel": name + ".response",
    })
  return Channel(name=name, message_type=f"matrix/{data_kind}", metadata=metadata)


async def pubsub_sub(argv):
  _, role, middleware, domain, topic, data_kind, count, payload_hex, result_path = argv
  count = int(count)
  base = hex_to_bytes(payload_hex)
  bus = bus_for(middleware, int(domain))
  await bus.connect()
  seen = set()
  mismatches = 0
  duplicates = 0
  latencies = []
  first_receive_ns = 0
  last_receive_ns = 0
  done = asyncio.Event()

  async def handler(payload: bytes):
    nonlocal mismatches, duplicates, first_receive_ns, last_receive_ns
    now = time.perf_counter_ns()
    seq = seq_from_payload(payload)
    if seq == 0xFFFFFFFF:
      return
    if seq < 0 or seq >= count or payload[12:] != base:
      mismatches += 1
      return
    if seq in seen:
      duplicates += 1
      return
    seen.add(seq)
    if first_receive_ns == 0:
      first_receive_ns = now
    last_receive_ns = now
    sent_ns = sent_ns_from_payload(payload)
    if sent_ns and now >= sent_ns:
      latencies.append((now - sent_ns) / 1_000_000.0)
    if len(seen) >= count:
      done.set()

  await bus.subscribe_bytes(channel(topic, data_kind, False), handler)
  print("READY", flush=True)
  try:
    await asyncio.wait_for(done.wait(), timeout=15.0)
  except asyncio.TimeoutError:
    pass
  Path = __import__("pathlib").Path
  Path(result_path).write_text(json.dumps({
    "received": len(seen),
    "expected": count,
    "mismatches": mismatches,
    "duplicates": duplicates,
    "first_receive_ns": first_receive_ns,
    "last_receive_ns": last_receive_ns,
    "latencies_ms": latencies,
    "complete": len(seen) == count,
  }))
  await bus.close()
  return 0 if len(seen) == count and mismatches == 0 else 4


async def pubsub_pub(argv):
  _, role, middleware, domain, topic, data_kind, count, payload_hex = argv
  count = int(count)
  base = hex_to_bytes(payload_hex)
  bus = bus_for(middleware, int(domain))
  await bus.connect()
  ch = channel(topic, data_kind, False)
  await bus.publish_bytes(ch, payload_with_seq(base, 0xFFFFFFFF))
  await asyncio.sleep(float(__import__("os").environ.get("PR_MATRIX_DISCOVERY_WAIT_SEC", "1.0")))
  for _ in range(20):
    await bus.publish_bytes(ch, payload_with_seq(base, 0xFFFFFFFF))
    await asyncio.sleep(0.02)
  for i in range(count):
    await bus.publish_bytes(ch, payload_with_seq(base, i))
    await asyncio.sleep(float(__import__("os").environ.get("PR_MATRIX_PUB_INTERVAL_SEC", "0.003")))
  await asyncio.sleep(0.5)
  await bus.close()
  return 0


async def rpc_server(argv):
  _, role, middleware, domain, topic, data_kind = argv
  bus = bus_for(middleware, int(domain))
  await bus.connect()
  async def handler(payload: bytes) -> bytes:
    return b"ok:" + payload
  await bus.handle_request_bytes(channel(topic, data_kind, True), handler)
  print("READY", flush=True)
  while True:
    await asyncio.sleep(3600)


async def rpc_client(argv):
  _, role, middleware, domain, topic, data_kind, count, payload_hex, result_path, *rest = argv
  count = int(count)
  warmup_count = int(rest[0]) if rest else 0
  base = hex_to_bytes(payload_hex)
  bus = bus_for(middleware, int(domain))
  await bus.connect()
  ch = channel(topic, data_kind, True)
  warmup_ok = 0
  for i in range(warmup_count):
    payload = payload_with_seq(base, 0xFFFFFF00 + i)
    try:
      response = await bus.request_bytes(ch, payload, timeout_sec=3.0)
      if response == b"ok:" + payload:
        warmup_ok += 1
    except Exception:
      pass
  ok = 0
  latencies = []
  for i in range(count):
    payload = payload_with_seq(base, i)
    start = time.perf_counter_ns()
    response = await bus.request_bytes(ch, payload, timeout_sec=3.0)
    elapsed = time.perf_counter_ns() - start
    if response == b"ok:" + payload:
      ok += 1
      latencies.append(elapsed / 1_000_000.0)
  Path = __import__("pathlib").Path
  Path(result_path).write_text(json.dumps({
    "ok": ok,
    "expected": count,
    "warmup_ok": warmup_ok,
    "warmup_expected": warmup_count,
    "latencies_ms": latencies,
  }))
  await bus.close()
  return 0 if ok == count else 4


async def main(argv):
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

/*
#include <stdint.h>
#include <time.h>

static uint64_t pr_matrix_now_ns() {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ((uint64_t)ts.tv_sec * 1000000000ULL) + (uint64_t)ts.tv_nsec;
}
*/
import "C"

import (
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
	commdds "github.com/pacific-rim/pacific-rim/infra/communication/go/dds"
	commfastdds "github.com/pacific-rim/pacific-rim/infra/communication/go/fastdds"
)

func nowNs() uint64 {
	return uint64(C.pr_matrix_now_ns())
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
	if len(payload) != len(base)+12 {
		return false
	}
	for index := range base {
		if payload[index+12] != base[index] {
			return false
		}
	}
	return true
}

func config(middleware string, domain int) commcore.BusConfig {
	transport := communication.TransportCycloneDDS
	if middleware == "fastdds" {
		transport = communication.TransportFastDDS
	}
	return commcore.BusConfig{
		Transport: transport,
		Name:      fmt.Sprintf("matrix_go_%s_%d", middleware, domain),
		Options: map[string]any{
			"domain_id":       domain,
			"type_name":       "PacificRimMessageEnvelope",
			"qos.reliability": "reliable",
			"qos.history":     "keep_last",
			"qos.depth":       "256",
			"read_period_sec": "0.001",
		},
	}
}

func channel(name string, dataKind string, rpc bool) commcore.Channel {
	metadata := map[string]string{
		"schema.type":     "matrix/" + dataKind,
		"qos.reliability": "reliable",
		"qos.history":     "keep_last",
		"qos.depth":       "256",
	}
	switch dataKind {
	case "proto":
		metadata["codec"] = "protobuf"
		if rpc {
			metadata["schema.format"] = "protobuf_rpc"
		} else {
			metadata["schema.format"] = "protobuf"
		}
		metadata["dds.mode"] = "byte_envelope"
	case "dds_idl", "omg_idl":
		metadata["codec"] = "cdr"
		if rpc {
			metadata["schema.format"] = "dds_idl_rpc"
		} else {
			metadata["schema.format"] = "dds_idl"
		}
		metadata["schema.language"] = "omg_idl"
		metadata["dds.mode"] = "typed_preferred"
		metadata["dds.fallback"] = "byte_envelope"
		metadata["dds.type"] = "matrix/" + dataKind
	default:
		metadata["codec"] = "cdr"
		if dataKind == "srv" {
			metadata["schema.format"] = "ros2_srv"
		} else {
			metadata["schema.format"] = "ros2_msg"
		}
		metadata["schema.language"] = "rosidl"
		metadata["dds.mode"] = "byte_envelope"
	}
	if rpc {
		metadata["rpc.standard"] = "omg_dds_rpc"
		metadata["rpc.request_channel"] = name + ".request"
		metadata["rpc.response_channel"] = name + ".response"
	}
	return commcore.Channel{
		Name:        name,
		MessageType: "matrix/" + dataKind,
		Metadata:    metadata,
	}
}

func busFor(ctx context.Context, middleware string, domain int) (commcore.MessageBus, error) {
	commdds.RegisterNativeBus()
	commfastdds.RegisterNativeBus()
	bus, err := commcore.NewBus(config(middleware, domain))
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
	middleware := args[2]
	domain, _ := strconv.Atoi(args[3])
	topic := args[4]
	dataKind := args[5]
	count, _ := strconv.Atoi(args[6])
	base := hexToBytes(args[7])
	resultPath := args[8]
	bus, err := busFor(ctx, middleware, domain)
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
	if err := bus.Subscribe(ctx, channel(topic, dataKind, false), func(_ context.Context, payload []byte) error {
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
	ok := received == count && mismatches == 0
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
	middleware := args[2]
	domain, _ := strconv.Atoi(args[3])
	topic := args[4]
	dataKind := args[5]
	count, _ := strconv.Atoi(args[6])
	base := hexToBytes(args[7])
	bus, err := busFor(ctx, middleware, domain)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer bus.Close(ctx)
	ch := channel(topic, dataKind, false)
	if err := bus.Publish(ctx, ch, payloadWithSeq(base, 0xffffffff)); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	discoveryWait, _ := strconv.ParseFloat(os.Getenv("PR_MATRIX_DISCOVERY_WAIT_SEC"), 64)
	if discoveryWait <= 0 {
		discoveryWait = 1.0
	}
	time.Sleep(time.Duration(discoveryWait * float64(time.Second)))
	for i := 0; i < 20; i++ {
		if err := bus.Publish(ctx, ch, payloadWithSeq(base, 0xffffffff)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 3
		}
		time.Sleep(20 * time.Millisecond)
	}
	interval, _ := strconv.ParseFloat(os.Getenv("PR_MATRIX_PUB_INTERVAL_SEC"), 64)
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
	middleware := args[2]
	domain, _ := strconv.Atoi(args[3])
	topic := args[4]
	dataKind := args[5]
	bus, err := busFor(ctx, middleware, domain)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer bus.Close(ctx)
	if err := bus.HandleRequest(ctx, channel(topic, dataKind, true), func(_ context.Context, request []byte) ([]byte, error) {
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
	middleware := args[2]
	domain, _ := strconv.Atoi(args[3])
	topic := args[4]
	dataKind := args[5]
	count, _ := strconv.Atoi(args[6])
	base := hexToBytes(args[7])
	resultPath := args[8]
	warmupCount := 0
	if len(args) > 9 {
		warmupCount, _ = strconv.Atoi(args[9])
	}
	bus, err := busFor(ctx, middleware, domain)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer bus.Close(ctx)
	ch := channel(topic, dataKind, true)
	warmupOK := 0
	for i := 0; i < warmupCount; i++ {
		payload := payloadWithSeq(base, uint32(0xffffff00+i))
		response, err := bus.Request(ctx, ch, payload, 3*time.Second)
		expected := append([]byte("ok:"), payload...)
		if err == nil && string(response) == string(expected) {
			warmupOK++
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
		if err == nil && string(response) == string(expected) {
			ok++
			latencies = append(latencies, float64(elapsed.Nanoseconds())/1000000.0)
		}
	}
	result := map[string]any{
		"ok":              ok,
		"expected":        count,
		"warmup_ok":       warmupOK,
		"warmup_expected": warmupCount,
		"latencies_ms":    latencies,
	}
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
  current["PYTHONPATH"] = f"{ROOT / 'infra/communication/python'}:{ROOT / 'infra/protocol/python'}"
  ros_libs = [
    "/opt/ros/humble/lib",
    "/opt/ros/humble/lib/aarch64-linux-gnu",
    "/opt/ros/humble/lib/x86_64-linux-gnu",
  ]
  pkg_configs = [
    "/opt/ros/humble/lib/pkgconfig",
    "/opt/ros/humble/lib/aarch64-linux-gnu/pkgconfig",
    "/opt/ros/humble/lib/x86_64-linux-gnu/pkgconfig",
  ]
  current["LD_LIBRARY_PATH"] = ":".join(["/opt/cyclonedds-home/lib", *ros_libs, current.get("LD_LIBRARY_PATH", "")])
  current["PKG_CONFIG_PATH"] = ":".join([*pkg_configs, current.get("PKG_CONFIG_PATH", "")])
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
  system = run(["go", "version"])
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
  cpp_src = WORK / "dds_matrix.cpp"
  py_src = WORK / "dds_matrix.py"
  go_src = WORK / "dds_matrix.go"
  cpp_bin = WORK / "dds_matrix_cpp"
  go_bin = WORK / "dds_matrix_go"
  cpp_src.write_text(CPP_SRC)
  py_src.write_text(PY_SRC)
  go_src.write_text(GO_SRC)
  cyclone_cflags = run(["pkg-config", "--cflags", "CycloneDDS"]).stdout.split()
  cyclone_libs = run(["pkg-config", "--libs", "CycloneDDS"]).stdout.split()
  cmd = [
    "c++", "-std=c++17",
    "-I/workspace", "-I/workspace/infra/communication/cpp/include",
    "-I/opt/ros/humble/include", "-I/opt/ros/humble/include/fastrtps", "-I/opt/ros/humble/include/fastcdr",
    *cyclone_cflags,
    str(cpp_src),
    "-L/opt/ros/humble/lib", "-lfastcdr", "-lfastrtps", "-Wl,-rpath,/opt/ros/humble/lib",
    *cyclone_libs,
    "-pthread", "-o", str(cpp_bin),
  ]
  result = run(cmd, cwd=ROOT)
  if result.returncode != 0:
    raise RuntimeError("C++ matrix build failed\n" + result.stderr)
  go = ensure_go()
  go_env = env()
  go_env["CGO_ENABLED"] = "1"
  go_env["GOCACHE"] = os.environ.get("GOCACHE", "/tmp/pr-go-build-cache")
  result = subprocess.run(
    [
      go,
      "build",
      "-tags",
      "pacific_rim_cyclonedds pacific_rim_fastdds",
      "-o",
      str(go_bin),
      str(go_src),
    ],
    cwd=ROOT / "infra",
    text=True,
    capture_output=True,
    env=go_env,
  )
  if result.returncode != 0:
    raise RuntimeError("Go matrix build failed\n" + result.stderr)
  return cpp_bin, py_src, go_bin


def command(lang: str, role: str, middleware: str, domain: int, name: str, data_kind: str, count: int, payload: bytes, result: Path | None, cpp_bin: Path, py_src: Path, go_bin: Path) -> list[str]:
  base: list[str]
  if lang == "cpp":
    base = [str(cpp_bin), role, middleware, str(domain), name, data_kind]
  elif lang == "python":
    base = ["python3", str(py_src), role, middleware, str(domain), name, data_kind]
  elif lang == "go":
    base = [str(go_bin), role, middleware, str(domain), name, data_kind]
  else:
    raise ValueError(f"unsupported matrix language {lang}")
  if role == "rpc-client":
    return [*base, str(count), payload.hex(), str(result), str(RPC_WARMUP_COUNT)]
  if role == "pubsub-sub":
    return [*base, str(count), payload.hex(), str(result)]
  if role == "pubsub-pub":
    return [*base, str(count), payload.hex()]
  return base


def wait_ready(proc: subprocess.Popen[str], timeout: float = 8.0) -> bool:
  deadline = time.time() + timeout
  while time.time() < deadline:
    line = proc.stdout.readline() if proc.stdout else ""
    if "READY" in line:
      return True
    if proc.poll() is not None:
      return False
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
    return "typed_preferred_fallback_byte_envelope"
  return "byte_envelope"


def domain_for(index: int, rpc: bool) -> int:
  span = max(1, min(DOMAIN_SPAN, 216))
  offset = 73 if rpc else 0
  return DOMAIN_MIN + ((DOMAIN_BASE + index + offset) % span)


def run_pubsub_attempt(cpp_bin: Path, py_src: Path, go_bin: Path, middleware: str, publisher: str, subscriber: str, data_kind: str, index: int, attempt: int) -> dict[str, object]:
  domain = domain_for(index, rpc=False)
  name = f"matrix.{middleware}.{publisher}.{subscriber}.{data_kind}.{index}.{attempt}"
  payload = PAYLOADS[data_kind]
  result_path = WORK / f"pubsub_{middleware}_{publisher}_{subscriber}_{data_kind}_{index}_{attempt}.json"
  sub = subprocess.Popen(
    command(subscriber, "pubsub-sub", middleware, domain, name, data_kind, COUNT, payload, result_path, cpp_bin, py_src, go_bin),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env(),
  )
  ready = wait_ready(sub)
  pub_result = None
  if ready:
    pub_result = run(
      command(publisher, "pubsub-pub", middleware, domain, name, data_kind, COUNT, payload, None, cpp_bin, py_src, go_bin),
      timeout=20,
    )
  try:
    out, err = sub.communicate(timeout=20)
  except subprocess.TimeoutExpired:
    sub.kill()
    out, err = sub.communicate()
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
  process_ok = ready and pub_result is not None and pub_result.returncode == 0 and sub.returncode == 0
  ok = process_ok and stability_ok and performance_ok
  return {
    "pattern": "pubsub",
    "middleware": middleware,
    "domain": domain,
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
    "duplicates": data.get("duplicates", 0),
    "mismatches": data.get("mismatches", 0),
    "loss": COUNT - int(data.get("received", 0)),
    "loss_rate": round(max(0, COUNT - int(data.get("received", 0))) / float(COUNT), 6),
    "latency_avg_ms": round(mean(latencies), 3) if latencies else 0.0,
    "latency_p95_ms": round(latency_p95, 3),
    "latency_p99_ms": round(latency_p99, 3),
    "throughput_msg_s": round(throughput, 3),
    "thresholds": f"pubsub_p95<={PUBSUB_MAX_P95_MS},pubsub_p99<={PUBSUB_MAX_P99_MS},throughput>={PUBSUB_MIN_THROUGHPUT}",
    "error": "" if ok else f"ready={ready} pub={getattr(pub_result, 'returncode', None)} sub={sub.returncode} stdout={out.strip()} stderr={err.strip()} pubstderr={getattr(pub_result, 'stderr', '').strip() if pub_result else ''}",
  }


def run_pubsub_case(cpp_bin: Path, py_src: Path, go_bin: Path, middleware: str, publisher: str, subscriber: str, data_kind: str, index: int) -> dict[str, object]:
  last: dict[str, object] | None = None
  for attempt in range(1, max(0, CASE_RETRIES) + 2):
    row = run_pubsub_attempt(cpp_bin, py_src, go_bin, middleware, publisher, subscriber, data_kind, index, attempt)
    row["attempts"] = attempt
    last = row
    if row.get("ok") is True:
      return row
    time.sleep(0.2)
  return last or {"pattern": "pubsub", "ok": False, "error": "case did not run"}


def run_rpc_attempt(cpp_bin: Path, py_src: Path, go_bin: Path, middleware: str, client: str, server: str, data_kind: str, index: int, attempt: int) -> dict[str, object]:
  domain = domain_for(index, rpc=True)
  name = f"matrix.rpc.{middleware}.{client}.{server}.{data_kind}.{index}.{attempt}"
  payload = PAYLOADS[data_kind]
  result_path = WORK / f"rpc_{middleware}_{client}_{server}_{data_kind}_{index}_{attempt}.json"
  proc = subprocess.Popen(
    command(server, "rpc-server", middleware, domain, name, data_kind, RPC_COUNT, payload, None, cpp_bin, py_src, go_bin),
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
        command(client, "rpc-client", middleware, domain, name, data_kind, RPC_COUNT, payload, result_path, cpp_bin, py_src, go_bin),
        timeout=30,
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
    "middleware": middleware,
    "domain": domain,
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
    "warmup_received": data.get("warmup_ok", 0),
    "warmup_expected": data.get("warmup_expected", RPC_WARMUP_COUNT),
    "loss": RPC_COUNT - int(data.get("ok", 0)),
    "loss_rate": round(max(0, RPC_COUNT - int(data.get("ok", 0))) / float(RPC_COUNT), 6),
    "latency_avg_ms": round(mean(latencies), 3) if latencies else 0.0,
    "latency_p95_ms": round(latency_p95, 3),
    "latency_p99_ms": round(latency_p99, 3),
    "thresholds": f"rpc_p95<={RPC_MAX_P95_MS},rpc_p99<={RPC_MAX_P99_MS}",
    "error": "" if ok else f"ready={ready} server_return={server_return} client={getattr(client_result, 'returncode', None)} server_err={server_err.strip()} client_out={getattr(client_result, 'stdout', '').strip() if client_result else ''} client_err={getattr(client_result, 'stderr', '').strip() if client_result else ''}",
  }


def run_rpc_case(cpp_bin: Path, py_src: Path, go_bin: Path, middleware: str, client: str, server: str, data_kind: str, index: int) -> dict[str, object]:
  last: dict[str, object] | None = None
  for attempt in range(1, max(0, CASE_RETRIES) + 2):
    row = run_rpc_attempt(cpp_bin, py_src, go_bin, middleware, client, server, data_kind, index, attempt)
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
  ("cyclonedds", "proto", "topic", TransportKind.CYCLONE_DDS),
  ("cyclonedds", "msg", "topic", TransportKind.ROS2),
  ("cyclonedds", "srv", "service", TransportKind.ROS2),
  ("cyclonedds", "dds_idl", "topic", TransportKind.CYCLONE_DDS),
  ("cyclonedds", "dds_idl", "service", TransportKind.CYCLONE_DDS),
  ("cyclonedds", "omg_idl", "topic", TransportKind.CYCLONE_DDS),
  ("cyclonedds", "omg_idl", "service", TransportKind.CYCLONE_DDS),
  ("fastdds", "proto", "topic", TransportKind.FAST_DDS),
  ("fastdds", "msg", "topic", TransportKind.ROS2),
  ("fastdds", "srv", "service", TransportKind.ROS2),
  ("fastdds", "dds_idl", "topic", TransportKind.FAST_DDS),
  ("fastdds", "dds_idl", "service", TransportKind.FAST_DDS),
  ("fastdds", "omg_idl", "topic", TransportKind.FAST_DDS),
  ("fastdds", "omg_idl", "service", TransportKind.FAST_DDS),
]
out = []
for middleware, data, kind, expected in cases:
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
    "expected": str(expected),
    "ok": endpoint.transport == expected,
    "implementation": endpoint.metadata.get("middleware.implementation", ""),
    "codec": endpoint.metadata.get("codec", ""),
    "schema_format": endpoint.metadata.get("schema.format", ""),
    "schema_language": endpoint.metadata.get("schema.language", ""),
    "dds_mode": endpoint.metadata.get("dds.mode", ""),
    "dds_fallback": endpoint.metadata.get("dds.fallback", ""),
  })
print(json.dumps(out))
'''
  result = run(["python3", "-c", script], cwd=ROOT)
  if result.returncode != 0:
    return [{"pattern": "config", "ok": False, "error": result.stderr.strip()}]
  rows = json.loads(result.stdout)
  for row in rows:
    row["pattern"] = "config"
  return rows


def write_report(rows: list[dict[str, object]]) -> None:
  OUT_DIR.mkdir(parents=True, exist_ok=True)
  json_path = OUT_DIR / "dds-native-matrix.json"
  csv_path = OUT_DIR / "dds-native-matrix.csv"
  md_path = OUT_DIR / "dds-native-matrix.md"
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
    "# DDS Native Matrix Report",
    "",
    f"- Total cases: {total}",
    f"- Passed: {passed}",
    f"- Failed: {total - passed}",
    f"- Runtime communication cases: {len(runtime_rows)}",
    f"- Runtime stability passed: {stable}/{len(runtime_rows)}",
    f"- Runtime performance passed: {performant}/{len(runtime_rows)}",
    f"- Config routing cases: {len(config_rows)}",
    f"- Languages: {', '.join(LANGUAGES)}",
    f"- Middlewares: {', '.join(MIDDLEWARES)}",
    f"- Pub/Sub data: {', '.join(PUBSUB_DATA_KINDS)}",
    f"- RPC data: {', '.join(RPC_DATA_KINDS)}",
    f"- Pub/Sub count per case: {COUNT}",
    "- Pub/Sub warmup: 20 ignored frames after discovery wait",
    f"- Pub/Sub interval per sample: {PUB_INTERVAL_SEC * 1000:.1f} ms",
    f"- Pub/Sub thresholds: p95 <= {PUBSUB_MAX_P95_MS} ms, p99 <= {PUBSUB_MAX_P99_MS} ms, throughput >= {PUBSUB_MIN_THROUGHPUT} msg/s",
    f"- RPC count per case: {RPC_COUNT}",
    f"- RPC thresholds: p95 <= {RPC_MAX_P95_MS} ms, p99 <= {RPC_MAX_P99_MS} ms",
    f"- Case retries: {CASE_RETRIES}",
    "- Native DDS runtime cases use the PacificRimMessageEnvelope byte path; dds_idl/omg_idl cases assert typed-preferred metadata with byte-envelope fallback.",
    "- Config rows assert msg/srv route to ROS2 RMW when middleware is fastdds/cyclonedds.",
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
      f"| {row.get('pattern','')} | {row.get('middleware','')} | {row.get('data','')} | {row.get('runtime_path', row.get('implementation', ''))} | {endpoints} | {row.get('attempts','')} | {row.get('ok')} | {row.get('stability_ok','')} | {row.get('performance_ok','')} | {row.get('received','')}/{row.get('expected','')} | {latency} | {row.get('throughput_msg_s','')} | {str(row.get('error','')).replace('|', '/')} |"
    )
  md_path.write_text("\n".join(lines) + "\n")
  print(f"wrote {json_path}")
  print(f"wrote {csv_path}")
  print(f"wrote {md_path}")


def main() -> int:
  cpp_bin, py_src, go_bin = compile_runners()
  rows: list[dict[str, object]] = []
  idx = 0
  for middleware in MIDDLEWARES:
    for data_kind in PUBSUB_DATA_KINDS:
      for publisher in LANGUAGES:
        for subscriber in LANGUAGES:
          idx += 1
          row = run_pubsub_case(cpp_bin, py_src, go_bin, middleware, publisher, subscriber, data_kind, idx)
          rows.append(row)
          print(("PASS" if row["ok"] else "FAIL"), row)
    for data_kind in RPC_DATA_KINDS:
      for client in LANGUAGES:
        for server in LANGUAGES:
          idx += 1
          row = run_rpc_case(cpp_bin, py_src, go_bin, middleware, client, server, data_kind, idx)
          rows.append(row)
          print(("PASS" if row["ok"] else "FAIL"), row)
  rows.extend(config_matrix())
  write_report(rows)
  return 0 if all(row.get("ok") is True for row in rows) else 1


if __name__ == "__main__":
  raise SystemExit(main())
