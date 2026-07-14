#pragma once

#include <memory>
#include <stdexcept>
#include <string>

#include "infra/communication/cpp/dds/fastdds_native_byte_client.hpp"
#include "infra/communication/cpp/dds/native_byte_client.hpp"
#include "infra/communication/cpp/dds/ros2_serialized_client.hpp"
#include "infra/communication/cpp/core/routing.hpp"
#include "infra/communication/cpp/core/service_config.hpp"
#include "infra/communication/cpp/nats/native_client.hpp"
#include "infra/communication/cpp/ros2/runtime_bus.hpp"
#include "pacific_rim/otel/otlp_http.hpp"
#include "yaml-cpp/yaml.h"

namespace pacific_rim::communication::core {

struct CommunicationRuntime {
  std::unique_ptr<CommunicationFabric> fabric;
  std::string config_path;

  CommunicationRuntime(
      std::unique_ptr<CommunicationFabric> runtime_fabric,
      std::string runtime_config_path)
      : fabric(std::move(runtime_fabric)),
        config_path(std::move(runtime_config_path)) {}

  ~CommunicationRuntime() { Close(); }

  CommunicationRuntime(CommunicationRuntime&&) = default;
  CommunicationRuntime& operator=(CommunicationRuntime&&) = default;
  CommunicationRuntime(const CommunicationRuntime&) = delete;
  CommunicationRuntime& operator=(const CommunicationRuntime&) = delete;

  void Close() {
    if (fabric) {
      fabric->CloseAll();
    }
  }

  BoundEndpoint Publisher(const std::string& route_name) {
    return fabric->Publisher(route_name);
  }

  BoundEndpoint Subscriber(const std::string& route_name) {
    return fabric->Subscriber(route_name);
  }

  BoundEndpoint RpcClient(const std::string& route_name) {
    return fabric->RpcClient(route_name);
  }

  BoundEndpoint RpcServer(const std::string& route_name) {
    return fabric->RpcServer(route_name);
  }
};

inline CommunicationRuntime BootstrapCommunication(
    const std::string& config_path,
    const std::string& service_name) {
  nats::RegisterNativeNatsBus();
  dds::RegisterRos2SerializedCycloneDdsBus();
  dds::RegisterNativeByteEnvelopeCycloneDdsBus();
  dds::RegisterNativeByteEnvelopeFastDdsBus();
  ros2::RegisterRos2RuntimeBus();
  const YAML::Node root = MergePublicInterfaceRefs(YAML::LoadFile(config_path), config_path);
  auto config = LoadServiceCommunicationConfig(root, service_name);
  pacific_rim::otel::set_service_name(
      config.trace_service_name.empty() ? service_name : config.trace_service_name);
  auto security = std::make_shared<SecurityRuntime>(
      config.require_explicit_security_profile,
      std::move(config.security_profiles));
  auto fabric = CommunicationFabric::FromConfigsWithSecurity(
      std::move(config.middleware),
      std::move(config.pubsub_routes),
      std::move(config.rpc_routes),
      std::move(security));
  if (!fabric->ConnectAll()) {
    throw std::runtime_error("failed to connect communication fabric: " + config_path);
  }
  return CommunicationRuntime{std::move(fabric), config_path};
}

}  // namespace pacific_rim::communication::core
