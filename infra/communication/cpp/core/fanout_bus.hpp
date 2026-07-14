#pragma once

#include <chrono>
#include <cstddef>
#include <memory>
#include <utility>
#include <vector>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "pacific_rim/communication/contracts.hpp"

namespace pacific_rim::communication::core {

class FanoutBus final : public MessageBus {
 public:
  explicit FanoutBus(std::vector<std::unique_ptr<MessageBus>> buses, std::size_t primary_index = 0)
      : buses_(std::move(buses)), primary_index_(primary_index) {}

  TransportKind Kind() const override { return TransportKind::kInProcess; }

  Capabilities GetCapabilities() const override {
    Capabilities capabilities;
    capabilities.publish_subscribe = false;
    for (const auto& bus : buses_) {
      if (bus && bus->GetCapabilities().publish_subscribe) {
        capabilities.publish_subscribe = true;
      }
    }
    capabilities.request_reply =
        primary_index_ < buses_.size() && buses_[primary_index_] &&
        buses_[primary_index_]->GetCapabilities().request_reply;
    return capabilities;
  }

  bool Connect(const BusConfig& config) override {
    for (auto& bus : buses_) {
      if (bus && !bus->Connect(config)) {
        return false;
      }
    }
    return true;
  }

  void Close() override {
    for (auto& bus : buses_) {
      if (bus) {
        bus->Close();
      }
    }
  }

  bool Publish(const Channel& channel, const Bytes& payload) override {
    for (auto& bus : buses_) {
      if (bus && !bus->Publish(channel, payload)) {
        return false;
      }
    }
    return true;
  }

  bool Subscribe(const Channel& channel, BytesHandler handler) override {
    for (auto& bus : buses_) {
      if (bus && !bus->Subscribe(channel, handler)) {
        return false;
      }
    }
    return true;
  }

  bool Request(
      const Channel& channel,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) override {
    if (primary_index_ >= buses_.size() || !buses_[primary_index_]) {
      return false;
    }
    return buses_[primary_index_]->Request(channel, payload, timeout, response);
  }

  bool HandleRequest(const Channel& channel, RequestHandler handler) override {
    if (primary_index_ >= buses_.size() || !buses_[primary_index_]) {
      return false;
    }
    return buses_[primary_index_]->HandleRequest(channel, std::move(handler));
  }

 private:
  std::vector<std::unique_ptr<MessageBus>> buses_;
  std::size_t primary_index_{0};
};

}  // namespace pacific_rim::communication::core
