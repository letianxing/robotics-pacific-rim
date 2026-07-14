#pragma once

#include <algorithm>
#include <cctype>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "infra/communication/cpp/core/secure_bus.hpp"
#include "infra/communication/cpp/core/security.hpp"

namespace pacific_rim::communication::core {

struct BoundEndpoint {
  std::string bus_name;
  MessageBus* bus{nullptr};
  Channel channel;
};

inline std::string NormalizedMetadataToken(
    const std::map<std::string, std::string>& metadata,
    const std::string& key) {
  const auto iter = metadata.find(key);
  if (iter == metadata.end()) {
    return "";
  }
  auto value = iter->second;
  std::replace(value.begin(), value.end(), '-', '_');
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

inline bool UsesRos2RuntimeBus(const Endpoint& endpoint) {
  if (endpoint.transport != TransportKind::kRos2) {
    return false;
  }
  const auto adapter = NormalizedMetadataToken(endpoint.metadata, "adapter").empty()
                           ? NormalizedMetadataToken(endpoint.metadata, "ros2.adapter")
                           : NormalizedMetadataToken(endpoint.metadata, "adapter");
  return adapter == "ros2_proto_envelope" || adapter == "ros2_typed_mapper";
}

inline std::string Ros2RuntimeAdapter(const Endpoint& endpoint) {
  if (endpoint.transport != TransportKind::kRos2) {
    return "";
  }
  const auto adapter = NormalizedMetadataToken(endpoint.metadata, "adapter");
  return adapter.empty() ? NormalizedMetadataToken(endpoint.metadata, "ros2.adapter") : adapter;
}

inline bool HasUnsupportedRos2RuntimeAdapter(const Endpoint& endpoint) {
  const auto adapter = Ros2RuntimeAdapter(endpoint);
  return !adapter.empty() && adapter != "ros2_proto_envelope" && adapter != "ros2_typed_mapper";
}

inline bool UsesRuntimeBus(const Endpoint& endpoint) {
  if (endpoint.transport == TransportKind::kInProcess) {
    return false;
  }
  if (endpoint.transport == TransportKind::kRos2) {
    return UsesRos2RuntimeBus(endpoint);
  }
  return true;
}

inline bool IsExplicitMiddlewareForEndpoint(
    const std::string& name,
    const Endpoint& endpoint) {
  const auto runtime_iter = endpoint.metadata.find("middleware.runtime");
  if (runtime_iter != endpoint.metadata.end()) {
    return runtime_iter->second == name;
  }
  const auto iter = endpoint.metadata.find("middleware");
  return iter != endpoint.metadata.end() && iter->second == name;
}

inline bool IsDefaultRos2RuntimeBusName(
    const std::string& name,
    const std::map<std::string, BusConfig>& middleware) {
  for (const auto& [candidate_name, config] : middleware) {
    if (config.transport == TransportKind::kRos2) {
      return candidate_name == name;
    }
  }
  return false;
}

inline bool UsesRos2RuntimeBusName(
    const std::string& name,
    const std::map<std::string, BusConfig>& middleware,
    const Endpoint& endpoint) {
  if (!UsesRos2RuntimeBus(endpoint)) {
    return false;
  }
  return IsExplicitMiddlewareForEndpoint(name, endpoint) ||
         (endpoint.metadata.find("middleware") == endpoint.metadata.end() &&
          endpoint.metadata.find("middleware.runtime") == endpoint.metadata.end() &&
          IsDefaultRos2RuntimeBusName(name, middleware));
}

inline bool ShouldCreateMiddlewareBus(
    const std::string& name,
    const std::map<std::string, BusConfig>& middleware,
    const std::vector<PubSubRoute>& pubsub_routes,
    const std::vector<RpcRoute>& rpc_routes,
    const BusConfig& config) {
  if (config.transport == TransportKind::kInProcess) {
    return false;
  }
  if (config.transport != TransportKind::kRos2) {
    return true;
  }
  for (const auto& route : pubsub_routes) {
    if (!route.enabled) {
      continue;
    }
    if (UsesRos2RuntimeBusName(name, middleware, route.publisher) ||
        UsesRos2RuntimeBusName(name, middleware, route.subscriber)) {
      return true;
    }
  }
  for (const auto& route : rpc_routes) {
    if (!route.enabled) {
      continue;
    }
    if (UsesRos2RuntimeBusName(name, middleware, route.client) ||
        UsesRos2RuntimeBusName(name, middleware, route.server)) {
      return true;
    }
  }
  return false;
}

class CommunicationFabric {
 public:
  static std::unique_ptr<CommunicationFabric> FromConfigs(
      std::map<std::string, BusConfig> middleware,
      std::vector<PubSubRoute> pubsub_routes,
      std::vector<RpcRoute> rpc_routes) {
    return FromConfigsWithSecurity(
        std::move(middleware),
        std::move(pubsub_routes),
        std::move(rpc_routes),
        nullptr);
  }

  static std::unique_ptr<CommunicationFabric> FromConfigsWithSecurity(
      std::map<std::string, BusConfig> middleware,
      std::vector<PubSubRoute> pubsub_routes,
      std::vector<RpcRoute> rpc_routes,
      std::shared_ptr<SecurityRuntime> security) {
    std::map<std::string, std::unique_ptr<MessageBus>> buses;
    for (const auto& [name, config] : middleware) {
      if (!ShouldCreateMiddlewareBus(
              name,
              middleware,
              pubsub_routes,
              rpc_routes,
              config)) {
        continue;
      }
      auto bus = MessageBusRegistry::Instance().Create(config);
      if (bus == nullptr) {
        throw std::runtime_error("communication middleware is not registered: " + name);
      }
      buses[name] = std::move(bus);
    }
    return std::unique_ptr<CommunicationFabric>(new CommunicationFabric(
        std::move(buses),
        std::move(middleware),
        std::move(pubsub_routes),
        std::move(rpc_routes),
        std::move(security)));
  }

  CommunicationFabric(CommunicationFabric&&) = default;
  CommunicationFabric& operator=(CommunicationFabric&&) = default;
  CommunicationFabric(const CommunicationFabric&) = delete;
  CommunicationFabric& operator=(const CommunicationFabric&) = delete;

  bool ConnectAll() {
    for (auto& [name, bus] : buses_) {
      auto config = bus_configs_.find(name);
      if (config != bus_configs_.end() && bus && !bus->Connect(config->second)) {
        return false;
      }
    }
    return true;
  }

  void CloseAll() {
    for (auto& [_, bus] : buses_) {
      if (bus) {
        bus->Close();
      }
    }
  }

  BoundEndpoint Publisher(const std::string& route_name) {
    return BindEndpoint(PubSubRouteFor(route_name).publisher);
  }

  BoundEndpoint Subscriber(const std::string& route_name) {
    return BindEndpoint(PubSubRouteFor(route_name).subscriber);
  }

  BoundEndpoint RpcClient(const std::string& route_name) {
    const auto& route = RpcRouteFor(route_name);
    auto bound = BindEndpoint(route.client);
    bound.channel = RequestChannelFromRoute(route);
    return bound;
  }

  BoundEndpoint RpcServer(const std::string& route_name) {
    return BindEndpoint(RpcRouteFor(route_name).server);
  }

 private:
  CommunicationFabric(
      std::map<std::string, std::unique_ptr<MessageBus>> buses,
      std::map<std::string, BusConfig> bus_configs,
      std::vector<PubSubRoute> pubsub_routes,
      std::vector<RpcRoute> rpc_routes,
      std::shared_ptr<SecurityRuntime> security)
      : buses_(std::move(buses)),
        bus_configs_(std::move(bus_configs)),
        security_(std::move(security)) {
    for (auto route : pubsub_routes) {
      if (route.enabled) {
        pubsub_routes_[route.name] = std::move(route);
      }
    }
    for (auto route : rpc_routes) {
      if (route.enabled) {
        rpc_routes_[route.name] = std::move(route);
      }
    }
  }

  const PubSubRoute& PubSubRouteFor(const std::string& route_name) const {
    const auto iter = pubsub_routes_.find(route_name);
    if (iter == pubsub_routes_.end()) {
      throw std::out_of_range("pubsub route is not configured: " + route_name);
    }
    return iter->second;
  }

  const RpcRoute& RpcRouteFor(const std::string& route_name) const {
    const auto iter = rpc_routes_.find(route_name);
    if (iter == rpc_routes_.end()) {
      throw std::out_of_range("rpc route is not configured: " + route_name);
    }
    return iter->second;
  }

  BoundEndpoint BindEndpoint(const Endpoint& endpoint) {
    if (HasUnsupportedRos2RuntimeAdapter(endpoint)) {
      throw std::runtime_error(
          "C++ ROS2 runtime adapter is not implemented: " +
          Ros2RuntimeAdapter(endpoint));
    }
    if (!UsesRuntimeBus(endpoint)) {
      return BoundEndpoint{"", nullptr, ChannelFromEndpoint(endpoint)};
    }
    const auto bus_name = BusNameFor(endpoint);
    auto iter = buses_.find(bus_name);
    if (iter == buses_.end()) {
      throw std::out_of_range("middleware bus is not connected: " + bus_name);
    }
    MessageBus* bus = iter->second.get();
    if (security_ != nullptr) {
      const auto config = bus_configs_.find(bus_name);
      if (config != bus_configs_.end()) {
        auto binding = security_->ResolveBinding(bus_name, config->second, endpoint);
        if (binding.profile != nullptr) {
          secure_buses_.push_back(std::make_unique<SecureMessageBus>(bus, std::move(binding)));
          bus = secure_buses_.back().get();
        }
      }
    }
    return BoundEndpoint{bus_name, bus, ChannelFromEndpoint(endpoint)};
  }

  std::string BusNameFor(const Endpoint& endpoint) const {
    const auto runtime_name = endpoint.metadata.find("middleware.runtime");
    if (runtime_name != endpoint.metadata.end() && !runtime_name->second.empty()) {
      return runtime_name->second;
    }
    const auto explicit_name = endpoint.metadata.find("middleware");
    if (explicit_name != endpoint.metadata.end() && !explicit_name->second.empty()) {
      return explicit_name->second;
    }
    for (const auto& [name, config] : bus_configs_) {
      if (config.transport == endpoint.transport) {
        return name;
      }
    }
    throw std::out_of_range("no middleware configured for endpoint");
  }

  std::map<std::string, std::unique_ptr<MessageBus>> buses_;
  std::map<std::string, BusConfig> bus_configs_;
  std::map<std::string, PubSubRoute> pubsub_routes_;
  std::map<std::string, RpcRoute> rpc_routes_;
  std::shared_ptr<SecurityRuntime> security_;
  std::vector<std::unique_ptr<MessageBus>> secure_buses_;
};

}  // namespace pacific_rim::communication::core
