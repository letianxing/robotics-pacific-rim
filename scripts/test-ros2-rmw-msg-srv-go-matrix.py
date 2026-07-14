#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import os
import select
import shutil
import statistics
import subprocess
import sys
import tempfile
import textwrap
import time
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(os.environ.get("PR_MATRIX_ROOT", "/workspace")).resolve()
OUT_DIR = ROOT / "out/test-report"
WORK_ROOT = ROOT / "infra/out/ros2_rmw_msg_srv_go_matrix"
COMMON_BUILD = Path("/tmp/pr-rmw-msg-srv-common-build")
COMMON_INSTALL = Path("/tmp/pr-rmw-msg-srv-common-install")
COMMON_LOG = Path("/tmp/pr-rmw-msg-srv-common-log")
GO = Path(os.environ.get("PR_MATRIX_GO", str(ROOT / "infra/out/go-toolchain/go/bin/go")))
RCLGO_VERSION = "v0.0.0-20260225085354-508dd42245da"

OUT_DIR.mkdir(parents=True, exist_ok=True)
WORK_ROOT.mkdir(parents=True, exist_ok=True)
WORK = Path(tempfile.mkdtemp(prefix="run_", dir=WORK_ROOT))

LANGS = ("cpp", "python", "go")
RUNTIMES = ("ros2", "cyclonedds_rmw")
ROS2_MSG_PAYLOAD = b"common/msg/ProtoEnvelope rmw matrix fixture"
ROS2_SRV_PAYLOAD = b"common/srv/ProtoCall rmw request fixture"

CONTRACT_CASES = {
  "msg": {
    "contract_type": "msg",
    "pattern": "pubsub",
    "payload": ROS2_MSG_PAYLOAD,
  },
  "srv": {
    "contract_type": "srv",
    "pattern": "rpc",
    "payload": ROS2_SRV_PAYLOAD,
  },
}


CPP_SRC = r'''
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "infra/communication/cpp/ros2/proto_envelope_bus.hpp"

namespace communication = pacific_rim::communication;
namespace core = pacific_rim::communication::core;
namespace ros2 = pacific_rim::communication::ros2;

std::uint64_t NowNs() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count());
}

core::Bytes HexToBytes(const std::string& hex) {
  core::Bytes out;
  out.reserve(hex.size() / 2);
  for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
    out.push_back(static_cast<std::uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16)));
  }
  return out;
}

core::Bytes PayloadWithSeq(const core::Bytes& base, std::uint32_t seq) {
  core::Bytes out;
  out.reserve(base.size() + 4);
  out.push_back(static_cast<std::uint8_t>(seq & 0xff));
  out.push_back(static_cast<std::uint8_t>((seq >> 8) & 0xff));
  out.push_back(static_cast<std::uint8_t>((seq >> 16) & 0xff));
  out.push_back(static_cast<std::uint8_t>((seq >> 24) & 0xff));
  out.insert(out.end(), base.begin(), base.end());
  return out;
}

std::uint32_t SeqFromPayload(const core::Bytes& payload) {
  if (payload.size() < 4) return 0xffffffffu;
  return static_cast<std::uint32_t>(payload[0]) |
         (static_cast<std::uint32_t>(payload[1]) << 8) |
         (static_cast<std::uint32_t>(payload[2]) << 16) |
         (static_cast<std::uint32_t>(payload[3]) << 24);
}

bool PayloadBodyEquals(const core::Bytes& payload, const core::Bytes& base) {
  return payload.size() == base.size() + 4 &&
         std::equal(base.begin(), base.end(), payload.begin() + 4);
}

core::Bytes EchoResponse(const core::Bytes& request) {
  core::Bytes out;
  out.reserve(request.size() + 4);
  out.push_back('r');
  out.push_back('e');
  out.push_back('s');
  out.push_back(':');
  out.insert(out.end(), request.begin(), request.end());
  return out;
}

std::string RmwFor(const std::string& runtime) {
  return runtime == "cyclonedds_rmw" ? "rmw_cyclonedds_cpp" : "rmw_fastrtps_cpp";
}

core::BusConfig ConfigFor(const std::string& runtime, int domain) {
  core::BusConfig config;
  config.transport = communication::TransportKind::kRos2;
  config.name = "rmw_cpp_" + runtime + "_" + std::to_string(domain);
  config.options["domain_id"] = std::to_string(domain);
  config.options["ros_domain_id"] = std::to_string(domain);
  config.options["rmw_implementation"] = RmwFor(runtime);
  config.options["mode"] = "native";
  config.options["qos.reliability"] = "reliable";
  config.options["qos.history"] = "keep_last";
  config.options["qos.depth"] = "256";
  config.options["queue_size"] = "256";
  return config;
}

core::Channel ChannelFor(const std::string& name, const std::string& contract_case) {
  core::Channel channel;
  channel.name = name;
  channel.metadata["logical_route"] = name;
  channel.metadata["qos.reliability"] = "reliable";
  channel.metadata["qos.history"] = "keep_last";
  channel.metadata["qos.depth"] = "256";
  channel.metadata["adapter"] = "ros2_proto_envelope";
  channel.metadata["ros2.adapter"] = "ros2_proto_envelope";
  if (contract_case == "msg") {
    channel.message_type = "common/msg/ProtoEnvelope";
    channel.metadata["schema.type"] = channel.message_type;
    channel.metadata["schema.format"] = "ros2_msg";
    channel.metadata["codec"] = "cdr";
  } else {
    channel.message_type = "common/srv/ProtoCall";
    channel.metadata["schema.type"] = channel.message_type;
    channel.metadata["schema.format"] = "ros2_srv";
    channel.metadata["codec"] = "cdr";
  }
  return channel;
}

std::unique_ptr<core::MessageBus> CreateBus(const std::string& runtime, int domain) {
  ros2::RegisterRos2ProtoEnvelopeBus();
  auto config = ConfigFor(runtime, domain);
  auto bus = core::MessageBusRegistry::Instance().Create(config);
  if (!bus || !bus->Connect(config)) {
    std::cerr << "connect failed for " << runtime << " domain=" << domain << "\n";
    return nullptr;
  }
  return bus;
}

int PubSubSub(int argc, char** argv) {
  if (argc < 9) return 2;
  const std::string runtime = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string topic = argv[4];
  const std::string contract_case = argv[5];
  const int count = std::stoi(argv[6]);
  const core::Bytes base = HexToBytes(argv[7]);
  const std::string result_path = argv[8];
  auto bus = CreateBus(runtime, domain);
  if (!bus) return 1;
  auto channel = ChannelFor(topic, contract_case);
  std::mutex mutex;
  std::condition_variable cv;
  std::vector<bool> seen(static_cast<std::size_t>(count), false);
  int received = 0;
  int mismatches = 0;
  int duplicates = 0;
  std::uint64_t first_ns = 0;
  std::uint64_t last_ns = 0;
  if (!bus->Subscribe(channel, [&](const core::Bytes& payload) {
        const auto now = NowNs();
        std::lock_guard<std::mutex> lock(mutex);
        const auto seq = SeqFromPayload(payload);
        if (seq == 0xffffffffu) return;
        if (seq >= static_cast<std::uint32_t>(count) || !PayloadBodyEquals(payload, base)) {
          mismatches++;
          return;
        }
        if (seen[seq]) {
          duplicates++;
          return;
        }
        seen[seq] = true;
        if (received == 0) first_ns = now;
        received++;
        last_ns = now;
        cv.notify_one();
      })) {
    std::cerr << "subscribe failed\n";
    return 1;
  }
  std::cout << "READY" << std::endl;
  std::unique_lock<std::mutex> lock(mutex);
  const bool ok = cv.wait_for(lock, std::chrono::seconds(20), [&]() { return received >= count; });
  std::ofstream file(result_path);
  file << "{\"received\":" << received
       << ",\"expected\":" << count
       << ",\"mismatches\":" << mismatches
       << ",\"duplicates\":" << duplicates
       << ",\"duration_ms\":" << (last_ns > first_ns ? (last_ns - first_ns) / 1000000.0 : 0.0)
       << "}\n";
  lock.unlock();
  bus->Close();
  return ok && mismatches == 0 ? 0 : 1;
}

int PubSubPub(int argc, char** argv) {
  if (argc < 9) return 2;
  const std::string runtime = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string topic = argv[4];
  const std::string contract_case = argv[5];
  const int count = std::stoi(argv[6]);
  const core::Bytes base = HexToBytes(argv[7]);
  const int interval_us = std::stoi(argv[8]);
  auto bus = CreateBus(runtime, domain);
  if (!bus) return 1;
  auto channel = ChannelFor(topic, contract_case);
  const auto warmup_payload = PayloadWithSeq(base, 0xffffffffu);
  const auto warmup_deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2500);
  while (std::chrono::steady_clock::now() < warmup_deadline) {
    if (!bus->Publish(channel, warmup_payload)) return 1;
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  const auto start = NowNs();
  for (int i = 0; i < count; ++i) {
    if (!bus->Publish(channel, PayloadWithSeq(base, static_cast<std::uint32_t>(i)))) return 1;
    if (interval_us > 0) std::this_thread::sleep_for(std::chrono::microseconds(interval_us));
  }
  const auto end = NowNs();
  std::this_thread::sleep_for(std::chrono::milliseconds(800));
  std::cout << "{\"sent\":" << count << ",\"duration_ms\":" << ((end - start) / 1000000.0) << "}" << std::endl;
  bus->Close();
  return 0;
}

int RpcServer(int argc, char** argv) {
  if (argc < 7) return 2;
  const std::string runtime = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string service = argv[4];
  const std::string contract_case = argv[5];
  const int seconds = std::stoi(argv[6]);
  auto bus = CreateBus(runtime, domain);
  if (!bus) return 1;
  auto channel = ChannelFor(service, contract_case);
  if (!bus->HandleRequest(channel, [](const core::Bytes& request) {
        return EchoResponse(request);
      })) {
    std::cerr << "handle request failed\n";
    return 1;
  }
  std::cout << "READY" << std::endl;
  std::this_thread::sleep_for(std::chrono::seconds(seconds));
  bus->Close();
  return 0;
}

int RpcClient(int argc, char** argv) {
  if (argc < 9) return 2;
  const std::string runtime = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string service = argv[4];
  const std::string contract_case = argv[5];
  const int count = std::stoi(argv[6]);
  const core::Bytes base = HexToBytes(argv[7]);
  const std::string result_path = argv[8];
  auto bus = CreateBus(runtime, domain);
  if (!bus) return 1;
  auto channel = ChannelFor(service, contract_case);
  core::Bytes warmup_response;
  bus->Request(channel, PayloadWithSeq(base, 0xffffffffu), std::chrono::milliseconds(5000), &warmup_response);
  std::vector<double> latencies_ms;
  int mismatches = 0;
  for (int i = 0; i < count; ++i) {
    auto payload = PayloadWithSeq(base, static_cast<std::uint32_t>(i));
    core::Bytes response;
    const auto start = NowNs();
    if (!bus->Request(channel, payload, std::chrono::milliseconds(5000), &response)) {
      std::cerr << "request failed at " << i << "\n";
      return 1;
    }
    const auto end = NowNs();
    latencies_ms.push_back((end - start) / 1000000.0);
    if (response != EchoResponse(payload)) mismatches++;
  }
  std::ofstream file(result_path);
  file << "{\"latencies_ms\":[";
  for (std::size_t i = 0; i < latencies_ms.size(); ++i) {
    if (i > 0) file << ",";
    file << latencies_ms[i];
  }
  file << "],\"count\":" << count << ",\"mismatches\":" << mismatches << "}\n";
  bus->Close();
  return mismatches == 0 ? 0 : 1;
}

int main(int argc, char** argv) {
  if (argc < 2) return 2;
  const std::string mode = argv[1];
  if (mode == "pubsub_sub") return PubSubSub(argc, argv);
  if (mode == "pubsub_pub") return PubSubPub(argc, argv);
  if (mode == "rpc_server") return RpcServer(argc, argv);
  if (mode == "rpc_client") return RpcClient(argc, argv);
  std::cerr << "unknown mode: " << mode << "\n";
  return 2;
}
'''


PY_WORKER = r'''
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from pacific_rim_communication_infra.core import Channel
from pacific_rim_communication_infra.ros2.envelope_bus import Ros2ProtoEnvelopeBus


def now_ns() -> int:
  return time.monotonic_ns()


def payload_with_seq(base: bytes, seq: int) -> bytes:
  return bytes([seq & 0xFF, (seq >> 8) & 0xFF, (seq >> 16) & 0xFF, (seq >> 24) & 0xFF]) + base


def seq_from_payload(payload: bytes) -> int:
  if len(payload) < 4:
    return -1
  return payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)


def payload_body_equals(payload: bytes, base: bytes) -> bool:
  return len(payload) == len(base) + 4 and payload[4:] == base


def echo_response(payload: bytes) -> bytes:
  return b"res:" + payload


def rmw_for(runtime: str) -> str:
  return "rmw_cyclonedds_cpp" if runtime == "cyclonedds_rmw" else "rmw_fastrtps_cpp"


def channel_for(name: str, contract_case: str) -> Channel:
  metadata = {
    "logical_route": name,
    "qos.reliability": "reliable",
    "qos.history": "keep_last",
    "qos.depth": "256",
    "adapter": "ros2_proto_envelope",
    "ros2.adapter": "ros2_proto_envelope",
  }
  if contract_case == "msg":
    message_type = "common/msg/ProtoEnvelope"
    metadata.update({"schema.type": message_type, "schema.format": "ros2_msg", "codec": "cdr"})
  else:
    message_type = "common/srv/ProtoCall"
    metadata.update({"schema.type": message_type, "schema.format": "ros2_srv", "codec": "cdr"})
  return Channel(name=name, message_type=message_type, metadata=metadata)


def bus_for(runtime: str, domain: int):
  os.environ["RMW_IMPLEMENTATION"] = rmw_for(runtime)
  options = {
    "domain_id": domain,
    "ros_domain_id": domain,
    "name": f"rmw_py_{runtime}_{domain}",
    "mode": "native",
    "queue_size": 256,
    "qos.reliability": "reliable",
    "qos.history": "keep_last",
    "qos.depth": "256",
  }
  return Ros2ProtoEnvelopeBus.from_options(options)


async def pubsub_sub(argv: list[str]) -> int:
  _, runtime, domain_s, topic, contract_case, count_s, payload_hex, result_path = argv
  domain, count = int(domain_s), int(count_s)
  base = bytes.fromhex(payload_hex)
  bus = bus_for(runtime, domain)
  await bus.connect()
  channel = channel_for(topic, contract_case)
  received = 0
  mismatches = 0
  duplicates = 0
  first_ns = 0
  last_ns = 0
  seen = [False] * count
  done = asyncio.get_running_loop().create_future()

  async def handler(payload: bytes) -> None:
    nonlocal received, mismatches, duplicates, first_ns, last_ns
    now = now_ns()
    seq = seq_from_payload(payload)
    if seq < 0 or seq == 0xFFFFFFFF:
      return
    if seq >= count or not payload_body_equals(payload, base):
      mismatches += 1
      return
    if seen[seq]:
      duplicates += 1
      return
    seen[seq] = True
    if received == 0:
      first_ns = now
    received += 1
    last_ns = now
    if received >= count and not done.done():
      done.set_result(None)

  await bus.subscribe_bytes(channel, handler)
  print("READY", flush=True)
  ok = True
  try:
    await asyncio.wait_for(done, timeout=20.0)
  except asyncio.TimeoutError:
    ok = False
  Path(result_path).write_text(json.dumps({
    "received": received,
    "expected": count,
    "mismatches": mismatches,
    "duplicates": duplicates,
    "duration_ms": ((last_ns - first_ns) / 1_000_000.0) if last_ns > first_ns else 0.0,
  }))
  await bus.close()
  return 0 if ok and mismatches == 0 else 1


async def pubsub_pub(argv: list[str]) -> int:
  _, runtime, domain_s, topic, contract_case, count_s, payload_hex, interval_us_s = argv
  domain, count, interval_us = int(domain_s), int(count_s), int(interval_us_s)
  base = bytes.fromhex(payload_hex)
  bus = bus_for(runtime, domain)
  await bus.connect()
  channel = channel_for(topic, contract_case)
  warmup_deadline = time.monotonic() + 2.5
  warmup_payload = payload_with_seq(base, 0xFFFFFFFF)
  while time.monotonic() < warmup_deadline:
    await bus.publish_bytes(channel, warmup_payload)
    await asyncio.sleep(0.02)
  started = now_ns()
  for i in range(count):
    await bus.publish_bytes(channel, payload_with_seq(base, i))
    if interval_us > 0:
      await asyncio.sleep(interval_us / 1_000_000.0)
  ended = now_ns()
  await asyncio.sleep(0.8)
  print(json.dumps({"sent": count, "duration_ms": (ended - started) / 1_000_000.0}), flush=True)
  await bus.close()
  return 0


async def rpc_server(argv: list[str]) -> int:
  _, runtime, domain_s, service, contract_case, seconds_s = argv
  domain, seconds = int(domain_s), int(seconds_s)
  bus = bus_for(runtime, domain)
  await bus.connect()
  await bus.handle_request_bytes(channel_for(service, contract_case), lambda payload: echo_response(bytes(payload)))
  print("READY", flush=True)
  await asyncio.sleep(seconds)
  await bus.close()
  return 0


async def rpc_client(argv: list[str]) -> int:
  _, runtime, domain_s, service, contract_case, count_s, payload_hex, result_path = argv
  domain, count = int(domain_s), int(count_s)
  base = bytes.fromhex(payload_hex)
  bus = bus_for(runtime, domain)
  await bus.connect()
  channel = channel_for(service, contract_case)
  try:
    await bus.request_bytes(channel, payload_with_seq(base, 0xFFFFFFFF), timeout_sec=5.0)
  except Exception:
    pass
  latencies_ms: list[float] = []
  mismatches = 0
  for i in range(count):
    payload = payload_with_seq(base, i)
    started = now_ns()
    response = await bus.request_bytes(channel, payload, timeout_sec=5.0)
    ended = now_ns()
    latencies_ms.append((ended - started) / 1_000_000.0)
    if response != echo_response(payload):
      mismatches += 1
  Path(result_path).write_text(json.dumps({
    "latencies_ms": latencies_ms,
    "count": count,
    "mismatches": mismatches,
  }))
  await bus.close()
  return 0 if mismatches == 0 else 1


async def main() -> int:
  mode = sys.argv[1]
  args = sys.argv[1:]
  if mode == "pubsub_sub":
    return await pubsub_sub(args)
  if mode == "pubsub_pub":
    return await pubsub_pub(args)
  if mode == "rpc_server":
    return await rpc_server(args)
  if mode == "rpc_client":
    return await rpc_client(args)
  print(f"unknown mode: {mode}", file=sys.stderr)
  return 2


raise SystemExit(asyncio.run(main()))
'''


GO_WORKER = r'''
package main

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
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/ros2"
	_ "pr_rmw_matrix/ros2msgs"
)

func nowNs() uint64 {
	return uint64(time.Now().UnixNano())
}

func payloadWithSeq(base []byte, seq uint32) []byte {
	out := make([]byte, 0, len(base)+4)
	out = append(out, byte(seq), byte(seq>>8), byte(seq>>16), byte(seq>>24))
	out = append(out, base...)
	return out
}

func seqFromPayload(payload []byte) uint32 {
	if len(payload) < 4 {
		return 0xffffffff
	}
	return uint32(payload[0]) | uint32(payload[1])<<8 | uint32(payload[2])<<16 | uint32(payload[3])<<24
}

func payloadBodyEquals(payload []byte, base []byte) bool {
	if len(payload) != len(base)+4 {
		return false
	}
	for i := range base {
		if payload[i+4] != base[i] {
			return false
		}
	}
	return true
}

func echoResponse(payload []byte) []byte {
	out := make([]byte, 0, len(payload)+4)
	out = append(out, 'r', 'e', 's', ':')
	out = append(out, payload...)
	return out
}

func rmwFor(runtime string) string {
	if runtime == "cyclonedds_rmw" {
		return "rmw_cyclonedds_cpp"
	}
	return "rmw_fastrtps_cpp"
}

func channelFor(name, contractCase string) core.Channel {
	metadata := map[string]string{
		"logical_route":   name,
		"qos.reliability": "reliable",
		"qos.history":     "keep_last",
		"qos.depth":       "256",
		"adapter":         "ros2_proto_envelope",
		"ros2.adapter":    "ros2_proto_envelope",
	}
	messageType := "common/msg/ProtoEnvelope"
	if contractCase == "srv" {
		messageType = "common/srv/ProtoCall"
		metadata["schema.format"] = "ros2_srv"
	} else {
		metadata["schema.format"] = "ros2_msg"
	}
	metadata["schema.type"] = messageType
	metadata["codec"] = "cdr"
	return core.Channel{Name: name, MessageType: messageType, Metadata: metadata}
}

func busFor(runtime string, domain int) (core.MessageBus, error) {
	ros2.Register()
	config := core.BusConfig{
		Transport: communication.TransportROS2,
		Name:      fmt.Sprintf("rmw_go_%s_%d", runtime, domain),
		Options: map[string]any{
			"domain_id":          domain,
			"ros_domain_id":      domain,
			"rmw_implementation": rmwFor(runtime),
			"mode":               "native",
			"queue_size":         256,
			"qos.reliability":    "reliable",
			"qos.history":        "keep_last",
			"qos.depth":          "256",
		},
	}
	bus, err := core.NewBus(config)
	if err != nil {
		return nil, err
	}
	if err := bus.Connect(context.Background()); err != nil {
		return nil, err
	}
	return bus, nil
}

func writeJSON(path string, value any) {
	data, _ := json.Marshal(value)
	_ = os.WriteFile(path, data, 0o644)
}

func pubsubSub(args []string) int {
	if len(args) < 8 {
		return 2
	}
	runtime := args[1]
	domain, _ := strconv.Atoi(args[2])
	topic := args[3]
	contractCase := args[4]
	count, _ := strconv.Atoi(args[5])
	base, _ := hex.DecodeString(args[6])
	resultPath := args[7]
	bus, err := busFor(runtime, domain)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer bus.Close(context.Background())
	channel := channelFor(topic, contractCase)
	var mu sync.Mutex
	seen := make([]bool, count)
	received := 0
	mismatches := 0
	duplicates := 0
	var firstNs uint64
	var lastNs uint64
	done := make(chan struct{})
	var closeOnce sync.Once
	err = bus.Subscribe(context.Background(), channel, func(_ context.Context, payload []byte) error {
		now := nowNs()
		seq := seqFromPayload(payload)
		if seq == 0xffffffff {
			return nil
		}
		mu.Lock()
		defer mu.Unlock()
		if seq >= uint32(count) || !payloadBodyEquals(payload, base) {
			mismatches++
			return nil
		}
		if seen[seq] {
			duplicates++
			return nil
		}
		seen[seq] = true
		if received == 0 {
			firstNs = now
		}
		received++
		lastNs = now
		if received >= count {
			closeOnce.Do(func() { close(done) })
		}
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println("READY")
	select {
	case <-done:
	case <-time.After(20 * time.Second):
	}
	mu.Lock()
	durationMs := 0.0
	if lastNs > firstNs {
		durationMs = float64(lastNs-firstNs) / 1_000_000.0
	}
	result := map[string]any{
		"received":    received,
		"expected":    count,
		"mismatches":  mismatches,
		"duplicates":  duplicates,
		"duration_ms": durationMs,
	}
	ok := received == count && mismatches == 0
	mu.Unlock()
	writeJSON(resultPath, result)
	if !ok {
		return 1
	}
	return 0
}

func pubsubPub(args []string) int {
	if len(args) < 8 {
		return 2
	}
	runtime := args[1]
	domain, _ := strconv.Atoi(args[2])
	topic := args[3]
	contractCase := args[4]
	count, _ := strconv.Atoi(args[5])
	base, _ := hex.DecodeString(args[6])
	intervalUs, _ := strconv.Atoi(args[7])
	bus, err := busFor(runtime, domain)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer bus.Close(context.Background())
	channel := channelFor(topic, contractCase)
	warmupPayload := payloadWithSeq(base, 0xffffffff)
	warmupDeadline := time.Now().Add(2500 * time.Millisecond)
	for time.Now().Before(warmupDeadline) {
		if err := bus.Publish(context.Background(), channel, warmupPayload); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		time.Sleep(20 * time.Millisecond)
	}
	start := nowNs()
	for i := 0; i < count; i++ {
		if err := bus.Publish(context.Background(), channel, payloadWithSeq(base, uint32(i))); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		if intervalUs > 0 {
			time.Sleep(time.Duration(intervalUs) * time.Microsecond)
		}
	}
	end := nowNs()
	time.Sleep(800 * time.Millisecond)
	fmt.Printf("{\"sent\":%d,\"duration_ms\":%f}\n", count, float64(end-start)/1_000_000.0)
	return 0
}

func rpcServer(args []string) int {
	if len(args) < 6 {
		return 2
	}
	runtime := args[1]
	domain, _ := strconv.Atoi(args[2])
	service := args[3]
	contractCase := args[4]
	seconds, _ := strconv.Atoi(args[5])
	bus, err := busFor(runtime, domain)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer bus.Close(context.Background())
	err = bus.HandleRequest(context.Background(), channelFor(service, contractCase), func(_ context.Context, payload []byte) ([]byte, error) {
		return echoResponse(payload), nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println("READY")
	time.Sleep(time.Duration(seconds) * time.Second)
	return 0
}

func rpcClient(args []string) int {
	if len(args) < 8 {
		return 2
	}
	runtime := args[1]
	domain, _ := strconv.Atoi(args[2])
	service := args[3]
	contractCase := args[4]
	count, _ := strconv.Atoi(args[5])
	base, _ := hex.DecodeString(args[6])
	resultPath := args[7]
	bus, err := busFor(runtime, domain)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer bus.Close(context.Background())
	channel := channelFor(service, contractCase)
	_, _ = bus.Request(context.Background(), channel, payloadWithSeq(base, 0xffffffff), 5*time.Second)
	latencies := make([]float64, 0, count)
	mismatches := 0
	for i := 0; i < count; i++ {
		payload := payloadWithSeq(base, uint32(i))
		start := nowNs()
		response, err := bus.Request(context.Background(), channel, payload, 5*time.Second)
		end := nowNs()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		latencies = append(latencies, float64(end-start)/1_000_000.0)
		expected := echoResponse(payload)
		if len(response) != len(expected) {
			mismatches++
			continue
		}
		for index := range response {
			if response[index] != expected[index] {
				mismatches++
				break
			}
		}
	}
	writeJSON(resultPath, map[string]any{"latencies_ms": latencies, "count": count, "mismatches": mismatches})
	if mismatches != 0 {
		return 1
	}
	return 0
}

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	switch os.Args[1] {
	case "pubsub_sub":
		os.Exit(pubsubSub(os.Args[1:]))
	case "pubsub_pub":
		os.Exit(pubsubPub(os.Args[1:]))
	case "rpc_server":
		os.Exit(rpcServer(os.Args[1:]))
	case "rpc_client":
		os.Exit(rpcClient(os.Args[1:]))
	default:
		fmt.Fprintln(os.Stderr, "unknown mode:", os.Args[1])
		os.Exit(2)
	}
}
'''


@dataclass
class CaseResult:
  pattern: str
  contract_case: str
  contract_type: str
  runtime: str
  middleware_family: str
  implementation: str
  producer: str
  consumer: str
  payload_bytes: int
  count: int
  success: bool
  received: int = 0
  mismatches: int = 0
  duplicates: int = 0
  duration_ms: float = 0.0
  throughput_msg_s: float = 0.0
  p50_ms: float | None = None
  p95_ms: float | None = None
  p99_ms: float | None = None
  max_ms: float | None = None
  error: str = ""


def runtime_family(runtime: str) -> str:
  return "cyclonedds" if runtime == "cyclonedds_rmw" else "fastdds"


def runtime_implementation(runtime: str) -> str:
  return "rmw_cyclonedds_cpp" if runtime == "cyclonedds_rmw" else "rmw_fastrtps_cpp"


def env() -> dict[str, str]:
  value = os.environ.copy()
  value["PYTHONPATH"] = (
    str(ROOT / "infra/communication/python")
    + ":"
    + str(ROOT / "infra/protocol/python")
    + ":"
    + str(ROOT / "infra/trace/python")
    + ":"
    + str(ROOT / "infra/metric/python")
    + ":"
    + str(ROOT / "infra/otel/python")
  )
  value["LD_LIBRARY_PATH"] = "/opt/ros/humble/lib/aarch64-linux-gnu:/opt/ros/humble/lib:" + value.get("LD_LIBRARY_PATH", "")
  value["PKG_CONFIG_PATH"] = "/opt/ros/humble/lib/aarch64-linux-gnu/pkgconfig:/opt/ros/humble/lib/pkgconfig:" + value.get("PKG_CONFIG_PATH", "")
  return value


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
  return subprocess.run(cmd, text=True, capture_output=True, env=env(), **kwargs)


def wait_ready(proc: subprocess.Popen[str], timeout_sec: float = 12.0) -> tuple[bool, str]:
  deadline = time.time() + timeout_sec
  lines: list[str] = []
  assert proc.stdout is not None
  while time.time() < deadline:
    readable, _, _ = select.select([proc.stdout], [], [], max(0.0, min(0.1, deadline - time.time())))
    if readable:
      line = proc.stdout.readline()
      if line:
        lines.append(line)
        if "READY" in line:
          return True, "".join(lines)
    if proc.poll() is not None:
      break
  stderr = proc.stderr.read() if proc.stderr else ""
  return False, "".join(lines) + stderr


def shell_source_prefix() -> str:
  return (
    "set -euo pipefail; "
    "set +u; "
    "source /opt/ros/humble/setup.bash; "
    f"source {COMMON_INSTALL}/setup.bash; "
    "set -u; "
  )


def sourced_cmd(lang: str, paths: dict[str, Path], args: list[str]) -> list[str]:
  if lang == "cpp":
    command = subprocess.list2cmdline([str(paths["cpp"]), *args])
  elif lang == "python":
    command = subprocess.list2cmdline(["python3", str(paths["python"]), *args])
  else:
    command = subprocess.list2cmdline([str(paths["go"]), *args])
  return ["bash", "-lc", shell_source_prefix() + "exec " + command]


def compile_common_interfaces() -> None:
  script = textwrap.dedent(
    f"""
    set -euo pipefail
    set +u
    source /opt/ros/humble/setup.bash
    set -u
    colcon --log-base {COMMON_LOG} build \
      --merge-install \
      --build-base {COMMON_BUILD} \
      --install-base {COMMON_INSTALL} \
      --packages-select common \
      --event-handlers console_direct+
    """
  )
  result = run(["bash", "-lc", script], cwd=ROOT)
  if result.returncode != 0:
    raise RuntimeError("common interface build failed\n" + result.stdout + result.stderr)


def compile_cpp_worker() -> Path:
  cpp_root = WORK / "cpp_worker"
  cpp_build = WORK / "cpp_worker_build"
  cpp_root.mkdir(parents=True, exist_ok=True)
  (cpp_root / "contract_worker.cpp").write_text(CPP_SRC)
  (cpp_root / "CMakeLists.txt").write_text(
    textwrap.dedent(
      """
      cmake_minimum_required(VERSION 3.16)
      project(pr_rmw_msg_srv_matrix_cpp)

      set(CMAKE_CXX_STANDARD 17)
      set(CMAKE_CXX_STANDARD_REQUIRED ON)

      find_package(ament_cmake REQUIRED)
      find_package(rclcpp REQUIRED)
      find_package(common REQUIRED)

      add_executable(contract_worker contract_worker.cpp)
      target_include_directories(
        contract_worker
        PRIVATE
          /workspace
          /workspace/infra/communication/cpp/include
          /workspace/infra/metric/cpp/include
          /workspace/infra/otel/cpp/include
          /workspace/infra/trace/cpp/include
      )
      ament_target_dependencies(contract_worker rclcpp common)
      """
    )
  )
  script = textwrap.dedent(
    f"""
    {shell_source_prefix()}
    cmake -S {cpp_root} -B {cpp_build}
    cmake --build {cpp_build} --target contract_worker -- -j2
    """
  )
  result = run(["bash", "-lc", script], cwd=ROOT)
  if result.returncode != 0:
    raise RuntimeError("cpp worker build failed\n" + result.stdout + result.stderr)
  return cpp_build / "contract_worker"


def compile_python_worker() -> Path:
  py_worker = WORK / "contract_worker.py"
  py_worker.write_text(PY_WORKER)
  return py_worker


def compile_go_worker() -> Path:
  if not GO.exists():
    raise RuntimeError(f"Go toolchain not found at {GO}; expected the Docker matrix image bootstrap to provide it")
  go_root = WORK / "go_worker"
  go_root.mkdir(parents=True, exist_ok=True)
  (go_root / "main.go").write_text(GO_WORKER)
  script = textwrap.dedent(
    f"""
    set -euo pipefail
    cd {go_root}
    {GO} mod init pr_rmw_matrix
    {GO} mod edit -go=1.25.0
    {GO} mod edit -require=github.com/pacific-rim/pacific-rim/infra@v0.0.0
    {GO} mod edit -replace=github.com/pacific-rim/pacific-rim/infra=/workspace/infra
    {GO} get github.com/tiiuae/rclgo/cmd/rclgo-gen/cmd@{RCLGO_VERSION}
    {shell_source_prefix()}
    {GO} run github.com/tiiuae/rclgo/cmd/rclgo-gen generate \
      --dest-path ./ros2msgs \
      --message-module-prefix pr_rmw_matrix/ros2msgs \
      --cgo-flags-path ./ros2msgs/cgo-flags.env \
      --include-package-deps common
    {GO} mod tidy
    CGO_ENABLED=1 {GO} build -tags pacific_rim_ros2_rclgo -o {WORK / "go_contract_worker"} .
    """
  )
  result = run(["bash", "-lc", script], cwd=ROOT, timeout=180)
  if result.returncode != 0:
    raise RuntimeError("go worker build failed\n" + result.stdout + result.stderr)
  return WORK / "go_contract_worker"


def compile_workers() -> dict[str, Path]:
  return {
    "cpp": compile_cpp_worker(),
    "python": compile_python_worker(),
    "go": compile_go_worker(),
  }


def percentile(values: list[float], q: float) -> float:
  if not values:
    return 0.0
  ordered = sorted(values)
  index = min(len(ordered) - 1, max(0, int(round((q / 100.0) * (len(ordered) - 1)))))
  return ordered[index]


def safe_domain(base: int, index: int) -> int:
  candidate = base + index
  if 0 <= candidate <= 232:
    return candidate
  return 80 + ((candidate - 233) % 120)


def run_pubsub_case(
  paths: dict[str, Path],
  runtime: str,
  publisher: str,
  subscriber: str,
  payload: bytes,
  domain: int,
  count: int,
  interval_us: int,
) -> CaseResult:
  topic = f"pr_rmw_{runtime}_pubsub_{publisher}_{subscriber}_{domain}".replace("-", "_")
  result_path = WORK / f"pubsub_{runtime}_{publisher}_{subscriber}_{domain}.json"
  sub_args = ["pubsub_sub", runtime, str(domain), topic, "msg", str(count), payload.hex(), str(result_path)]
  pub_args = ["pubsub_pub", runtime, str(domain), topic, "msg", str(count), payload.hex(), str(interval_us)]
  sub = subprocess.Popen(
    sourced_cmd(subscriber, paths, sub_args),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env(),
    cwd=ROOT,
  )
  ready, detail = wait_ready(sub)
  if not ready:
    sub.kill()
    return CaseResult("pubsub", "msg", "msg", runtime, runtime_family(runtime), runtime_implementation(runtime), publisher, subscriber, len(payload), count, False, error="subscriber not ready: " + detail[-1200:])
  pub = run(sourced_cmd(publisher, paths, pub_args), cwd=ROOT, timeout=70)
  try:
    _, sub_err = sub.communicate(timeout=24)
  except subprocess.TimeoutExpired:
    sub.terminate()
    try:
      _, sub_err = sub.communicate(timeout=3)
    except subprocess.TimeoutExpired:
      sub.kill()
      _, sub_err = sub.communicate()
  data: dict[str, object] = {}
  if result_path.exists():
    try:
      data = json.loads(result_path.read_text())
    except Exception:
      data = {}
  if pub.returncode != 0 or sub.returncode != 0 or not data:
    return CaseResult(
      "pubsub",
      "msg",
      "msg",
      runtime,
      runtime_family(runtime),
      runtime_implementation(runtime),
      publisher,
      subscriber,
      len(payload),
      count,
      False,
      received=int(data.get("received") or 0),
      mismatches=int(data.get("mismatches") or 0),
      duplicates=int(data.get("duplicates") or 0),
      duration_ms=float(data.get("duration_ms") or 0.0),
      error=(f"pub_rc={pub.returncode} sub_rc={sub.returncode} data={data} " + pub.stdout + pub.stderr + sub_err)[-1800:],
    )
  duration_ms = float(data.get("duration_ms") or 0.0)
  received = int(data.get("received") or 0)
  mismatches = int(data.get("mismatches") or 0)
  duplicates = int(data.get("duplicates") or 0)
  throughput = received / (duration_ms / 1000.0) if duration_ms > 0 else 0.0
  return CaseResult(
    "pubsub",
    "msg",
    "msg",
    runtime,
    runtime_family(runtime),
    runtime_implementation(runtime),
    publisher,
    subscriber,
    len(payload),
    count,
    received == count and mismatches == 0,
    received=received,
    mismatches=mismatches,
    duplicates=duplicates,
    duration_ms=duration_ms,
    throughput_msg_s=throughput,
  )


def run_rpc_case(
  paths: dict[str, Path],
  runtime: str,
  client: str,
  server: str,
  payload: bytes,
  domain: int,
  count: int,
) -> CaseResult:
  service = f"pr_rmw_{runtime}_rpc_{client}_{server}_{domain}".replace("-", "_")
  result_path = WORK / f"rpc_{runtime}_{client}_{server}_{domain}.json"
  server_args = ["rpc_server", runtime, str(domain), service, "srv", "35"]
  client_args = ["rpc_client", runtime, str(domain), service, "srv", str(count), payload.hex(), str(result_path)]
  proc = subprocess.Popen(
    sourced_cmd(server, paths, server_args),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env(),
    cwd=ROOT,
  )
  ready, detail = wait_ready(proc)
  if not ready:
    proc.kill()
    return CaseResult("rpc", "srv", "srv", runtime, runtime_family(runtime), runtime_implementation(runtime), client, server, len(payload), count, False, error="server not ready: " + detail[-1200:])
  result = run(sourced_cmd(client, paths, client_args), cwd=ROOT, timeout=90)
  proc.terminate()
  try:
    _, server_err = proc.communicate(timeout=3)
  except subprocess.TimeoutExpired:
    proc.kill()
    _, server_err = proc.communicate()
  if result.returncode != 0 or not result_path.exists():
    return CaseResult(
      "rpc",
      "srv",
      "srv",
      runtime,
      runtime_family(runtime),
      runtime_implementation(runtime),
      client,
      server,
      len(payload),
      count,
      False,
      error=(result.stdout + result.stderr + server_err)[-1800:],
    )
  data = json.loads(result_path.read_text())
  latencies = [float(value) for value in data.get("latencies_ms", [])]
  mismatches = int(data.get("mismatches") or 0)
  duration_ms = sum(latencies)
  return CaseResult(
    "rpc",
    "srv",
    "srv",
    runtime,
    runtime_family(runtime),
    runtime_implementation(runtime),
    client,
    server,
    len(payload),
    count,
    len(latencies) == count and mismatches == 0,
    received=len(latencies),
    mismatches=mismatches,
    duration_ms=duration_ms,
    throughput_msg_s=(len(latencies) / (duration_ms / 1000.0)) if duration_ms > 0 else 0.0,
    p50_ms=percentile(latencies, 50),
    p95_ms=percentile(latencies, 95),
    p99_ms=percentile(latencies, 99),
    max_ms=max(latencies) if latencies else 0.0,
  )


def write_reports(results: list[CaseResult]) -> tuple[Path, Path, Path]:
  json_path = OUT_DIR / "ros2-rmw-msg-srv-go-matrix.json"
  csv_path = OUT_DIR / "ros2-rmw-msg-srv-go-matrix.csv"
  md_path = OUT_DIR / "ros2-rmw-msg-srv-go-matrix.md"
  rows = [{key: _report_safe(value) for key, value in result.__dict__.items()} for result in results]
  json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
  with csv_path.open("w", newline="") as file:
    writer = csv.DictWriter(
      file,
      fieldnames=list(rows[0].keys()) if rows else [],
      quoting=csv.QUOTE_MINIMAL,
    )
    writer.writeheader()
    writer.writerows(rows)

  total = len(results)
  passed = sum(1 for result in results if result.success)
  failures = [result for result in results if not result.success]
  pubsub = [result for result in results if result.pattern == "pubsub" and result.success]
  rpc = [result for result in results if result.pattern == "rpc" and result.success]
  lines = [
    "# ROS2 RMW msg/srv C++/Python/Go Matrix",
    "",
    f"- Generated: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}",
    "- Scope: language direction cpp/python/go x middleware implementation FastDDS RMW/CycloneDDS RMW x configured contract type msg/srv.",
    "- `msg` uses `pkg/idl/common/msg/ProtoEnvelope.msg`; `srv` uses `pkg/idl/common/srv/ProtoCall.srv`.",
    "- Go service coverage imports temporary rclgo bindings generated from the same `common` ROS2 package, matching scaffolded service typemap requirements.",
    f"- Result: {passed}/{total} cases passed.",
    "",
    "## Summary",
  ]
  if pubsub:
    lines.append(f"- Pub/sub: {len(pubsub)} passed; avg throughput {statistics.mean(r.throughput_msg_s for r in pubsub):.1f} msg/s; min throughput {min(r.throughput_msg_s for r in pubsub):.1f} msg/s.")
  if rpc:
    lines.append(f"- RPC: {len(rpc)} passed; avg p50 {statistics.mean(r.p50_ms or 0 for r in rpc):.3f} ms; avg p95 {statistics.mean(r.p95_ms or 0 for r in rpc):.3f} ms; max observed {max(r.max_ms or 0 for r in rpc):.3f} ms.")
  lines.extend(["", "## Summary By Runtime", ""])
  lines.append("| runtime | implementation | cases | passed | pubsub min msg/s | rpc avg p95 ms |")
  lines.append("|---|---|---:|---:|---:|---:|")
  for runtime in RUNTIMES:
    group = [result for result in results if result.runtime == runtime]
    group_pubsub = [result for result in group if result.pattern == "pubsub" and result.success]
    group_rpc = [result for result in group if result.pattern == "rpc" and result.success]
    lines.append(
      f"| {runtime} | {runtime_implementation(runtime)} | {len(group)} | {sum(1 for result in group if result.success)} | "
      f"{(min(r.throughput_msg_s for r in group_pubsub) if group_pubsub else 0.0):.1f} | "
      f"{(statistics.mean(r.p95_ms or 0 for r in group_rpc) if group_rpc else 0.0):.3f} |"
    )
  lines.extend(["", "## Failures"])
  if failures:
    for result in failures:
      lines.append(f"- {result.pattern} {result.runtime} {result.producer}->{result.consumer} {result.contract_case}: {_report_safe(result.error)[:400]}")
  else:
    lines.append("- None")
  lines.extend(["", "## Case Results", ""])
  lines.append("| pattern | contract | runtime | implementation | direction | bytes | count | ok | received | mismatches | duplicates | throughput msg/s | p50 ms | p95 ms | p99 ms | max ms |")
  lines.append("|---|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|")
  for result in results:
    lines.append(
      "| "
      + " | ".join(
        [
          result.pattern,
          result.contract_case,
          result.runtime,
          result.implementation,
          f"{result.producer}->{result.consumer}",
          str(result.payload_bytes),
          str(result.count),
          "PASS" if result.success else "FAIL",
          str(result.received),
          str(result.mismatches),
          str(result.duplicates),
          f"{result.throughput_msg_s:.1f}",
          "" if result.p50_ms is None else f"{result.p50_ms:.3f}",
          "" if result.p95_ms is None else f"{result.p95_ms:.3f}",
          "" if result.p99_ms is None else f"{result.p99_ms:.3f}",
          "" if result.max_ms is None else f"{result.max_ms:.3f}",
        ]
      )
      + " |"
    )
  md_path.write_text("\n".join(lines) + "\n")
  return json_path, csv_path, md_path


def _report_safe(value: object) -> object:
  if isinstance(value, str):
    return value.replace("\x00", "")
  return value


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--pubsub-count", type=int, default=80)
  parser.add_argument("--rpc-count", type=int, default=30)
  parser.add_argument("--interval-us", type=int, default=1000)
  parser.add_argument("--domain-base", type=int, default=160)
  parser.add_argument("--only-runtime", choices=RUNTIMES, default="")
  args = parser.parse_args()

  print(f"WORK={WORK}", flush=True)
  compile_common_interfaces()
  paths = compile_workers()
  results: list[CaseResult] = []
  index = 0
  runtimes = tuple(runtime for runtime in RUNTIMES if not args.only_runtime or runtime == args.only_runtime)
  for runtime in runtimes:
    for subscriber in LANGS:
      for publisher in LANGS:
        domain = safe_domain(args.domain_base, index)
        index += 1
        result = run_pubsub_case(
          paths,
          runtime,
          publisher,
          subscriber,
          CONTRACT_CASES["msg"]["payload"],
          domain,
          args.pubsub_count,
          args.interval_us,
        )
        results.append(result)
        print(f"{'PASS' if result.success else 'FAIL'} pubsub {runtime} {publisher}->{subscriber} msg", flush=True)
    for server in LANGS:
      for client in LANGS:
        domain = safe_domain(args.domain_base, index)
        index += 1
        result = run_rpc_case(
          paths,
          runtime,
          client,
          server,
          CONTRACT_CASES["srv"]["payload"],
          domain,
          args.rpc_count,
        )
        results.append(result)
        print(f"{'PASS' if result.success else 'FAIL'} rpc {runtime} {client}->{server} srv", flush=True)
  paths_out = write_reports(results)
  print("REPORTS " + " ".join(str(path) for path in paths_out), flush=True)
  return 0 if results and all(result.success for result in results) else 1


if __name__ == "__main__":
  try:
    raise SystemExit(main())
  finally:
    shutil.rmtree(WORK, ignore_errors=True)
