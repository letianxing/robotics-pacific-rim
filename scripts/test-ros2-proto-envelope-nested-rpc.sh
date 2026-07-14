#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${PR_MATRIX_IMAGE:-pacific-rim-matrix:humble}"

docker run --rm \
  -v "${ROOT}:/workspace" \
  -w /workspace \
  "${IMAGE}" \
  bash -lc 'set -euo pipefail
    set +u
    source /opt/ros/humble/setup.bash
    set -u
    colcon --log-base /tmp/pr-nested-rpc-log build \
      --merge-install \
      --build-base /tmp/pr-nested-rpc-build \
      --install-base /tmp/pr-nested-rpc-install \
      --packages-select common \
      --event-handlers console_direct+
    set +u
    source /tmp/pr-nested-rpc-install/setup.bash
    set -u
    RMW_IMPLEMENTATION_UNDER_TEST="${PR_RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
    if [ "${RMW_IMPLEMENTATION_UNDER_TEST}" = "rmw_cyclonedds_cpp" ] &&
       ! find /opt/ros/humble -name librmw_cyclonedds_cpp.so -print -quit | grep -q .; then
      RMW_IMPLEMENTATION_UNDER_TEST="rmw_fastrtps_cpp"
    fi
    mkdir -p /tmp/pr-nested-rpc-smoke
    cat >/tmp/pr-nested-rpc-smoke/CMakeLists.txt <<'"'"'CMAKE'"'"'
cmake_minimum_required(VERSION 3.8)
project(pr_nested_rpc_smoke)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(common REQUIRED)

add_executable(pr_nested_rpc main.cpp)
target_include_directories(
  pr_nested_rpc
  PRIVATE
    /workspace
    /workspace/infra/communication/cpp/include
    /workspace/infra/metric/cpp/include
    /workspace/infra/otel/cpp/include
    /workspace/infra/trace/cpp/include
)
ament_target_dependencies(pr_nested_rpc rclcpp common)
CMAKE
    cat >/tmp/pr-nested-rpc-smoke/main.cpp <<'"'"'CPP'"'"'
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>

#include "infra/communication/cpp/ros2/proto_envelope_bus.hpp"

namespace communication = pacific_rim::communication;
namespace core = pacific_rim::communication::core;
namespace ros2 = pacific_rim::communication::ros2;

core::Bytes BytesFromString(const std::string& value) {
  return core::Bytes(value.begin(), value.end());
}

std::string StringFromBytes(const core::Bytes& value) {
  return std::string(value.begin(), value.end());
}

int main() {
  const char* rmw = std::getenv("PR_RMW_IMPLEMENTATION_UNDER_TEST");
  if (rmw == nullptr || std::string(rmw).empty()) {
    rmw = "rmw_fastrtps_cpp";
  }
  setenv("RMW_IMPLEMENTATION", rmw, 1);
  communication::MiddlewareConfig config;
  config.transport = communication::TransportKind::kRos2;
  config.name = "nested_rpc";
  config.options["name"] = "nested_rpc_bus";
  config.options["domain_id"] = "77";
  config.options["rmw_implementation"] = rmw;

  ros2::Ros2ProtoEnvelopeBus bus(ros2::ConfigFromOptions(config));
  if (!bus.Connect(config)) {
    std::cerr << "connect failed\n";
    return 1;
  }

  core::Channel service_a;
  service_a.name = "/pr_nested_rpc/a";
  service_a.message_type = "test.Nested";
  service_a.metadata["adapter"] = "ros2_proto_envelope";
  core::Channel service_b;
  service_b.name = "/pr_nested_rpc/b";
  service_b.message_type = "test.Nested";
  service_b.metadata["adapter"] = "ros2_proto_envelope";

  if (!bus.HandleRequest(service_b, [](const core::Bytes& request) {
        return BytesFromString("b:" + StringFromBytes(request));
      })) {
    std::cerr << "register service b failed\n";
    return 1;
  }

  if (!bus.HandleRequest(service_a, [&bus, service_b](const core::Bytes& request) {
        core::Bytes downstream;
        if (!bus.Request(
                service_b,
                request,
                std::chrono::milliseconds(2000),
                &downstream)) {
          return BytesFromString("a:downstream-timeout");
        }
        return BytesFromString("a:" + StringFromBytes(downstream));
      })) {
    std::cerr << "register service a failed\n";
    return 1;
  }

  core::Bytes response;
  if (!bus.Request(
          service_a,
          BytesFromString("ping"),
          std::chrono::milliseconds(3000),
          &response)) {
    std::cerr << "request a failed\n";
    return 1;
  }

  const auto text = StringFromBytes(response);
  std::cout << "PASS ros2 proto nested rpc [" << rmw << "]: " << text << "\n";
  bus.Close();
  return text == "a:b:ping" ? 0 : 1;
}
CPP
    cmake -S /tmp/pr-nested-rpc-smoke -B /tmp/pr-nested-rpc-smoke-build
    cmake --build /tmp/pr-nested-rpc-smoke-build --target pr_nested_rpc -- -j2
    PR_RMW_IMPLEMENTATION_UNDER_TEST="${RMW_IMPLEMENTATION_UNDER_TEST}" \
      /tmp/pr-nested-rpc-smoke-build/pr_nested_rpc'
