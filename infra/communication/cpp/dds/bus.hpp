#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "infra/communication/cpp/core/message_bus.hpp"
#include "infra/communication/cpp/dds/cyclonedds_client.hpp"

namespace pacific_rim::communication::dds {

using Bytes = pacific_rim::communication::core::Bytes;
using BytesHandler = pacific_rim::communication::core::BytesHandler;

class CycloneDdsByteClient {
 public:
  virtual ~CycloneDdsByteClient() = default;

  virtual bool Connect(const CycloneDdsConfig& config) = 0;
  virtual void Close() = 0;
  virtual bool PreparePublish(const DdsTopicConfig& topic) = 0;
  virtual bool Publish(const DdsTopicConfig& topic, const Bytes& payload) = 0;
  virtual bool Subscribe(const DdsSubscription& subscription, BytesHandler handler) = 0;
  virtual std::function<void()> SubscribeManaged(
      const DdsSubscription& subscription,
      BytesHandler handler) {
    return Subscribe(subscription, std::move(handler)) ? []() {} : std::function<void()>{};
  }
  virtual bool WaitForSubscribers(
      const DdsTopicConfig&,
      std::chrono::milliseconds) {
    return true;
  }
  virtual bool WaitForPublishers(
      const DdsTopicConfig&,
      std::chrono::milliseconds) {
    return true;
  }
  virtual bool SupportsTypedDds(const std::string&) { return false; }
  virtual void ConfigureOptions(const std::map<std::string, std::string>&) {}
};

using CycloneDdsByteClientFactory =
    std::function<std::unique_ptr<CycloneDdsByteClient>(const CycloneDdsConfig&)>;
using CycloneDdsRpcAdapters =
    std::map<std::string, std::shared_ptr<CycloneDdsRpcAdapter>>;

inline void AssignStringOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    std::string* target);

inline void AssignIntOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    int* target);
inline bool IntOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    int* target);
inline int NativeDdsDomainId(
    const std::map<std::string, std::string>& options);

struct CycloneDdsBusConfig {
  CycloneDdsConfig config;
  std::string type_name{"PacificRimMessageEnvelope"};
  std::map<std::string, std::string> qos;
};

inline CycloneDdsBusConfig ConfigFromOptions(
    const pacific_rim::communication::core::BusConfig& bus_config);
inline std::string NormalizeRpcStandard(std::string value);
inline std::string MetadataValue(
    const std::map<std::string, std::string>& metadata,
    const std::string& key);
inline bool UsesByteEnvelope(
    const pacific_rim::communication::core::Channel& channel);
inline bool UsesByteEnvelope(const DdsTopicConfig& topic);
inline bool UsesTypedDdsPreferred(
    const pacific_rim::communication::core::Channel& channel);
inline std::string TypedDdsType(
    const pacific_rim::communication::core::Channel& channel);
inline bool UsesRos2ProtoEnvelopeType(const std::string& type_name);
inline Bytes EncodeProtoEnvelopeCDR(
    const pacific_rim::communication::core::Channel& channel,
    const Bytes& payload);
inline Bytes DecodeProtoEnvelopeCDRPayload(const Bytes& data);

class CycloneDdsBus final : public pacific_rim::communication::core::MessageBus {
 public:
  CycloneDdsBus(
      CycloneDdsConfig config,
      std::string type_name,
      std::map<std::string, std::string> qos,
      std::unique_ptr<CycloneDdsByteClient> client,
      CycloneDdsRpcAdapters rpc_adapters = {},
      TransportKind transport_kind = TransportKind::kCycloneDds)
      : config_(std::move(config)),
        type_name_(std::move(type_name)),
        qos_(std::move(qos)),
        client_(std::move(client)),
        rpc_adapters_(std::move(rpc_adapters)),
        transport_kind_(transport_kind) {}

  TransportKind Kind() const override { return transport_kind_; }

  pacific_rim::communication::core::Capabilities GetCapabilities() const override {
    pacific_rim::communication::core::Capabilities capabilities;
    capabilities.publish_subscribe = true;
    capabilities.request_reply = true;
    return capabilities;
  }

  bool Connect(const pacific_rim::communication::core::BusConfig& config) override {
    auto parsed = ConfigFromOptions(config);
    config_ = parsed.config;
    type_name_ = parsed.type_name;
    qos_ = parsed.qos;
    closed_ = false;
    return client_ != nullptr && client_->Connect(config_);
  }

  void Close() override {
    closed_ = true;
    {
      std::lock_guard<std::mutex> lock(ready_threads_mutex_);
      for (auto& thread : ready_threads_) {
        if (thread.joinable()) {
          thread.join();
        }
      }
      ready_threads_.clear();
    }
    if (client_ != nullptr) {
      client_->Close();
    }
  }

  bool Publish(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload) override {
    const auto topic = TopicFromChannel(channel);
    if (!EnsurePublishReady(topic)) {
      return false;
    }
    const auto wire_payload = UsesRos2ProtoEnvelopeType(topic.type_name) &&
                                      UsesByteEnvelope(channel)
                                  ? EncodeProtoEnvelopeCDR(channel, payload)
                                  : payload;
    return client_ != nullptr && client_->Publish(topic, wire_payload);
  }

  bool Subscribe(
      const pacific_rim::communication::core::Channel& channel,
      BytesHandler handler) override {
    const auto topic = TopicFromChannel(channel);
    const auto envelope = UsesRos2ProtoEnvelopeType(topic.type_name) && UsesByteEnvelope(channel);
    return client_ != nullptr &&
           client_->Subscribe(
               DdsSubscription{topic},
               [handler = std::move(handler), envelope](const Bytes& data) {
                 if (!handler) {
                   return;
                 }
                 handler(envelope ? DecodeProtoEnvelopeCDRPayload(data) : data);
               });
  }

  bool Request(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) override {
    const auto binding = RpcBindingFromChannel(channel);
    const auto iter = rpc_adapters_.find(binding.standard);
    const auto envelope = UsesRos2ProtoEnvelopeType(binding.request_channel.type_name);
    if (iter != rpc_adapters_.end() && iter->second != nullptr) {
      const auto wire_payload = envelope ? EncodeProtoEnvelopeCDR(channel, payload) : payload;
      Bytes wire_response;
      if (!iter->second->Request(binding, wire_payload, timeout, &wire_response)) {
        return false;
      }
      *response = envelope ? DecodeProtoEnvelopeCDRPayload(wire_response) : wire_response;
      return true;
    }
    if (binding.standard == "omg_dds_rpc" || binding.standard == "rmw_cyclonedds") {
      const auto wire_payload = envelope ? EncodeProtoEnvelopeCDR(channel, payload) : payload;
      Bytes wire_response;
      if (!RequestViaPairedChannels(binding, wire_payload, timeout, &wire_response)) {
        return false;
      }
      *response = envelope ? DecodeProtoEnvelopeCDRPayload(wire_response) : wire_response;
      return true;
    }
    return false;
  }

  bool HandleRequest(
      const pacific_rim::communication::core::Channel& channel,
      pacific_rim::communication::core::RequestHandler handler) override {
    const auto binding = RpcBindingFromChannel(channel);
    const auto iter = rpc_adapters_.find(binding.standard);
    const auto envelope = UsesRos2ProtoEnvelopeType(binding.request_channel.type_name);
    if (iter != rpc_adapters_.end() && iter->second != nullptr) {
      return iter->second->HandleRequest(
          binding,
          [channel, handler = std::move(handler), envelope](const Bytes& request) {
            const auto payload = envelope ? DecodeProtoEnvelopeCDRPayload(request) : request;
            auto response = handler ? handler(payload) : Bytes{};
            return envelope ? EncodeProtoEnvelopeCDR(channel, response) : response;
          });
    }
    if (binding.standard == "omg_dds_rpc" || binding.standard == "rmw_cyclonedds") {
      return HandleRequestViaPairedChannels(
          binding,
          [channel, handler = std::move(handler), envelope](const Bytes& request) {
            const auto payload = envelope ? DecodeProtoEnvelopeCDRPayload(request) : request;
            auto response = handler ? handler(payload) : Bytes{};
            return envelope ? EncodeProtoEnvelopeCDR(channel, response) : response;
          });
    }
    return false;
  }

 private:
  bool RequestViaPairedChannels(
      const DdsRpcBinding& binding,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) {
    if (client_ == nullptr || response == nullptr) {
      return false;
    }
    if (timeout.count() <= 0) {
      timeout = std::chrono::milliseconds(2000);
    }

    auto state = std::make_shared<RpcRequestState>();
    const auto probe_frame = NewRpcProbeFrame();
    state->ack_frame = RpcAckFrameForProbe(probe_frame);
    auto unsubscribe_response = client_->SubscribeManaged(
            DdsSubscription{binding.response_channel},
            [state](const Bytes& data) {
              {
                std::lock_guard<std::mutex> lock(state->mutex);
                if (!state->active || state->has_response) {
                  return;
                }
                state->response_payload = data;
                state->has_response = true;
              }
              state->ready.notify_one();
            });
    if (!unsubscribe_response) {
      return false;
    }
    auto unsubscribe_ack = client_->SubscribeManaged(
            DdsSubscription{RpcProbeAckChannel(binding)},
            [state](const Bytes& data) {
              if (data != state->ack_frame) {
                return;
              }
              {
                std::lock_guard<std::mutex> lock(state->mutex);
                if (!state->active) {
                  return;
                }
                state->has_handshake = true;
              }
              state->ready.notify_one();
            });
    if (!unsubscribe_ack) {
      unsubscribe_response();
      return false;
    }
    if (!client_->PreparePublish(binding.request_channel)) {
      unsubscribe_response();
      unsubscribe_ack();
      return false;
    }
    if (!client_->PreparePublish(RpcProbeChannel(binding))) {
      unsubscribe_response();
      unsubscribe_ack();
      return false;
    }
    const auto discovery_wait = timeout.count() <= 0
                                    ? std::chrono::milliseconds(1000)
                                    : std::min(timeout, std::chrono::milliseconds(1000));
    const auto rpc_ready = WaitForRpcReady(binding, timeout);
    const auto request_matched =
        client_->WaitForSubscribers(binding.request_channel, discovery_wait);
    const auto response_matched =
        client_->WaitForPublishers(binding.response_channel, discovery_wait);
    const auto probe_matched = client_->WaitForSubscribers(
        RpcProbeChannel(binding),
        std::min(discovery_wait, std::chrono::milliseconds(500)));
    if ((!rpc_ready && !request_matched) || !response_matched ||
        !probe_matched ||
        !ProbeRpcPairing(binding, timeout, probe_frame, state)) {
      DeactivateRpcRequest(state);
      unsubscribe_response();
      unsubscribe_ack();
      return false;
    }
    if (!client_->Publish(binding.request_channel, payload)) {
      DeactivateRpcRequest(state);
      unsubscribe_response();
      unsubscribe_ack();
      return false;
    }

    std::unique_lock<std::mutex> lock(state->mutex);
    if (!state->ready.wait_for(lock, timeout, [&]() { return state->has_response; })) {
      state->active = false;
      lock.unlock();
      unsubscribe_response();
      unsubscribe_ack();
      return false;
    }
    *response = std::move(state->response_payload);
    state->active = false;
    lock.unlock();
    unsubscribe_response();
    unsubscribe_ack();
    return true;
  }

  struct RpcRequestState {
    std::mutex mutex;
    std::condition_variable ready;
    bool active{true};
    bool has_response{false};
    bool has_handshake{false};
    Bytes ack_frame;
    Bytes response_payload;
  };

  static void DeactivateRpcRequest(const std::shared_ptr<RpcRequestState>& state) {
    if (state == nullptr) {
      return;
    }
    std::lock_guard<std::mutex> lock(state->mutex);
    state->active = false;
  }

  bool HandleRequestViaPairedChannels(
      const DdsRpcBinding& binding,
      pacific_rim::communication::core::RequestHandler handler) {
    if (client_ == nullptr || handler == nullptr) {
      return false;
    }
    if (!client_->PreparePublish(binding.response_channel)) {
      return false;
    }
    if (!client_->Subscribe(
        DdsSubscription{binding.request_channel},
        [this, binding, handler = std::move(handler)](const Bytes& request) {
          auto response = handler(request);
          client_->WaitForSubscribers(
              binding.response_channel,
              std::chrono::milliseconds(1000));
          if (!client_->Publish(binding.response_channel, response)) {
            return;
          }
        })) {
      return false;
    }
    return StartRpcControlEndpoints(binding);
  }

  static DdsTopicConfig RpcReadyChannel(const DdsRpcBinding& binding) {
    auto topic = binding.request_channel;
    topic.topic_name += ".__pr_ready";
    return topic;
  }

  static DdsTopicConfig RpcProbeChannel(const DdsRpcBinding& binding) {
    auto topic = binding.request_channel;
    topic.topic_name += ".__pr_probe";
    return topic;
  }

  static DdsTopicConfig RpcProbeAckChannel(const DdsRpcBinding& binding) {
    auto topic = binding.response_channel;
    topic.topic_name += ".__pr_probe_ack";
    return topic;
  }

  bool WaitForRpcReady(
      const DdsRpcBinding& binding,
      std::chrono::milliseconds timeout) {
    if (client_ == nullptr) {
      return false;
    }
    struct ReadyState {
      std::mutex mutex;
      std::condition_variable ready;
      bool active{true};
      bool is_ready{false};
    };
    auto state = std::make_shared<ReadyState>();
    const auto ready_channel = RpcReadyChannel(binding);
    auto unsubscribe = client_->SubscribeManaged(
            DdsSubscription{ready_channel},
            [state](const Bytes&) {
              {
                std::lock_guard<std::mutex> lock(state->mutex);
                if (!state->active) {
                  return;
                }
                state->is_ready = true;
              }
              state->ready.notify_one();
            });
    if (!unsubscribe) {
      return false;
    }
    const auto max_wait = std::chrono::milliseconds(1500);
    const auto wait_for = timeout.count() <= 0
                              ? max_wait
                              : std::min(timeout, max_wait);
    std::unique_lock<std::mutex> lock(state->mutex);
    const auto received = state->ready.wait_for(
        lock,
        wait_for,
        [&]() { return state->is_ready; });
    state->active = false;
    unsubscribe();
    return received;
  }

  bool ProbeRpcPairing(
      const DdsRpcBinding& binding,
      std::chrono::milliseconds timeout,
      const Bytes& probe_frame,
      const std::shared_ptr<RpcRequestState>& state) {
    if (client_ == nullptr || state == nullptr) {
      return false;
    }
    const auto max_wait = std::chrono::milliseconds(1500);
    const auto wait_for = timeout.count() <= 0 ? max_wait : std::min(timeout, max_wait);
    const auto deadline = std::chrono::steady_clock::now() + wait_for;
    while (std::chrono::steady_clock::now() < deadline) {
      {
        std::lock_guard<std::mutex> lock(state->mutex);
        if (!state->active) {
          return false;
        }
        if (state->has_handshake) {
          return true;
        }
      }
      if (!client_->Publish(RpcProbeChannel(binding), probe_frame)) {
        return false;
      }
      std::unique_lock<std::mutex> lock(state->mutex);
      state->ready.wait_until(
          lock,
          std::min(
              deadline,
              std::chrono::steady_clock::now() +
                  std::chrono::milliseconds(5)),
          [&]() { return !state->active || state->has_handshake; });
    }
    std::lock_guard<std::mutex> lock(state->mutex);
    return state->active && state->has_handshake;
  }

  bool StartRpcControlEndpoints(const DdsRpcBinding& binding) {
    if (client_ == nullptr) {
      return false;
    }
    const auto ready_channel = RpcReadyChannel(binding);
    if (!client_->PreparePublish(ready_channel)) {
      return false;
    }
    const auto probe_channel = RpcProbeChannel(binding);
    const auto probe_ack_channel = RpcProbeAckChannel(binding);
    if (!client_->PreparePublish(probe_ack_channel)) {
      return false;
    }
    if (!client_->Subscribe(
            DdsSubscription{probe_channel},
            [this, probe_ack_channel](const Bytes& probe) {
              if (!IsRpcProbeFrame(probe)) {
                return;
              }
              client_->WaitForSubscribers(
                  probe_ack_channel,
                  std::chrono::milliseconds(500));
              client_->Publish(probe_ack_channel, RpcAckFrameForProbe(probe));
            })) {
      return false;
    }
    const auto request_channel = binding.request_channel;
    std::lock_guard<std::mutex> lock(ready_threads_mutex_);
    ready_threads_.emplace_back([this, ready_channel, request_channel]() {
      const Bytes ready_payload{'r', 'e', 'a', 'd', 'y'};
      while (!closed_) {
        client_->WaitForPublishers(
            request_channel,
            std::chrono::milliseconds(100));
        client_->WaitForSubscribers(
            ready_channel,
            std::chrono::milliseconds(100));
        client_->Publish(ready_channel, ready_payload);
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
    });
    return true;
  }

  static bool IsRpcProbeFrame(const Bytes& data) {
    const auto& prefix = RpcProbePrefix();
    return data.size() >= prefix.size() &&
           std::equal(prefix.begin(), prefix.end(), data.begin());
  }

  static Bytes NewRpcProbeFrame() {
    auto frame = RpcProbePrefix();
    const auto nonce = std::to_string(
        std::chrono::steady_clock::now().time_since_epoch().count());
    frame.insert(frame.end(), nonce.begin(), nonce.end());
    return frame;
  }

  static Bytes RpcAckFrameForProbe(const Bytes& probe) {
    auto frame = RpcAckPrefix();
    const auto& probe_prefix = RpcProbePrefix();
    if (probe.size() > probe_prefix.size()) {
      frame.insert(frame.end(), probe.begin() + probe_prefix.size(), probe.end());
    }
    return frame;
  }

  static const Bytes& RpcProbePrefix() {
    static const Bytes prefix{
        0x00, 'P', 'R', 'P', 'C', '_', 'R', 'E', 'A', 'D', 'Y',
        '_', 'V', '1', 0x00, 'p', 'r', 'o', 'b', 'e', ':'};
    return prefix;
  }

  static const Bytes& RpcAckPrefix() {
    static const Bytes prefix{
        0x00, 'P', 'R', 'P', 'C', '_', 'R', 'E', 'A', 'D', 'Y',
        '_', 'V', '1', 0x00, 'a', 'c', 'k', ':'};
    return prefix;
  }

  DdsTopicConfig TopicFromChannel(
      const pacific_rim::communication::core::Channel& channel) const {
    DdsTopicConfig topic;
    topic.topic_name = channel.name;
    const auto typed_type = TypedDdsType(channel);
    if (UsesTypedDdsPreferred(channel) && !typed_type.empty() &&
        client_ != nullptr && client_->SupportsTypedDds(typed_type)) {
      topic.type_name = typed_type;
    } else if (UsesByteEnvelope(channel)) {
      topic.type_name = type_name_;
    } else {
      topic.type_name = channel.message_type.empty() ? type_name_ : channel.message_type;
    }
    topic.qos = qos_;
    for (const auto& [key, value] : channel.metadata) {
      if (key == "qos") {
        topic.qos["profile"] = value;
      } else if (key.rfind("qos.", 0) == 0) {
        topic.qos[key.substr(4)] = value;
      }
    }
    return topic;
  }

  bool EnsurePublishReady(const DdsTopicConfig& topic) {
    if (transport_kind_ != TransportKind::kFastDds || client_ == nullptr) {
      return true;
    }
    const auto key = TopicCacheKey(topic);
    {
      std::lock_guard<std::mutex> lock(publish_ready_mutex_);
      if (publish_ready_[key]) {
        return true;
      }
    }
    if (!client_->PreparePublish(topic)) {
      return false;
    }
    const auto timeout = FastDdsPublishMatchTimeout();
    bool matched = timeout.count() <= 0 ||
                   client_->WaitForSubscribers(topic, timeout);
    if (matched) {
      std::lock_guard<std::mutex> lock(publish_ready_mutex_);
      publish_ready_[key] = true;
    }
    return true;
  }

  static std::chrono::milliseconds FastDdsPublishMatchTimeout() {
    double seconds = 0.5;
    for (const char* key : {"PR_FASTDDS_MATCH_TIMEOUT_SEC", "PR_MATRIX_DISCOVERY_WAIT_SEC"}) {
      const char* value = std::getenv(key);
      if (value != nullptr && value[0] != '\0') {
        seconds = std::atof(value);
        break;
      }
    }
    if (seconds <= 0) {
      return std::chrono::milliseconds(0);
    }
    return std::chrono::milliseconds(static_cast<int>(seconds * 1000.0));
  }

  static std::string TopicCacheKey(const DdsTopicConfig& topic) {
    std::string key = topic.topic_name + "\x1f" + topic.type_name;
    for (const auto& [qos_key, value] : topic.qos) {
      key += "\x1f" + qos_key + "=" + value;
    }
    return key;
  }

  DdsRpcBinding RpcBindingFromChannel(
      const pacific_rim::communication::core::Channel& channel) const {
    DdsRpcBinding binding;
    auto standard = channel.metadata.find("rpc.standard");
    binding.standard =
        standard == channel.metadata.end() ? "omg_dds_rpc" : NormalizeRpcStandard(standard->second);
    auto request = channel.metadata.find("rpc.request_channel");
    const auto request_name =
        request == channel.metadata.end() || request->second.empty() ? channel.name : request->second;
    auto response = channel.metadata.find("rpc.response_channel");
    const auto response_name =
        response == channel.metadata.end() || response->second.empty() ? request_name + ".reply" : response->second;
    binding.request_channel = TopicFromChannel(channel);
    binding.request_channel.topic_name = request_name;
    binding.response_channel = TopicFromChannel(channel);
    binding.response_channel.topic_name = response_name;
    return binding;
  }

  CycloneDdsConfig config_;
  std::string type_name_;
  std::map<std::string, std::string> qos_;
  std::unique_ptr<CycloneDdsByteClient> client_;
  CycloneDdsRpcAdapters rpc_adapters_;
  TransportKind transport_kind_{TransportKind::kCycloneDds};
  std::mutex publish_ready_mutex_;
  std::map<std::string, bool> publish_ready_;
  std::atomic_bool closed_{true};
  std::mutex ready_threads_mutex_;
  std::vector<std::thread> ready_threads_;
};

inline CycloneDdsBusConfig ConfigFromOptions(
    const pacific_rim::communication::core::BusConfig& bus_config) {
  CycloneDdsBusConfig parsed;
  if (!bus_config.name.empty()) {
    parsed.config.participant_name = bus_config.name;
  }
  const auto& options = bus_config.options;
  parsed.config.domain_id = NativeDdsDomainId(options);
  AssignStringOption(options, "participant_name", &parsed.config.participant_name);
  AssignStringOption(options, "config_uri", &parsed.config.config_uri);
  AssignStringOption(options, "type_name", &parsed.type_name);
  for (const auto& [key, value] : options) {
    if (key == "qos") {
      parsed.qos["profile"] = value;
    } else if (key.rfind("qos.", 0) == 0) {
      parsed.qos[key.substr(4)] = value;
    }
  }
  return parsed;
}

inline pacific_rim::communication::core::MessageBusFactory NewBusFactory(
    CycloneDdsByteClientFactory factory,
    CycloneDdsRpcAdapters rpc_adapters = {},
    TransportKind transport_kind = TransportKind::kCycloneDds) {
  return [factory = std::move(factory),
          rpc_adapters = std::move(rpc_adapters),
          transport_kind](
             const pacific_rim::communication::core::BusConfig& config)
             -> std::unique_ptr<pacific_rim::communication::core::MessageBus> {
    auto parsed = ConfigFromOptions(config);
    auto client = factory != nullptr ? factory(parsed.config) : nullptr;
    if (client == nullptr) {
      return nullptr;
    }
    client->ConfigureOptions(config.options);
    return std::make_unique<CycloneDdsBus>(
        parsed.config,
        parsed.type_name,
        parsed.qos,
        std::move(client),
        rpc_adapters,
        transport_kind);
  };
}

inline void RegisterBus(
    CycloneDdsByteClientFactory factory,
    CycloneDdsRpcAdapters rpc_adapters = {},
    TransportKind transport_kind = TransportKind::kCycloneDds) {
  pacific_rim::communication::core::MessageBusRegistry::Instance().Register(
      transport_kind,
      NewBusFactory(std::move(factory), std::move(rpc_adapters), transport_kind));
}

inline std::string NormalizeRpcStandard(std::string value) {
  std::replace(value.begin(), value.end(), '-', '_');
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  if (value.empty() || value == "omg" || value == "dds_rpc" || value == "omg_dds_rpc") {
    return "omg_dds_rpc";
  }
  if (value == "rmw" || value == "rmw_cyclonedds" ||
      value == "rmw_cyclonedds_cpp" || value == "ros2_rmw") {
    return "rmw_cyclonedds";
  }
  return value;
}

inline std::string MetadataValue(
    const std::map<std::string, std::string>& metadata,
    const std::string& key) {
  const auto iter = metadata.find(key);
  return iter == metadata.end() ? "" : iter->second;
}

inline bool UsesByteEnvelope(
    const pacific_rim::communication::core::Channel& channel) {
  auto codec = MetadataValue(channel.metadata, "codec");
  auto format = MetadataValue(channel.metadata, "schema.format");
  std::replace(codec.begin(), codec.end(), '-', '_');
  std::replace(format.begin(), format.end(), '-', '_');
  std::transform(codec.begin(), codec.end(), codec.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  std::transform(format.begin(), format.end(), format.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return codec == "protobuf" ||
         format == "protobuf" ||
         format == "protobuf_rpc" ||
         MetadataValue(channel.metadata, "rpc.transport") == "cyclonedds_rpc";
}

inline bool UsesTypedDdsPreferred(
    const pacific_rim::communication::core::Channel& channel) {
  auto mode = MetadataValue(channel.metadata, "dds.mode");
  std::replace(mode.begin(), mode.end(), '-', '_');
  std::transform(mode.begin(), mode.end(), mode.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  const auto language = MetadataValue(channel.metadata, "schema.language");
  return mode == "typed" || mode == "typed_preferred" ||
         language == "omg_idl";
}

inline std::string TypedDdsType(
    const pacific_rim::communication::core::Channel& channel) {
  auto type = MetadataValue(channel.metadata, "dds.type");
  if (type.empty()) {
    type = MetadataValue(channel.metadata, "schema.type");
  }
  return type;
}

inline bool UsesByteEnvelope(const DdsTopicConfig& topic) {
  return topic.type_name.empty() ||
         topic.type_name == "common/msg/ProtoEnvelope" ||
         topic.type_name == "PacificRimMessageEnvelope";
}

inline bool UsesRos2ProtoEnvelopeType(const std::string& type_name) {
  return type_name.empty() || type_name == "common/msg/ProtoEnvelope";
}

inline std::size_t CdrPayloadOffset(std::size_t offset) {
  return offset <= 4 ? 0 : offset - 4;
}

inline void AlignCDR(Bytes* buffer, std::size_t alignment) {
  if (buffer == nullptr || alignment <= 1) {
    return;
  }
  const auto padding = (alignment - (CdrPayloadOffset(buffer->size()) % alignment)) % alignment;
  buffer->insert(buffer->end(), padding, 0);
}

inline void AppendUint32(Bytes* buffer, std::uint32_t value) {
  buffer->push_back(static_cast<std::uint8_t>(value & 0xff));
  buffer->push_back(static_cast<std::uint8_t>((value >> 8) & 0xff));
  buffer->push_back(static_cast<std::uint8_t>((value >> 16) & 0xff));
  buffer->push_back(static_cast<std::uint8_t>((value >> 24) & 0xff));
}

inline void AppendUint64(Bytes* buffer, std::uint64_t value) {
  for (int shift = 0; shift < 64; shift += 8) {
    buffer->push_back(static_cast<std::uint8_t>((value >> shift) & 0xff));
  }
}

inline void AppendCDRString(Bytes* buffer, const std::string& value) {
  AlignCDR(buffer, 4);
  AppendUint32(buffer, static_cast<std::uint32_t>(value.size() + 1));
  buffer->insert(buffer->end(), value.begin(), value.end());
  buffer->push_back(0);
}

inline std::uint64_t UnixMillisNow() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

inline Bytes EncodeProtoEnvelopeCDR(
    const pacific_rim::communication::core::Channel& channel,
    const Bytes& payload) {
  Bytes buffer{0x00, 0x01, 0x00, 0x00};
  AppendCDRString(&buffer, channel.message_type.empty()
                               ? MetadataValue(channel.metadata, "schema.type")
                               : channel.message_type);
  const auto codec = MetadataValue(channel.metadata, "codec");
  AppendCDRString(&buffer, codec.empty() ? "protobuf" : codec);
  const auto route = MetadataValue(channel.metadata, "logical_route");
  AppendCDRString(&buffer, route.empty() ? channel.name : route);
  AppendCDRString(&buffer, MetadataValue(channel.metadata, "trace_id"));
  AlignCDR(&buffer, 8);
  AppendUint64(&buffer, UnixMillisNow());
  AlignCDR(&buffer, 4);
  AppendUint32(&buffer, static_cast<std::uint32_t>(payload.size()));
  buffer.insert(buffer.end(), payload.begin(), payload.end());
  return buffer;
}

class CdrEnvelopeReader {
 public:
  explicit CdrEnvelopeReader(const Bytes& data) : data_(data) {}

  bool SkipEnvelopeHeader() {
    if (data_.size() < 4 || data_[0] != 0x00 || data_[1] != 0x01) {
      return false;
    }
    offset_ = 4;
    return true;
  }

  bool SkipString() {
    Align(4);
    std::uint32_t length = 0;
    if (!ReadUint32(&length) || length == 0 || offset_ + length > data_.size()) {
      return false;
    }
    offset_ += length;
    return true;
  }

  bool SkipUint64() {
    Align(8);
    if (offset_ + 8 > data_.size()) {
      return false;
    }
    offset_ += 8;
    return true;
  }

  bool ReadBytes(Bytes* payload) {
    Align(4);
    std::uint32_t length = 0;
    if (!ReadUint32(&length) || offset_ + length > data_.size()) {
      return false;
    }
    payload->assign(data_.begin() + static_cast<std::ptrdiff_t>(offset_),
                    data_.begin() + static_cast<std::ptrdiff_t>(offset_ + length));
    offset_ += length;
    return true;
  }

 private:
  void Align(std::size_t alignment) {
    const auto padding = (alignment - (CdrPayloadOffset(offset_) % alignment)) % alignment;
    offset_ += padding;
  }

  bool ReadUint32(std::uint32_t* value) {
    if (offset_ + 4 > data_.size() || value == nullptr) {
      return false;
    }
    *value = static_cast<std::uint32_t>(data_[offset_]) |
             (static_cast<std::uint32_t>(data_[offset_ + 1]) << 8) |
             (static_cast<std::uint32_t>(data_[offset_ + 2]) << 16) |
             (static_cast<std::uint32_t>(data_[offset_ + 3]) << 24);
    offset_ += 4;
    return true;
  }

  const Bytes& data_;
  std::size_t offset_{0};
};

inline Bytes DecodeProtoEnvelopeCDRPayload(const Bytes& data) {
  CdrEnvelopeReader reader(data);
  Bytes payload;
  if (!reader.SkipEnvelopeHeader() ||
      !reader.SkipString() ||
      !reader.SkipString() ||
      !reader.SkipString() ||
      !reader.SkipString() ||
      !reader.SkipUint64() ||
      !reader.ReadBytes(&payload)) {
    return data;
  }
  return payload;
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
  (void)IntOption(options, key, target);
}

inline bool IntOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    int* target) {
  const auto iter = options.find(key);
  if (iter == options.end() || target == nullptr) {
    return false;
  }
  try {
    *target = std::stoi(iter->second);
    return true;
  } catch (...) {
    return false;
  }
}

inline bool EnvInt(const char* key, int* target) {
  const auto* value = std::getenv(key);
  if (value == nullptr || value[0] == '\0' || target == nullptr) {
    return false;
  }
  try {
    *target = std::stoi(value);
    return true;
  } catch (...) {
    return false;
  }
}

inline int NativeDdsDomainOffset(
    const std::map<std::string, std::string>& options) {
  int offset = 100;
  if (IntOption(options, "native_domain_offset", &offset)) {
    return offset;
  }
  (void)EnvInt("PACIFIC_RIM_NATIVE_DDS_DOMAIN_OFFSET", &offset);
  return offset;
}

inline int NativeDdsDomainId(
    const std::map<std::string, std::string>& options) {
  int domain_id = 0;
  if (IntOption(options, "native_domain_id", &domain_id) ||
      IntOption(options, "domain_id", &domain_id) ||
      EnvInt("PACIFIC_RIM_NATIVE_DDS_DOMAIN_ID", &domain_id)) {
    return domain_id;
  }
  int ros_domain_id = 0;
  if (!IntOption(options, "ros_domain_id", &ros_domain_id)) {
    (void)EnvInt("ROS_DOMAIN_ID", &ros_domain_id);
  }
  return ros_domain_id + NativeDdsDomainOffset(options);
}

}  // namespace pacific_rim::communication::dds
