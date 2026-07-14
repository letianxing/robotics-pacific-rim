#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "infra/communication/cpp/nats/client.hpp"

namespace pacific_rim::communication::nats {

using Bytes = pacific_rim::communication::core::Bytes;
using BytesHandler = pacific_rim::communication::core::BytesHandler;

class NatsByteClient {
 public:
  virtual ~NatsByteClient() = default;

  virtual bool Connect(const NatsConfig& config) = 0;
  virtual void Close() = 0;
  virtual bool Publish(const std::string& subject, const Bytes& payload) = 0;
  virtual bool Subscribe(
      const std::string& subject,
      const std::string& queue_group,
      BytesHandler handler) = 0;
  virtual bool Request(
      const std::string& subject,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) = 0;
  virtual bool HandleRequest(
      const std::string& subject,
      const std::string& queue_group,
      pacific_rim::communication::core::RequestHandler handler) = 0;
};

using NatsByteClientFactory =
    std::function<std::unique_ptr<NatsByteClient>(const NatsConfig&)>;

inline void AssignStringOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    std::string* target);

inline void AssignIntOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    int* target);

inline NatsConfig ConfigFromOptions(
    const pacific_rim::communication::core::BusConfig& bus_config);

class NatsBus final : public pacific_rim::communication::core::MessageBus {
 public:
  NatsBus(NatsConfig config, std::unique_ptr<NatsByteClient> client)
      : config_(std::move(config)), client_(std::move(client)) {}

  TransportKind Kind() const override { return TransportKind::kNats; }

  pacific_rim::communication::core::Capabilities GetCapabilities() const override {
    pacific_rim::communication::core::Capabilities capabilities;
    capabilities.publish_subscribe = true;
    capabilities.request_reply = true;
    return capabilities;
  }

  bool Connect(const pacific_rim::communication::core::BusConfig& config) override {
    config_ = ConfigFromOptions(config);
    return client_ != nullptr && client_->Connect(config_);
  }

  void Close() override {
    if (client_ != nullptr) {
      client_->Close();
    }
  }

  bool Publish(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload) override {
    return client_ != nullptr && client_->Publish(channel.name, payload);
  }

  bool Subscribe(
      const pacific_rim::communication::core::Channel& channel,
      BytesHandler handler) override {
    return client_ != nullptr &&
           client_->Subscribe(channel.name, channel.queue_group, std::move(handler));
  }

  bool Request(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) override {
    return client_ != nullptr && client_->Request(channel.name, payload, timeout, response);
  }

  bool HandleRequest(
      const pacific_rim::communication::core::Channel& channel,
      pacific_rim::communication::core::RequestHandler handler) override {
    return client_ != nullptr &&
           client_->HandleRequest(channel.name, channel.queue_group, std::move(handler));
  }

 private:
  NatsConfig config_;
  std::unique_ptr<NatsByteClient> client_;
};

inline NatsConfig ConfigFromOptions(
    const pacific_rim::communication::core::BusConfig& bus_config) {
  NatsConfig config;
  if (!bus_config.name.empty()) {
    config.name = bus_config.name;
  }
  const auto& options = bus_config.options;
  AssignStringOption(options, "server_url", &config.server_url);
  AssignStringOption(options, "server", &config.server_url);
  AssignStringOption(options, "url", &config.server_url);
  AssignStringOption(options, "name", &config.name);
  AssignIntOption(options, "connect_timeout_ms", &config.connect_timeout_ms);
  AssignIntOption(options, "reconnect_wait_ms", &config.reconnect_wait_ms);
  AssignIntOption(options, "max_reconnect_attempts", &config.max_reconnect_attempts);
  return config;
}

inline pacific_rim::communication::core::MessageBusFactory NewBusFactory(
    NatsByteClientFactory factory) {
  return [factory = std::move(factory)](
             const pacific_rim::communication::core::BusConfig& config)
             -> std::unique_ptr<pacific_rim::communication::core::MessageBus> {
    NatsConfig nats_config = ConfigFromOptions(config);
    auto client = factory != nullptr ? factory(nats_config) : nullptr;
    if (client == nullptr) {
      return nullptr;
    }
    return std::make_unique<NatsBus>(nats_config, std::move(client));
  };
}

inline void RegisterBus(NatsByteClientFactory factory) {
  pacific_rim::communication::core::MessageBusRegistry::Instance().Register(
      TransportKind::kNats,
      NewBusFactory(std::move(factory)));
}

inline void AssignStringOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    std::string* target) {
  const auto iter = options.find(key);
  if (iter != options.end() && target != nullptr) {
    *target = iter->second;
  }
}

inline void AssignIntOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    int* target) {
  const auto iter = options.find(key);
  if (iter == options.end() || target == nullptr) {
    return;
  }
  try {
    *target = std::stoi(iter->second);
  } catch (...) {
  }
}

}  // namespace pacific_rim::communication::nats
