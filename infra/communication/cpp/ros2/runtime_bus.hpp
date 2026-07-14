#pragma once

#include <chrono>
#include <memory>
#include <string>
#include <utility>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "infra/communication/cpp/ros2/proto_envelope_bus.hpp"
#include "infra/communication/cpp/ros2/typed_mapper_bus.hpp"

namespace pacific_rim::communication::ros2 {

class Ros2RuntimeBus final : public pacific_rim::communication::core::MessageBus {
 public:
  Ros2RuntimeBus()
      :
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_COMMON_PROTO_ENVELOPE
        envelope_(std::make_unique<Ros2ProtoEnvelopeBus>(ProtoEnvelopeBusConfig{})),
#else
        envelope_(std::make_unique<UnavailableRos2ProtoEnvelopeBus>()),
#endif
        typed_mapper_(std::make_unique<Ros2TypedMapperBus>()) {}

  TransportKind Kind() const override { return TransportKind::kRos2; }

  pacific_rim::communication::core::Capabilities GetCapabilities() const override {
    pacific_rim::communication::core::Capabilities capabilities;
    capabilities.publish_subscribe = true;
    capabilities.request_reply = true;
    return capabilities;
  }

  bool Connect(const pacific_rim::communication::core::BusConfig& config) override {
    return envelope_->Connect(config) && typed_mapper_->Connect(config);
  }

  void Close() override {
    typed_mapper_->Close();
    envelope_->Close();
  }

  bool Publish(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload) override {
    return BusFor(channel).Publish(channel, payload);
  }

  bool Subscribe(
      const pacific_rim::communication::core::Channel& channel,
      pacific_rim::communication::core::BytesHandler handler) override {
    return BusFor(channel).Subscribe(channel, std::move(handler));
  }

  bool Request(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) override {
    return BusFor(channel).Request(channel, payload, timeout, response);
  }

  bool HandleRequest(
      const pacific_rim::communication::core::Channel& channel,
      pacific_rim::communication::core::RequestHandler handler) override {
    return BusFor(channel).HandleRequest(channel, std::move(handler));
  }

 private:
  static std::string Adapter(const pacific_rim::communication::core::Channel& channel) {
    const auto iter = channel.metadata.find("adapter");
    if (iter != channel.metadata.end()) {
      return iter->second;
    }
    const auto ros2_iter = channel.metadata.find("ros2.adapter");
    return ros2_iter == channel.metadata.end() ? "" : ros2_iter->second;
  }

  pacific_rim::communication::core::MessageBus& BusFor(
      const pacific_rim::communication::core::Channel& channel) {
    return Adapter(channel) == "ros2_typed_mapper" ? *typed_mapper_ : *envelope_;
  }

  std::unique_ptr<pacific_rim::communication::core::MessageBus> envelope_;
  std::unique_ptr<pacific_rim::communication::core::MessageBus> typed_mapper_;
};

inline void RegisterRos2RuntimeBus() {
  pacific_rim::communication::core::MessageBusRegistry::Instance().Register(
      TransportKind::kRos2,
      [](const pacific_rim::communication::core::BusConfig&)
          -> std::unique_ptr<pacific_rim::communication::core::MessageBus> {
        return std::make_unique<Ros2RuntimeBus>();
      });
}

}  // namespace pacific_rim::communication::ros2
