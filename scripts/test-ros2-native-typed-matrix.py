#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import os
import select
import statistics
import subprocess
import tempfile
import textwrap
import time
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(os.environ.get("PR_MATRIX_ROOT", "/workspace")).resolve()
OUT_DIR = ROOT / "out/test-report"
WORK_ROOT = ROOT / "infra/out/ros2_native_typed_matrix"
GO = Path(os.environ.get("PR_MATRIX_GO", str(ROOT / "infra/out/go-toolchain/go/bin/go")))
RCLGO_VERSION = "v0.0.0-20260225085354-508dd42245da"

COUNT = int(os.environ.get("PR_NATIVE_ROS2_COUNT", "80"))
RPC_COUNT = int(os.environ.get("PR_NATIVE_ROS2_RPC_COUNT", "30"))
PUB_INTERVAL_US = int(os.environ.get("PR_NATIVE_ROS2_PUB_INTERVAL_US", "3000"))
LANGS = tuple(item.strip() for item in os.environ.get("PR_NATIVE_ROS2_LANGS", "cpp,python,go").split(",") if item.strip())
RUNTIMES = tuple(item.strip() for item in os.environ.get("PR_NATIVE_ROS2_RUNTIMES", "ros2,cyclonedds_rmw").split(",") if item.strip())

OUT_DIR.mkdir(parents=True, exist_ok=True)
WORK_ROOT.mkdir(parents=True, exist_ok=True)
WORK = Path(tempfile.mkdtemp(prefix="run_", dir=WORK_ROOT))


CPP_SRC = r'''
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rclcpp/rclcpp.hpp"
#include "std_msgs/msg/u_int64_multi_array.hpp"
#include "std_srvs/srv/set_bool.hpp"

using Packet = std_msgs::msg::UInt64MultiArray;
using SetBool = std_srvs::srv::SetBool;

static std::uint64_t NowNs() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count());
}

static std::string RmwFor(const std::string& runtime) {
  return runtime == "cyclonedds_rmw" ? "rmw_cyclonedds_cpp" : "rmw_fastrtps_cpp";
}

static rclcpp::NodeOptions NodeOptionsFor(const std::string& runtime, int domain) {
  setenv("RMW_IMPLEMENTATION", RmwFor(runtime).c_str(), 1);
  setenv("ROS_DOMAIN_ID", std::to_string(domain).c_str(), 1);
  rclcpp::InitOptions init_options;
  init_options.auto_initialize_logging(false);
  init_options.set_domain_id(static_cast<std::size_t>(domain));
  auto context = std::make_shared<rclcpp::Context>();
  context->init(0, nullptr, init_options);
  rclcpp::NodeOptions options;
  options.context(context);
  options.start_parameter_services(false);
  options.start_parameter_event_publisher(false);
  return options;
}

static rclcpp::QoS ReliableQos() {
  return rclcpp::QoS(rclcpp::KeepLast(256)).reliable();
}

static int PubSubSub(int argc, char** argv) {
  if (argc < 7) return 2;
  const std::string runtime = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string topic = argv[4];
  const int count = std::stoi(argv[5]);
  const std::string result_path = argv[6];
  auto node = std::make_shared<rclcpp::Node>(
      "pr_native_cpp_sub_" + std::to_string(domain),
      NodeOptionsFor(runtime, domain));
  rclcpp::ExecutorOptions executor_options;
  executor_options.context = node->get_node_base_interface()->get_context();
  auto executor = std::make_shared<rclcpp::executors::SingleThreadedExecutor>(
      executor_options);
  executor->add_node(node);
  std::mutex mutex;
  std::condition_variable cv;
  std::vector<bool> seen(static_cast<std::size_t>(count), false);
  std::vector<double> latencies_ms;
  int received = 0;
  int mismatches = 0;
  int duplicates = 0;
  std::uint64_t first_ns = 0;
  std::uint64_t last_ns = 0;
  auto sub = node->create_subscription<Packet>(
      topic,
      ReliableQos(),
      [&](Packet::SharedPtr msg) {
        const auto now = NowNs();
        if (msg->data.size() < 2) {
          std::lock_guard<std::mutex> lock(mutex);
          ++mismatches;
          return;
        }
        const auto seq = msg->data[0];
        if (seq == UINT64_MAX) return;
        std::lock_guard<std::mutex> lock(mutex);
        if (seq >= static_cast<std::uint64_t>(count)) {
          ++mismatches;
          return;
        }
        if (seen[static_cast<std::size_t>(seq)]) {
          ++duplicates;
          return;
        }
        seen[static_cast<std::size_t>(seq)] = true;
        if (received == 0) first_ns = now;
        ++received;
        last_ns = now;
        const auto sent_ns = msg->data[1];
        if (sent_ns > 0 && now >= sent_ns) {
          latencies_ms.push_back(static_cast<double>(now - sent_ns) / 1000000.0);
        }
        cv.notify_one();
      });
  std::thread spin_thread([&]() { executor->spin(); });
  std::cout << "READY" << std::endl;
  std::unique_lock<std::mutex> lock(mutex);
  const bool complete = cv.wait_for(
      lock,
      std::chrono::seconds(20),
      [&]() { return received >= count; });
  std::ofstream out(result_path);
  out << "{\"received\":" << received
      << ",\"expected\":" << count
      << ",\"mismatches\":" << mismatches
      << ",\"duplicates\":" << duplicates
      << ",\"first_receive_ns\":" << first_ns
      << ",\"last_receive_ns\":" << last_ns
      << ",\"latencies_ms\":[";
  for (std::size_t i = 0; i < latencies_ms.size(); ++i) {
    if (i > 0) out << ",";
    out << latencies_ms[i];
  }
  out << "],\"complete\":" << (complete ? "true" : "false") << "}\n";
  lock.unlock();
  executor->cancel();
  if (spin_thread.joinable()) spin_thread.join();
  rclcpp::shutdown(node->get_node_base_interface()->get_context());
  return complete && mismatches == 0 ? 0 : 4;
}

static int PubSubPub(int argc, char** argv) {
  if (argc < 7) return 2;
  const std::string runtime = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string topic = argv[4];
  const int count = std::stoi(argv[5]);
  const int interval_us = std::stoi(argv[6]);
  auto node = std::make_shared<rclcpp::Node>(
      "pr_native_cpp_pub_" + std::to_string(domain),
      NodeOptionsFor(runtime, domain));
  auto publisher = node->create_publisher<Packet>(topic, ReliableQos());
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2500);
  while (std::chrono::steady_clock::now() < deadline) {
    Packet warmup;
    warmup.data = {UINT64_MAX, NowNs()};
    publisher->publish(warmup);
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  for (int i = 0; i < count; ++i) {
    Packet packet;
    packet.data = {static_cast<std::uint64_t>(i), NowNs(), 0xC0FFEEu};
    publisher->publish(packet);
    if (interval_us > 0) {
      std::this_thread::sleep_for(std::chrono::microseconds(interval_us));
    }
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(500));
  rclcpp::shutdown(node->get_node_base_interface()->get_context());
  return 0;
}

static int RpcServer(int argc, char** argv) {
  if (argc < 6) return 2;
  const std::string runtime = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string service = argv[4];
  const int seconds = std::stoi(argv[5]);
  auto node = std::make_shared<rclcpp::Node>(
      "pr_native_cpp_srv_" + std::to_string(domain),
      NodeOptionsFor(runtime, domain));
  std::function<void(
      const std::shared_ptr<SetBool::Request>,
      std::shared_ptr<SetBool::Response>)> handler =
      [](const std::shared_ptr<SetBool::Request> request,
         std::shared_ptr<SetBool::Response> response) {
        response->success = request->data;
        response->message = request->data ? "true" : "false";
      };
  auto srv = node->create_service<SetBool>(service, handler);
  rclcpp::ExecutorOptions executor_options;
  executor_options.context = node->get_node_base_interface()->get_context();
  auto executor = std::make_shared<rclcpp::executors::SingleThreadedExecutor>(
      executor_options);
  executor->add_node(node);
  std::cout << "READY" << std::endl;
  auto done = std::make_shared<std::atomic_bool>(false);
  std::thread stopper([&]() {
    std::this_thread::sleep_for(std::chrono::seconds(seconds));
    done->store(true);
    executor->cancel();
  });
  while (!done->load()) {
    executor->spin_some();
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  if (stopper.joinable()) stopper.join();
  rclcpp::shutdown(node->get_node_base_interface()->get_context());
  return 0;
}

static int RpcClient(int argc, char** argv) {
  if (argc < 7) return 2;
  const std::string runtime = argv[2];
  const int domain = std::stoi(argv[3]);
  const std::string service = argv[4];
  const int count = std::stoi(argv[5]);
  const std::string result_path = argv[6];
  auto node = std::make_shared<rclcpp::Node>(
      "pr_native_cpp_client_" + std::to_string(domain),
      NodeOptionsFor(runtime, domain));
  auto client = node->create_client<SetBool>(service);
  if (!client->wait_for_service(std::chrono::seconds(8))) return 3;
  std::vector<double> latencies_ms;
  int ok = 0;
  for (int i = 0; i < count; ++i) {
    auto request = std::make_shared<SetBool::Request>();
    request->data = (i % 2) == 0;
    const auto start = NowNs();
    auto future = client->async_send_request(request);
    if (rclcpp::spin_until_future_complete(
            node, future, std::chrono::seconds(5)) !=
        rclcpp::FutureReturnCode::SUCCESS) {
      continue;
    }
    const auto end = NowNs();
    auto response = future.get();
    const bool expected = request->data;
    if (response->success == expected &&
        response->message == (expected ? "true" : "false")) {
      ++ok;
      latencies_ms.push_back(static_cast<double>(end - start) / 1000000.0);
    }
  }
  std::ofstream out(result_path);
  out << "{\"ok\":" << ok << ",\"expected\":" << count << ",\"latencies_ms\":[";
  for (std::size_t i = 0; i < latencies_ms.size(); ++i) {
    if (i > 0) out << ",";
    out << latencies_ms[i];
  }
  out << "]}\n";
  rclcpp::shutdown(node->get_node_base_interface()->get_context());
  return ok == count ? 0 : 4;
}

int main(int argc, char** argv) {
  if (argc < 2) return 2;
  const std::string mode = argv[1];
  if (mode == "pubsub_sub") return PubSubSub(argc, argv);
  if (mode == "pubsub_pub") return PubSubPub(argc, argv);
  if (mode == "rpc_server") return RpcServer(argc, argv);
  if (mode == "rpc_client") return RpcClient(argc, argv);
  return 2;
}
'''


PY_WORKER = r'''
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path

import rclpy
from rclpy.executors import SingleThreadedExecutor
from std_msgs.msg import UInt64MultiArray
from std_srvs.srv import SetBool


def now_ns() -> int:
  return time.monotonic_ns()


def rmw_for(runtime: str) -> str:
  return "rmw_cyclonedds_cpp" if runtime == "cyclonedds_rmw" else "rmw_fastrtps_cpp"


def init_node(runtime: str, domain: int, name: str):
  os.environ["RMW_IMPLEMENTATION"] = rmw_for(runtime)
  os.environ["ROS_DOMAIN_ID"] = str(domain)
  context = rclpy.context.Context()
  rclpy.init(args=None, context=context, domain_id=domain)
  node = rclpy.create_node(name, context=context)
  return context, node


def pubsub_sub(argv: list[str]) -> int:
  _, runtime, domain_s, topic, count_s, result_path = argv
  domain, count = int(domain_s), int(count_s)
  context, node = init_node(runtime, domain, f"pr_native_py_sub_{domain}")
  executor = SingleThreadedExecutor(context=context)
  executor.add_node(node)
  seen = [False] * count
  received = 0
  mismatches = 0
  duplicates = 0
  first_ns = 0
  last_ns = 0
  latencies_ms: list[float] = []
  done = threading.Event()

  def callback(msg: UInt64MultiArray) -> None:
    nonlocal received, mismatches, duplicates, first_ns, last_ns
    now = now_ns()
    if len(msg.data) < 2:
      mismatches += 1
      return
    seq = int(msg.data[0])
    if seq == 0xFFFFFFFFFFFFFFFF:
      return
    if seq >= count:
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
    sent_ns = int(msg.data[1])
    if sent_ns > 0 and now >= sent_ns:
      latencies_ms.append((now - sent_ns) / 1_000_000.0)
    if received >= count:
      done.set()

  node.create_subscription(UInt64MultiArray, topic, callback, 256)
  thread = threading.Thread(target=executor.spin, daemon=True)
  thread.start()
  print("READY", flush=True)
  done.wait(timeout=20.0)
  Path(result_path).write_text(json.dumps({
    "received": received,
    "expected": count,
    "mismatches": mismatches,
    "duplicates": duplicates,
    "first_receive_ns": first_ns,
    "last_receive_ns": last_ns,
    "latencies_ms": latencies_ms,
    "complete": received == count,
  }))
  executor.shutdown()
  thread.join(timeout=2.0)
  node.destroy_node()
  rclpy.shutdown(context=context)
  return 0 if received == count and mismatches == 0 else 4


def pubsub_pub(argv: list[str]) -> int:
  _, runtime, domain_s, topic, count_s, interval_us_s = argv
  domain, count, interval_us = int(domain_s), int(count_s), int(interval_us_s)
  context, node = init_node(runtime, domain, f"pr_native_py_pub_{domain}")
  publisher = node.create_publisher(UInt64MultiArray, topic, 256)
  deadline = time.monotonic() + 2.5
  while time.monotonic() < deadline:
    msg = UInt64MultiArray()
    msg.data = [0xFFFFFFFFFFFFFFFF, now_ns()]
    publisher.publish(msg)
    time.sleep(0.02)
  for i in range(count):
    msg = UInt64MultiArray()
    msg.data = [i, now_ns(), 0xC0FFEE]
    publisher.publish(msg)
    if interval_us > 0:
      time.sleep(interval_us / 1_000_000.0)
  time.sleep(0.5)
  node.destroy_node()
  rclpy.shutdown(context=context)
  return 0


def rpc_server(argv: list[str]) -> int:
  _, runtime, domain_s, service, seconds_s = argv
  domain, seconds = int(domain_s), int(seconds_s)
  context, node = init_node(runtime, domain, f"pr_native_py_srv_{domain}")

  def handle(request: SetBool.Request, response: SetBool.Response) -> SetBool.Response:
    response.success = request.data
    response.message = "true" if request.data else "false"
    return response

  node.create_service(SetBool, service, handle)
  executor = SingleThreadedExecutor(context=context)
  executor.add_node(node)
  thread = threading.Thread(target=executor.spin, daemon=True)
  thread.start()
  print("READY", flush=True)
  time.sleep(seconds)
  executor.shutdown()
  thread.join(timeout=2.0)
  node.destroy_node()
  rclpy.shutdown(context=context)
  return 0


def rpc_client(argv: list[str]) -> int:
  _, runtime, domain_s, service, count_s, result_path = argv
  domain, count = int(domain_s), int(count_s)
  context, node = init_node(runtime, domain, f"pr_native_py_client_{domain}")
  client = node.create_client(SetBool, service)
  if not client.wait_for_service(timeout_sec=8.0):
    return 3
  executor = SingleThreadedExecutor(context=context)
  executor.add_node(node)
  ok = 0
  latencies_ms: list[float] = []
  for i in range(count):
    request = SetBool.Request()
    request.data = (i % 2) == 0
    start = now_ns()
    future = client.call_async(request)
    executor.spin_until_future_complete(future, timeout_sec=5.0)
    if not future.done() or future.result() is None:
      continue
    end = now_ns()
    response = future.result()
    expected_message = "true" if request.data else "false"
    if response.success == request.data and response.message == expected_message:
      ok += 1
      latencies_ms.append((end - start) / 1_000_000.0)
  Path(result_path).write_text(json.dumps({"ok": ok, "expected": count, "latencies_ms": latencies_ms}))
  executor.shutdown()
  node.destroy_node()
  rclpy.shutdown(context=context)
  return 0 if ok == count else 4


def main() -> int:
  mode = sys.argv[1]
  args = sys.argv[1:]
  if mode == "pubsub_sub":
    return pubsub_sub(args)
  if mode == "pubsub_pub":
    return pubsub_pub(args)
  if mode == "rpc_server":
    return rpc_server(args)
  if mode == "rpc_client":
    return rpc_client(args)
  return 2


raise SystemExit(main())
'''


GO_WORKER = r'''
package main

/*
#include <stdint.h>
#include <time.h>

static uint64_t pr_native_ros2_now_ns() {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ((uint64_t)ts.tv_sec * 1000000000ULL) + (uint64_t)ts.tv_nsec;
}
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/tiiuae/rclgo/pkg/rclgo"
	stdmsgs "pr_ros2_native_matrix/ros2msgs/std_msgs/msg"
	stdsrvs "pr_ros2_native_matrix/ros2msgs/std_srvs/srv"
)

func nowNs() uint64 {
	return uint64(C.pr_native_ros2_now_ns())
}

func rmwFor(runtime string) string {
	if runtime == "cyclonedds_rmw" {
		return "rmw_cyclonedds_cpp"
	}
	return "rmw_fastrtps_cpp"
}

func newNode(runtime string, domain int, name string) (*rclgo.Context, *rclgo.Node, error) {
	_ = os.Setenv("RMW_IMPLEMENTATION", rmwFor(runtime))
	_ = os.Setenv("ROS_DOMAIN_ID", strconv.Itoa(domain))
	args, _, err := rclgo.ParseArgs(nil)
	if err != nil {
		return nil, nil, err
	}
	opts := rclgo.NewDefaultContextOptions()
	opts.DomainID = uint(domain)
	ctx, err := rclgo.NewContextWithOpts(args, opts)
	if err != nil {
		return nil, nil, err
	}
	node, err := ctx.NewNode(name, "")
	if err != nil {
		_ = ctx.Close()
		return nil, nil, err
	}
	return ctx, node, nil
}

func writeJSON(path string, value any) {
	data, _ := json.Marshal(value)
	_ = os.WriteFile(path, data, 0o644)
}

func pubsubSub(args []string) int {
	runtime := args[1]
	domain, _ := strconv.Atoi(args[2])
	topic := args[3]
	count, _ := strconv.Atoi(args[4])
	resultPath := args[5]
	ctx, node, err := newNode(runtime, domain, fmt.Sprintf("pr_native_go_sub_%d", domain))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer ctx.Close()
	var mu sync.Mutex
	seen := make([]bool, count)
	received := 0
	mismatches := 0
	duplicates := 0
	firstNs := uint64(0)
	lastNs := uint64(0)
	latencies := []float64{}
	done := make(chan struct{})
	var once sync.Once
	sub, err := stdmsgs.NewUInt64MultiArraySubscription(node, topic, nil, func(msg *stdmsgs.UInt64MultiArray, _ *rclgo.MessageInfo, err error) {
		if err != nil || len(msg.Data) < 2 {
			mu.Lock()
			mismatches++
			mu.Unlock()
			return
		}
		now := nowNs()
		seq := msg.Data[0]
		if seq == ^uint64(0) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if seq >= uint64(count) {
			mismatches++
			return
		}
		if seen[int(seq)] {
			duplicates++
			return
		}
		seen[int(seq)] = true
		if received == 0 {
			firstNs = now
		}
		received++
		lastNs = now
		sentNs := msg.Data[1]
		if sentNs > 0 && now >= sentNs {
			latencies = append(latencies, float64(now-sentNs)/1_000_000.0)
		}
		if received >= count {
			once.Do(func() { close(done) })
		}
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	waitSet, err := ctx.NewWaitSet()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	waitSet.AddSubscriptions(sub.Subscription)
	spinCtx, cancel := context.WithCancel(context.Background())
	spinDone := make(chan error, 1)
	go func() { spinDone <- waitSet.Run(spinCtx) }()
	fmt.Println("READY")
	select {
	case <-done:
	case <-time.After(20 * time.Second):
	}
	cancel()
	<-spinDone
	_ = waitSet.Close()
	mu.Lock()
	result := map[string]any{
		"received":         received,
		"expected":         count,
		"mismatches":       mismatches,
		"duplicates":       duplicates,
		"first_receive_ns": firstNs,
		"last_receive_ns":  lastNs,
		"latencies_ms":     latencies,
		"complete":         received == count,
	}
	ok := received == count && mismatches == 0
	mu.Unlock()
	writeJSON(resultPath, result)
	if ok {
		return 0
	}
	return 4
}

func pubsubPub(args []string) int {
	runtime := args[1]
	domain, _ := strconv.Atoi(args[2])
	topic := args[3]
	count, _ := strconv.Atoi(args[4])
	intervalUs, _ := strconv.Atoi(args[5])
	ctx, node, err := newNode(runtime, domain, fmt.Sprintf("pr_native_go_pub_%d", domain))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer ctx.Close()
	pub, err := stdmsgs.NewUInt64MultiArrayPublisher(node, topic, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	deadline := time.Now().Add(2500 * time.Millisecond)
	for time.Now().Before(deadline) {
		_ = pub.Publish(&stdmsgs.UInt64MultiArray{Data: []uint64{^uint64(0), nowNs()}})
		time.Sleep(20 * time.Millisecond)
	}
	for i := 0; i < count; i++ {
		err = pub.Publish(&stdmsgs.UInt64MultiArray{Data: []uint64{uint64(i), nowNs(), 0xC0FFEE}})
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 3
		}
		if intervalUs > 0 {
			time.Sleep(time.Duration(intervalUs) * time.Microsecond)
		}
	}
	time.Sleep(500 * time.Millisecond)
	return 0
}

func rpcServer(args []string) int {
	runtime := args[1]
	domain, _ := strconv.Atoi(args[2])
	service := args[3]
	seconds, _ := strconv.Atoi(args[4])
	ctx, node, err := newNode(runtime, domain, fmt.Sprintf("pr_native_go_srv_%d", domain))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer ctx.Close()
	srv, err := stdsrvs.NewSetBoolService(node, service, nil, func(_ *rclgo.ServiceInfo, req *stdsrvs.SetBool_Request, sender stdsrvs.SetBoolServiceResponseSender) {
		msg := "false"
		if req.Data {
			msg = "true"
		}
		_ = sender.SendResponse(&stdsrvs.SetBool_Response{Success: req.Data, Message: msg})
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	waitSet, err := ctx.NewWaitSet()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	waitSet.AddServices(srv.Service)
	spinCtx, cancel := context.WithCancel(context.Background())
	spinDone := make(chan error, 1)
	go func() { spinDone <- waitSet.Run(spinCtx) }()
	fmt.Println("READY")
	time.Sleep(time.Duration(seconds) * time.Second)
	cancel()
	<-spinDone
	_ = waitSet.Close()
	return 0
}

func rpcClient(args []string) int {
	runtime := args[1]
	domain, _ := strconv.Atoi(args[2])
	service := args[3]
	count, _ := strconv.Atoi(args[4])
	resultPath := args[5]
	ctx, node, err := newNode(runtime, domain, fmt.Sprintf("pr_native_go_client_%d", domain))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	defer ctx.Close()
	client, err := stdsrvs.NewSetBoolClient(node, service, nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	waitSet, err := ctx.NewWaitSet()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	waitSet.AddClients(client.Client)
	spinCtx, cancel := context.WithCancel(context.Background())
	spinDone := make(chan error, 1)
	go func() { spinDone <- waitSet.Run(spinCtx) }()
	defer func() {
		cancel()
		<-spinDone
		_ = waitSet.Close()
	}()
	warmupDeadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(warmupDeadline) {
		reqCtx, reqCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, _, err = client.Send(reqCtx, &stdsrvs.SetBool_Request{Data: true})
		reqCancel()
		if err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	ok := 0
	latencies := []float64{}
	for i := 0; i < count; i++ {
		data := i%2 == 0
		start := nowNs()
		reqCtx, reqCancel := context.WithTimeout(context.Background(), 5*time.Second)
		resp, _, err := client.Send(reqCtx, &stdsrvs.SetBool_Request{Data: data})
		reqCancel()
		elapsed := nowNs() - start
		expectedMsg := "false"
		if data {
			expectedMsg = "true"
		}
		if err == nil && resp.Success == data && resp.Message == expectedMsg {
			ok++
			latencies = append(latencies, float64(elapsed)/1_000_000.0)
		}
	}
	writeJSON(resultPath, map[string]any{"ok": ok, "expected": count, "latencies_ms": latencies})
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
	case "pubsub_sub":
		os.Exit(pubsubSub(os.Args[1:]))
	case "pubsub_pub":
		os.Exit(pubsubPub(os.Args[1:]))
	case "rpc_server":
		os.Exit(rpcServer(os.Args[1:]))
	case "rpc_client":
		os.Exit(rpcClient(os.Args[1:]))
	default:
		os.Exit(2)
	}
}
'''


@dataclass
class CaseResult:
  pattern: str
  runtime: str
  middleware_family: str
  implementation: str
  producer: str
  consumer: str
  contract_type: str
  graph_type: str
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
    + value.get("PYTHONPATH", "")
  )
  value["LD_LIBRARY_PATH"] = "/opt/ros/humble/lib/aarch64-linux-gnu:/opt/ros/humble/lib:" + value.get("LD_LIBRARY_PATH", "")
  value["PKG_CONFIG_PATH"] = "/opt/ros/humble/lib/aarch64-linux-gnu/pkgconfig:/opt/ros/humble/lib/pkgconfig:" + value.get("PKG_CONFIG_PATH", "")
  return value


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
  return subprocess.run(cmd, text=True, capture_output=True, env=env(), **kwargs)


def shell_source_prefix() -> str:
  return (
    "set -euo pipefail; "
    "set +u; "
    "source /opt/ros/humble/setup.bash; "
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


def compile_cpp_worker() -> Path:
  cpp_root = WORK / "cpp_worker"
  cpp_build = WORK / "cpp_worker_build"
  cpp_root.mkdir(parents=True, exist_ok=True)
  (cpp_root / "native_worker.cpp").write_text(CPP_SRC)
  (cpp_root / "CMakeLists.txt").write_text(textwrap.dedent("""
    cmake_minimum_required(VERSION 3.16)
    project(pr_ros2_native_typed_matrix_cpp)

    set(CMAKE_CXX_STANDARD 17)
    set(CMAKE_CXX_STANDARD_REQUIRED ON)

    find_package(ament_cmake REQUIRED)
    find_package(rclcpp REQUIRED)
    find_package(std_msgs REQUIRED)
    find_package(std_srvs REQUIRED)

    add_executable(native_worker native_worker.cpp)
    ament_target_dependencies(native_worker rclcpp std_msgs std_srvs)
  """))
  result = run(["bash", "-lc", shell_source_prefix() + f"cmake -S {cpp_root} -B {cpp_build} && cmake --build {cpp_build} --target native_worker -- -j2"], cwd=ROOT, timeout=180)
  if result.returncode != 0:
    raise RuntimeError("cpp native worker build failed\n" + result.stdout + result.stderr)
  return cpp_build / "native_worker"


def compile_python_worker() -> Path:
  py_worker = WORK / "native_worker.py"
  py_worker.write_text(PY_WORKER)
  return py_worker


def compile_go_worker() -> Path:
  if not GO.exists():
    raise RuntimeError(f"Go toolchain not found at {GO}; expected the Docker matrix image bootstrap to provide it")
  go_root = WORK / "go_worker"
  go_root.mkdir(parents=True, exist_ok=True)
  (go_root / "main.go").write_text(GO_WORKER)
  script = textwrap.dedent(f"""
    set -euo pipefail
    cd {go_root}
    {GO} mod init pr_ros2_native_matrix
    {GO} mod edit -go=1.25.0
    {GO} get github.com/tiiuae/rclgo/cmd/rclgo-gen/cmd@{RCLGO_VERSION}
    {GO} get golang.org/x/tools/go/packages@v0.37.0
    {shell_source_prefix()}
    {GO} run github.com/tiiuae/rclgo/cmd/rclgo-gen generate \
      --dest-path ./ros2msgs \
      --message-module-prefix pr_ros2_native_matrix/ros2msgs \
      --cgo-flags-path ./ros2msgs/cgo-flags.env \
      std_msgs std_srvs
    {GO} mod tidy
    CGO_ENABLED=1 {GO} build -tags pacific_rim_ros2_rclgo -o {WORK / "go_native_worker"} .
  """)
  result = run(["bash", "-lc", script], cwd=ROOT, timeout=240)
  if result.returncode != 0:
    raise RuntimeError("go native worker build failed\n" + result.stdout + result.stderr)
  return WORK / "go_native_worker"


def compile_workers() -> dict[str, Path]:
  paths: dict[str, Path] = {}
  if "cpp" in LANGS:
    paths["cpp"] = compile_cpp_worker()
  if "python" in LANGS:
    paths["python"] = compile_python_worker()
  if "go" in LANGS:
    paths["go"] = compile_go_worker()
  return paths


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
  return 90 + ((candidate - 233) % 120)


def run_pubsub_case(paths: dict[str, Path], runtime: str, publisher: str, subscriber: str, domain: int) -> CaseResult:
  topic = f"pr_native_{runtime}_{publisher}_{subscriber}_{domain}".replace("-", "_")
  result_path = WORK / f"pubsub_{runtime}_{publisher}_{subscriber}_{domain}.json"
  sub_args = ["pubsub_sub", runtime, str(domain), topic, str(COUNT), str(result_path)]
  pub_args = ["pubsub_pub", runtime, str(domain), topic, str(COUNT), str(PUB_INTERVAL_US)]
  sub = subprocess.Popen(
    sourced_cmd(subscriber, paths, sub_args),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env(),
    cwd=ROOT,
  )
  ready, detail = wait_ready(sub)
  pub = None
  if ready:
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
  latencies = [float(value) for value in data.get("latencies_ms", [])]
  received = int(data.get("received") or 0)
  mismatches = int(data.get("mismatches") or 0)
  duplicates = int(data.get("duplicates") or 0)
  first_ns = float(data.get("first_receive_ns") or 0.0)
  last_ns = float(data.get("last_receive_ns") or 0.0)
  duration_ms = (last_ns - first_ns) / 1_000_000.0 if last_ns > first_ns else 0.0
  throughput = received / (duration_ms / 1000.0) if duration_ms > 0 else 0.0
  success = ready and pub is not None and pub.returncode == 0 and sub.returncode == 0 and received == COUNT and mismatches == 0 and duplicates == 0
  error = ""
  if not success:
    error = (f"ready={ready} detail={detail} pub_rc={getattr(pub, 'returncode', None)} sub_rc={sub.returncode} data={data} "
             f"pub_out={getattr(pub, 'stdout', '') if pub else ''} pub_err={getattr(pub, 'stderr', '') if pub else ''} sub_err={sub_err}")[-1800:]
  return CaseResult(
    pattern="pubsub",
    runtime=runtime,
    middleware_family=runtime_family(runtime),
    implementation=runtime_implementation(runtime),
    producer=publisher,
    consumer=subscriber,
    contract_type="msg",
    graph_type="std_msgs/msg/UInt64MultiArray",
    count=COUNT,
    success=success,
    received=received,
    mismatches=mismatches,
    duplicates=duplicates,
    duration_ms=duration_ms,
    throughput_msg_s=throughput,
    p50_ms=percentile(latencies, 50),
    p95_ms=percentile(latencies, 95),
    p99_ms=percentile(latencies, 99),
    max_ms=max(latencies) if latencies else 0.0,
    error=error,
  )


def run_rpc_case(paths: dict[str, Path], runtime: str, client: str, server: str, domain: int) -> CaseResult:
  service = f"pr_native_{runtime}_rpc_{client}_{server}_{domain}".replace("-", "_")
  result_path = WORK / f"rpc_{runtime}_{client}_{server}_{domain}.json"
  server_args = ["rpc_server", runtime, str(domain), service, "35"]
  client_args = ["rpc_client", runtime, str(domain), service, str(RPC_COUNT), str(result_path)]
  proc = subprocess.Popen(
    sourced_cmd(server, paths, server_args),
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env(),
    cwd=ROOT,
  )
  ready, detail = wait_ready(proc)
  result = None
  if ready:
    result = run(sourced_cmd(client, paths, client_args), cwd=ROOT, timeout=90)
  proc.terminate()
  try:
    _, server_err = proc.communicate(timeout=3)
  except subprocess.TimeoutExpired:
    proc.kill()
    _, server_err = proc.communicate()
  data: dict[str, object] = {}
  if result_path.exists():
    try:
      data = json.loads(result_path.read_text())
    except Exception:
      data = {}
  latencies = [float(value) for value in data.get("latencies_ms", [])]
  ok = int(data.get("ok") or 0)
  duration_ms = sum(latencies)
  success = ready and result is not None and result.returncode == 0 and ok == RPC_COUNT
  error = ""
  if not success:
    error = (f"ready={ready} detail={detail} client_rc={getattr(result, 'returncode', None)} data={data} "
             f"client_out={getattr(result, 'stdout', '') if result else ''} client_err={getattr(result, 'stderr', '') if result else ''} server_err={server_err}")[-1800:]
  return CaseResult(
    pattern="rpc",
    runtime=runtime,
    middleware_family=runtime_family(runtime),
    implementation=runtime_implementation(runtime),
    producer=client,
    consumer=server,
    contract_type="srv",
    graph_type="std_srvs/srv/SetBool",
    count=RPC_COUNT,
    success=success,
    received=ok,
    duration_ms=duration_ms,
    throughput_msg_s=(ok / (duration_ms / 1000.0)) if duration_ms > 0 else 0.0,
    p50_ms=percentile(latencies, 50),
    p95_ms=percentile(latencies, 95),
    p99_ms=percentile(latencies, 99),
    max_ms=max(latencies) if latencies else 0.0,
    error=error,
  )


def write_reports(results: list[CaseResult]) -> tuple[Path, Path, Path]:
  json_path = OUT_DIR / "ros2-native-typed-matrix.json"
  csv_path = OUT_DIR / "ros2-native-typed-matrix.csv"
  md_path = OUT_DIR / "ros2-native-typed-matrix.md"
  rows = [result.__dict__ for result in results]
  json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
  with csv_path.open("w", newline="") as file:
    writer = csv.DictWriter(file, fieldnames=list(rows[0].keys()) if rows else [])
    writer.writeheader()
    writer.writerows(rows)
  passed = sum(1 for row in results if row.success)
  pubsub = [row for row in results if row.pattern == "pubsub" and row.success]
  rpc = [row for row in results if row.pattern == "rpc" and row.success]
  lines = [
    "# ROS2 Native Typed C++/Python/Go Matrix",
    "",
    f"- Generated: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}",
    "- Scope: direct ROS2 typed ROSIDL graph, not protobuf envelope and not typed mapper.",
    "- Pub/sub graph type: `std_msgs/msg/UInt64MultiArray`.",
    "- RPC graph type: `std_srvs/srv/SetBool`.",
    f"- Result: {passed}/{len(results)} cases passed.",
    "",
    "## Summary",
  ]
  if pubsub:
    lines.append(
      f"- Pub/sub: {len(pubsub)} passed; avg throughput {statistics.mean(row.throughput_msg_s for row in pubsub):.1f} msg/s; "
      f"avg p95 {statistics.mean(row.p95_ms or 0 for row in pubsub):.3f} ms; max p99 {max(row.p99_ms or 0 for row in pubsub):.3f} ms."
    )
  if rpc:
    lines.append(
      f"- RPC: {len(rpc)} passed; avg p95 {statistics.mean(row.p95_ms or 0 for row in rpc):.3f} ms; "
      f"max p99 {max(row.p99_ms or 0 for row in rpc):.3f} ms."
    )
  lines.extend(["", "## Failures"])
  failures = [row for row in results if not row.success]
  if not failures:
    lines.append("- None")
  else:
    for row in failures:
      lines.append(f"- {row.pattern} {row.runtime} {row.producer}->{row.consumer}: {row.error}")
  lines.extend([
    "",
    "## Case Results",
    "",
    "| pattern | runtime | implementation | type | direction | count | ok | received | throughput msg/s | p50 ms | p95 ms | p99 ms | max ms |",
    "|---|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|",
  ])
  for row in results:
    lines.append(
      "| "
      + " | ".join([
        row.pattern,
        row.runtime,
        row.implementation,
        row.graph_type,
        f"{row.producer}->{row.consumer}",
        str(row.count),
        "PASS" if row.success else "FAIL",
        str(row.received),
        f"{row.throughput_msg_s:.1f}",
        f"{(row.p50_ms or 0):.3f}",
        f"{(row.p95_ms or 0):.3f}",
        f"{(row.p99_ms or 0):.3f}",
        f"{(row.max_ms or 0):.3f}",
      ])
      + " |"
    )
  md_path.write_text("\n".join(lines) + "\n")
  return json_path, csv_path, md_path


def main() -> int:
  paths = compile_workers()
  results: list[CaseResult] = []
  index = 0
  for runtime in RUNTIMES:
    for subscriber in LANGS:
      for publisher in LANGS:
        index += 1
        row = run_pubsub_case(paths, runtime, publisher, subscriber, safe_domain(90, index))
        results.append(row)
        print(("PASS" if row.success else "FAIL"), row.pattern, runtime, f"{publisher}->{subscriber}", flush=True)
    for server in LANGS:
      for client in LANGS:
        index += 1
        row = run_rpc_case(paths, runtime, client, server, safe_domain(140, index))
        results.append(row)
        print(("PASS" if row.success else "FAIL"), row.pattern, runtime, f"{client}->{server}", flush=True)
  reports = write_reports(results)
  print("REPORTS", *reports)
  return 0 if all(row.success for row in results) else 1


if __name__ == "__main__":
  raise SystemExit(main())
