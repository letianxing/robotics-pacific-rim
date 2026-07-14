#pragma once

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "rclcpp/callback_group.hpp"
#include "rclcpp/executors/multi_threaded_executor.hpp"
#include "infra/communication/cpp/core/message_bus.hpp"
#include "infra/communication/cpp/dds/ros2_serialized_client.hpp"
#include "pacific_rim/metric/metric.hpp"
#include "pacific_rim/trace/trace.hpp"

#if __has_include("common/msg/proto_envelope.hpp") && \
    __has_include("common/srv/proto_call.hpp")
#define PACIFIC_RIM_COMMUNICATION_CPP_HAS_COMMON_PROTO_ENVELOPE 1
#include "common/msg/proto_envelope.hpp"
#include "common/srv/proto_call.hpp"
#else
#define PACIFIC_RIM_COMMUNICATION_CPP_HAS_COMMON_PROTO_ENVELOPE 0
#endif

namespace pacific_rim::communication::ros2 {

using Bytes = pacific_rim::communication::core::Bytes;
using BytesHandler = pacific_rim::communication::core::BytesHandler;

struct ProtoEnvelopeBusConfig {
  int domain_id{-1};
  std::string node_name{"pacific_rim_ros2_proto_envelope"};
  std::string rmw_implementation;
  std::string config_uri;
  std::map<std::string, std::string> qos;
};

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

inline ProtoEnvelopeBusConfig ConfigFromOptions(
    const pacific_rim::communication::core::BusConfig& bus_config) {
  ProtoEnvelopeBusConfig config;
  if (!bus_config.name.empty()) {
    config.node_name = bus_config.name;
  }
  const auto& options = bus_config.options;
  AssignStringOption(options, "name", &config.node_name);
  AssignStringOption(options, "node_name", &config.node_name);
  AssignStringOption(options, "rmw_implementation", &config.rmw_implementation);
  AssignStringOption(options, "config_uri", &config.config_uri);
  const auto* env_domain_id = std::getenv("ROS_DOMAIN_ID");
  if (env_domain_id != nullptr && env_domain_id[0] != '\0') {
    try {
      config.domain_id = std::stoi(env_domain_id);
    } catch (...) {
    }
  }
  AssignIntOption(options, "ros_domain_id", &config.domain_id);
  AssignIntOption(options, "domain_id", &config.domain_id);
  for (const auto& [key, value] : options) {
    if (key == "qos") {
      config.qos["profile"] = value;
    } else if (key.rfind("qos.", 0) == 0) {
      config.qos[key.substr(4)] = value;
    }
  }
  const auto queue_size = options.find("queue_size");
  if (queue_size != options.end() && config.qos.find("depth") == config.qos.end()) {
    config.qos["depth"] = queue_size->second;
  }
  return config;
}

inline std::string MetadataValue(
    const pacific_rim::communication::core::Channel& channel,
    const std::string& key) {
  const auto iter = channel.metadata.find(key);
  return iter == channel.metadata.end() ? "" : iter->second;
}

inline std::map<std::string, std::string> QosFromChannel(
    const pacific_rim::communication::core::Channel& channel,
    const std::map<std::string, std::string>& fallback) {
  auto qos = fallback;
  for (const auto& [key, value] : channel.metadata) {
    if (key == "qos") {
      qos["profile"] = value;
    } else if (key.rfind("qos.", 0) == 0) {
      qos[key.substr(4)] = value;
    }
  }
  return qos;
}

inline std::uint64_t UnixMillisNow() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

inline std::string RouteLabel(
    const pacific_rim::communication::core::Channel& channel) {
  const auto logical_route = MetadataValue(channel, "logical_route");
  if (!logical_route.empty()) {
    return logical_route;
  }
  const auto source_name = MetadataValue(channel, "source_name");
  return source_name.empty() ? channel.name : source_name;
}

inline void RecordMessageLatency(
    const pacific_rim::communication::core::Channel& channel,
    std::uint64_t created_at_unix_ms,
    const std::string& kind,
    const std::string& phase) {
  if (created_at_unix_ms == 0) {
    return;
  }
  const auto now = UnixMillisNow();
  const auto latency_ms = now >= created_at_unix_ms ? now - created_at_unix_ms : 0;
  std::map<std::string, std::string> attributes{
      {"transport", "ros2"},
      {"kind", kind},
      {"phase", phase},
      {"direction", "in"},
      {"route", RouteLabel(channel)}};
  if (kind == "service") {
    attributes["service"] = channel.name;
  } else {
    attributes["topic"] = channel.name;
  }
  static pacific_rim::metric::Histogram latency_histogram{
      pacific_rim::metric::message_latency};
  latency_histogram.record(static_cast<double>(latency_ms), attributes);
}

template <typename MessageT>
inline void FillEnvelopeFields(
    MessageT* message,
    const pacific_rim::communication::core::Channel& channel,
    const Bytes& payload) {
  if (message == nullptr) {
    return;
  }
  message->schema_type = channel.message_type.empty()
                             ? MetadataValue(channel, "schema.type")
                             : channel.message_type;
  message->codec = MetadataValue(channel, "codec").empty()
                       ? "protobuf"
                       : MetadataValue(channel, "codec");
  const auto logical_route = MetadataValue(channel, "logical_route");
  message->route = logical_route.empty() ? channel.name : logical_route;
  message->trace_id = MetadataValue(channel, "trace_id");
  message->traceparent = pacific_rim::trace::current_traceparent();
  message->created_at_unix_ms = UnixMillisNow();
  message->payload.assign(payload.begin(), payload.end());
}

#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_COMMON_PROTO_ENVELOPE

class Ros2ProtoEnvelopeBus final : public pacific_rim::communication::core::MessageBus {
 public:
  explicit Ros2ProtoEnvelopeBus(ProtoEnvelopeBusConfig config)
      : config_(std::move(config)) {}

  ~Ros2ProtoEnvelopeBus() override { Close(); }

  TransportKind Kind() const override { return TransportKind::kRos2; }

  pacific_rim::communication::core::Capabilities GetCapabilities() const override {
    pacific_rim::communication::core::Capabilities capabilities;
    capabilities.publish_subscribe = true;
    capabilities.request_reply = true;
    return capabilities;
  }

  bool Connect(const pacific_rim::communication::core::BusConfig& config) override {
    if (context_ != nullptr) {
      return true;
    }
    config_ = ConfigFromOptions(config);
    if (!config_.rmw_implementation.empty()) {
      setenv("RMW_IMPLEMENTATION", config_.rmw_implementation.c_str(), 1);
    } else {
      pacific_rim::communication::dds::EnsureCycloneDdsRmw();
    }
    if (!config_.config_uri.empty()) {
      setenv("CYCLONEDDS_URI", config_.config_uri.c_str(), 1);
    }

    rclcpp::InitOptions init_options;
    if (config_.domain_id >= 0) {
      init_options.set_domain_id(static_cast<std::size_t>(config_.domain_id));
    }
    init_options.auto_initialize_logging(false);
    context_ = std::make_shared<rclcpp::Context>();
    context_->init(0, nullptr, init_options);

    rclcpp::NodeOptions node_options;
    node_options.context(context_);
    node_options.start_parameter_services(false);
    node_options.start_parameter_event_publisher(false);
    node_ = std::make_shared<rclcpp::Node>(config_.node_name, node_options);
    callback_group_ = node_->create_callback_group(
        rclcpp::CallbackGroupType::Reentrant,
        true);

    rclcpp::ExecutorOptions executor_options;
    executor_options.context = context_;
    executor_ =
        std::make_unique<rclcpp::executors::MultiThreadedExecutor>(
            executor_options,
            2);
    executor_->add_node(node_);
    auto spin_ready = std::make_shared<std::promise<void>>();
    auto spin_ready_future = spin_ready->get_future();
    spin_thread_ = std::thread([this, spin_ready]() {
      spin_ready->set_value();
      executor_->spin();
    });
    spin_ready_future.wait_for(std::chrono::milliseconds(500));
    return true;
  }

  void Close() override {
    if (executor_ != nullptr) {
      executor_->cancel();
    }
    if (context_ != nullptr && context_->is_valid()) {
      context_->shutdown("ROS2 proto envelope bus stopping");
    }
    if (spin_thread_.joinable()) {
      spin_thread_.join();
    }
    std::lock_guard<std::mutex> lock(mutex_);
    clients_.clear();
    services_.clear();
    subscriptions_.clear();
    publishers_.clear();
    callback_group_.reset();
    executor_.reset();
    node_.reset();
    context_.reset();
  }

  bool Publish(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload) override {
    auto publisher = PublisherFor(channel);
    if (publisher == nullptr) {
      return false;
    }
    common::msg::ProtoEnvelope message;
    FillEnvelopeFields(&message, channel, payload);
    WaitForTopicSubscribers(channel, std::chrono::milliseconds(500));
    publisher->publish(message);
    return true;
  }

  bool Subscribe(
      const pacific_rim::communication::core::Channel& channel,
      BytesHandler handler) override {
    if (node_ == nullptr || channel.name.empty()) {
      return false;
    }
    auto callback = [channel, handler = std::move(handler)](
                        const common::msg::ProtoEnvelope::SharedPtr message) {
      RecordMessageLatency(channel, message->created_at_unix_ms, "topic", "message");
      if (handler) {
        handler(Bytes(message->payload.begin(), message->payload.end()));
      }
    };
    std::lock_guard<std::mutex> lock(mutex_);
    rclcpp::SubscriptionOptions options;
    options.callback_group = callback_group_;
    subscriptions_.push_back(node_->create_subscription<common::msg::ProtoEnvelope>(
        channel.name,
        pacific_rim::communication::dds::QoSFromOptions(
            QosFromChannel(channel, config_.qos)),
        std::move(callback),
        options));
    return true;
  }

  bool Request(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload,
      std::chrono::milliseconds timeout,
      Bytes* response) override {
    auto client = ClientFor(channel);
    if (client == nullptr || response == nullptr) {
      return false;
    }
    if (timeout.count() <= 0) {
      timeout = std::chrono::milliseconds(2000);
    }
    const auto started_at = std::chrono::steady_clock::now();
    if (!client->wait_for_service(timeout)) {
      return false;
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started_at);
    const auto response_timeout =
        elapsed >= timeout ? std::chrono::milliseconds(1) : timeout - elapsed;
    auto request = std::make_shared<common::srv::ProtoCall::Request>();
    FillEnvelopeFields(request.get(), channel, payload);
    auto future = client->async_send_request(request);
    if (future.future.wait_for(response_timeout) != std::future_status::ready) {
      client->remove_pending_request(future);
      return false;
    }
    auto result = future.future.get();
    RecordMessageLatency(channel, result->created_at_unix_ms, "service", "response");
    response->assign(result->payload.begin(), result->payload.end());
    return true;
  }

  bool HandleRequest(
      const pacific_rim::communication::core::Channel& channel,
      pacific_rim::communication::core::RequestHandler handler) override {
    if (node_ == nullptr || channel.name.empty()) {
      return false;
    }
    auto callback = [channel, handler = std::move(handler)](
                        const std::shared_ptr<common::srv::ProtoCall::Request> request,
                        std::shared_ptr<common::srv::ProtoCall::Response> response) {
      RecordMessageLatency(channel, request->created_at_unix_ms, "service", "request");
      auto span = pacific_rim::trace::start_child_span(
          pacific_rim::trace::route_span_name(channel.name, channel.metadata, "server"),
          request->traceparent);
      pacific_rim::trace::ScopedTraceContext trace_scope(span);
      span.set_attribute("pr.transport", "ros2_service");
      span.set_attribute("pr.route", MetadataValue(channel, "logical_route"));
      Bytes request_payload(request->payload.begin(), request->payload.end());
      Bytes response_payload = handler ? handler(request_payload) : Bytes{};
      FillEnvelopeFields(response.get(), channel, response_payload);
      response->traceparent = pacific_rim::trace::traceparent(span.ids());
      span.end();
    };
    std::lock_guard<std::mutex> lock(mutex_);
    services_.push_back(node_->create_service<common::srv::ProtoCall>(
        channel.name,
        std::move(callback),
        rmw_qos_profile_services_default,
        callback_group_));
    return true;
  }

 private:
  rclcpp::Publisher<common::msg::ProtoEnvelope>::SharedPtr PublisherFor(
      const pacific_rim::communication::core::Channel& channel) {
    if (node_ == nullptr || channel.name.empty()) {
      return nullptr;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    auto iter = publishers_.find(channel.name);
    if (iter != publishers_.end()) {
      return iter->second;
    }
    auto publisher = node_->create_publisher<common::msg::ProtoEnvelope>(
        channel.name,
        pacific_rim::communication::dds::QoSFromOptions(
            QosFromChannel(channel, config_.qos)));
    publishers_[channel.name] = publisher;
    return publisher;
  }

  rclcpp::Client<common::srv::ProtoCall>::SharedPtr ClientFor(
      const pacific_rim::communication::core::Channel& channel) {
    if (node_ == nullptr || channel.name.empty()) {
      return nullptr;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    auto iter = clients_.find(channel.name);
    if (iter != clients_.end()) {
      return iter->second;
    }
    auto client = node_->create_client<common::srv::ProtoCall>(
        channel.name,
        rmw_qos_profile_services_default,
        callback_group_);
    clients_[channel.name] = client;
    return client;
  }

  void WaitForTopicSubscribers(
      const pacific_rim::communication::core::Channel& channel,
      std::chrono::milliseconds timeout) {
    if (node_ == nullptr || channel.name.empty() || timeout.count() <= 0) {
      return;
    }
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      if (node_->count_subscribers(channel.name) > 0) {
        return;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
  }

  ProtoEnvelopeBusConfig config_;
  rclcpp::Context::SharedPtr context_;
  rclcpp::Node::SharedPtr node_;
  rclcpp::CallbackGroup::SharedPtr callback_group_;
  std::unique_ptr<rclcpp::executors::MultiThreadedExecutor> executor_;
  std::thread spin_thread_;
  std::mutex mutex_;
  std::map<std::string, rclcpp::Publisher<common::msg::ProtoEnvelope>::SharedPtr> publishers_;
  std::vector<rclcpp::Subscription<common::msg::ProtoEnvelope>::SharedPtr> subscriptions_;
  std::vector<rclcpp::Service<common::srv::ProtoCall>::SharedPtr> services_;
  std::map<std::string, rclcpp::Client<common::srv::ProtoCall>::SharedPtr> clients_;
};

#endif

class UnavailableRos2ProtoEnvelopeBus final
    : public pacific_rim::communication::core::MessageBus {
 public:
  TransportKind Kind() const override { return TransportKind::kRos2; }

  pacific_rim::communication::core::Capabilities GetCapabilities() const override {
    pacific_rim::communication::core::Capabilities capabilities;
    capabilities.publish_subscribe = true;
    capabilities.request_reply = true;
    return capabilities;
  }

  bool Connect(const pacific_rim::communication::core::BusConfig&) override {
    return false;
  }

  void Close() override {}

  bool Publish(const pacific_rim::communication::core::Channel&, const Bytes&) override {
    return false;
  }

  bool Subscribe(
      const pacific_rim::communication::core::Channel&,
      BytesHandler) override {
    return false;
  }

  bool Request(
      const pacific_rim::communication::core::Channel&,
      const Bytes&,
      std::chrono::milliseconds,
      Bytes*) override {
    return false;
  }

  bool HandleRequest(
      const pacific_rim::communication::core::Channel&,
      pacific_rim::communication::core::RequestHandler) override {
    return false;
  }
};

inline void RegisterRos2ProtoEnvelopeBus() {
  pacific_rim::communication::core::MessageBusRegistry::Instance().Register(
      TransportKind::kRos2,
      [](const pacific_rim::communication::core::BusConfig& config)
          -> std::unique_ptr<pacific_rim::communication::core::MessageBus> {
#if PACIFIC_RIM_COMMUNICATION_CPP_HAS_COMMON_PROTO_ENVELOPE
        return std::make_unique<Ros2ProtoEnvelopeBus>(ConfigFromOptions(config));
#else
        (void)config;
        return std::make_unique<UnavailableRos2ProtoEnvelopeBus>();
#endif
      });
}

}  // namespace pacific_rim::communication::ros2
