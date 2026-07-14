#pragma once

#include <chrono>
#include <memory>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "infra/communication/cpp/core/security_codec.hpp"

namespace pacific_rim::communication::core {

class SecureMessageBus final : public MessageBus {
 public:
  SecureMessageBus(MessageBus* inner, SecurityBinding binding)
      : inner_(inner), codec_(std::move(binding)) {
    if (inner_ == nullptr) {
      throw std::invalid_argument("SecureMessageBus requires an inner bus");
    }
  }

  TransportKind Kind() const override { return inner_->Kind(); }

  Capabilities GetCapabilities() const override { return inner_->GetCapabilities(); }

  bool Connect(const BusConfig& config) override { return inner_->Connect(config); }

  void Close() override { inner_->Close(); }

  bool Publish(const Channel& channel, const Bytes& payload) override {
    return inner_->Publish(channel, codec_.Encrypt(payload, "publish"));
  }

  bool Subscribe(const Channel& channel, BytesHandler handler) override {
    return inner_->Subscribe(channel, [this, handler = std::move(handler)](const Bytes& payload) {
      handler(codec_.Decrypt(payload, "publish"));
    });
  }

  bool Request(
      const Channel& channel,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) override {
    Bytes encrypted_response;
    if (!inner_->Request(channel, codec_.Encrypt(payload, "rpc_request"), timeout, &encrypted_response)) {
      return false;
    }
    if (response != nullptr) {
      *response = codec_.Decrypt(encrypted_response, "rpc_response");
    }
    return true;
  }

  bool HandleRequest(const Channel& channel, RequestHandler handler) override {
    return inner_->HandleRequest(channel, [this, handler = std::move(handler)](const Bytes& payload) {
      const auto plaintext_request = codec_.Decrypt(payload, "rpc_request");
      const auto plaintext_response = handler(plaintext_request);
      return codec_.Encrypt(plaintext_response, "rpc_response");
    });
  }

 private:
  MessageBus* inner_;
  SecurityCodec codec_;
};

}  // namespace pacific_rim::communication::core
