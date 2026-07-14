#pragma once

#include <functional>
#include <map>
#include <mutex>
#include <string>

#include "infra/communication/cpp/dds/bus.hpp"

namespace pacific_rim::communication::dds {

struct NativeDdsTypeSupport {
  std::function<bool(const CycloneDdsConfig&)> connect;
  std::function<void()> close;
  std::function<bool(const DdsTopicConfig&, const Bytes&)> publish;
  std::function<bool(const DdsSubscription&, BytesHandler)> subscribe;
};

class NativeDdsTypeRegistry {
 public:
  static NativeDdsTypeRegistry& Instance() {
    static NativeDdsTypeRegistry registry;
    return registry;
  }

  void Register(std::string type_name, NativeDdsTypeSupport support) {
    std::lock_guard<std::mutex> lock(mutex_);
    support_[std::move(type_name)] = std::move(support);
  }

  NativeDdsTypeSupport* Find(const std::string& type_name) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto iter = support_.find(type_name);
    if (iter == support_.end()) {
      return nullptr;
    }
    return &iter->second;
  }

  void CloseAll() {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto& [_, support] : support_) {
      if (support.close) {
        support.close();
      }
    }
  }

 private:
  std::mutex mutex_;
  std::map<std::string, NativeDdsTypeSupport> support_;
};

inline void RegisterNativeDdsTypeSupport(
    const std::string& type_name,
    NativeDdsTypeSupport support) {
  NativeDdsTypeRegistry::Instance().Register(type_name, std::move(support));
}

class NativeCycloneDdsByteClient final : public CycloneDdsByteClient {
 public:
  bool Connect(const CycloneDdsConfig& config) override {
    config_ = config;
    connected_ = true;
    return true;
  }

  void Close() override {
    NativeDdsTypeRegistry::Instance().CloseAll();
    connected_ = false;
  }

  bool Publish(const DdsTopicConfig& topic, const Bytes& payload) override {
    auto* support = SupportFor(topic.type_name);
    return support != nullptr && support->publish && support->publish(topic, payload);
  }

  bool PreparePublish(const DdsTopicConfig& topic) override {
    return SupportFor(topic.type_name) != nullptr;
  }

  bool Subscribe(const DdsSubscription& subscription, BytesHandler handler) override {
    auto* support = SupportFor(subscription.topic.type_name);
    return support != nullptr && support->subscribe &&
           support->subscribe(subscription, std::move(handler));
  }

  bool SupportsTypedDds(const std::string& type_name) override {
    return NativeDdsTypeRegistry::Instance().Find(type_name) != nullptr;
  }

 private:
  NativeDdsTypeSupport* SupportFor(const std::string& type_name) {
    if (!connected_) {
      return nullptr;
    }
    auto* support = NativeDdsTypeRegistry::Instance().Find(type_name);
    if (support != nullptr && support->connect) {
      if (!support->connect(config_)) {
        return nullptr;
      }
    }
    return support;
  }

  CycloneDdsConfig config_;
  bool connected_{false};
};

inline void RegisterNativeCycloneDdsBus() {
  RegisterBus([](const CycloneDdsConfig&) {
    return std::make_unique<NativeCycloneDdsByteClient>();
  });
}

}  // namespace pacific_rim::communication::dds
