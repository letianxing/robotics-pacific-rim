#pragma once

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <future>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "infra/communication/cpp/dds/ros2_serialized_client.hpp"
#include "infra/communication/cpp/core/message_bus.hpp"
#include "rclcpp/rclcpp.hpp"

namespace pacific_rim::communication::ros2 {

using Bytes = pacific_rim::communication::core::Bytes;

class TypedMapper {
 public:
  virtual ~TypedMapper() = default;
  virtual bool ProtoToRos2Bytes(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload,
      Bytes* ros2_payload) = 0;
  virtual bool Ros2BytesToProto(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& ros2_payload,
      Bytes* payload) = 0;
};

class TypedMapperRegistry {
 public:
  static TypedMapperRegistry& Instance() {
    static TypedMapperRegistry registry;
    return registry;
  }

  void Register(std::string schema_type, std::string ros2_type, std::shared_ptr<TypedMapper> mapper) {
    if (mapper == nullptr) {
      return;
    }
    std::lock_guard<std::mutex> lock(mutex_);
    mappers_[Key(schema_type, ros2_type)] = std::move(mapper);
  }

  std::shared_ptr<TypedMapper> Find(
      const pacific_rim::communication::core::Channel& channel) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto iter = mappers_.find(Key(
        MetadataValue(channel, "schema.type").empty()
            ? channel.message_type
            : MetadataValue(channel, "schema.type"),
        GraphType(channel)));
    return iter == mappers_.end() ? nullptr : iter->second;
  }

  static std::string MetadataValue(
      const pacific_rim::communication::core::Channel& channel,
      const std::string& key) {
    const auto iter = channel.metadata.find(key);
    return iter == channel.metadata.end() ? "" : iter->second;
  }

  static std::string GraphType(const pacific_rim::communication::core::Channel& channel) {
    for (const auto* key : {
             "ros_message_type",
             "ros_service_type",
             "ros2.message_type",
             "ros2.service_type",
         }) {
      const auto value = MetadataValue(channel, key);
      if (!value.empty()) {
        return value;
      }
    }
    return channel.message_type;
  }

 private:
  static std::string Key(const std::string& schema_type, const std::string& ros2_type) {
    return schema_type + "=>" + ros2_type;
  }

  std::mutex mutex_;
  std::map<std::string, std::shared_ptr<TypedMapper>> mappers_;
};

inline void RegisterTypedMapper(
    const std::string& schema_type,
    const std::string& ros2_type,
    std::shared_ptr<TypedMapper> mapper) {
  TypedMapperRegistry::Instance().Register(schema_type, ros2_type, std::move(mapper));
}

class Ros2TypedMapperBus final : public pacific_rim::communication::core::MessageBus {
 public:
  ~Ros2TypedMapperBus() override { Close(); }

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
    auto rmw = Option(config.options, "rmw_implementation");
    if (!rmw.empty()) {
      setenv("RMW_IMPLEMENTATION", rmw.c_str(), 1);
    } else {
      pacific_rim::communication::dds::EnsureCycloneDdsRmw();
    }
    auto uri = Option(config.options, "config_uri");
    if (!uri.empty()) {
      setenv("CYCLONEDDS_URI", uri.c_str(), 1);
    }

    rclcpp::InitOptions init_options;
    init_options.auto_initialize_logging(false);
    std::string domain_id;
    const auto* env_domain_id = std::getenv("ROS_DOMAIN_ID");
    if (env_domain_id != nullptr) {
      domain_id = env_domain_id;
    }
    const auto ros_domain_id = Option(config.options, "ros_domain_id");
    if (!ros_domain_id.empty()) {
      domain_id = ros_domain_id;
    }
    const auto explicit_domain_id = Option(config.options, "domain_id");
    if (!explicit_domain_id.empty()) {
      domain_id = explicit_domain_id;
    }
    if (!domain_id.empty()) {
      try {
        init_options.set_domain_id(static_cast<std::size_t>(std::stoul(domain_id)));
      } catch (...) {
      }
    }
    context_ = std::make_shared<rclcpp::Context>();
    context_->init(0, nullptr, init_options);

    rclcpp::NodeOptions node_options;
    node_options.context(context_);
    node_options.start_parameter_services(false);
    node_options.start_parameter_event_publisher(false);
    node_ = std::make_shared<rclcpp::Node>(
        config.name.empty() ? "pacific_rim_ros2_typed_mapper" : config.name,
        node_options);

    rclcpp::ExecutorOptions executor_options;
    executor_options.context = context_;
    executor_ = std::make_unique<rclcpp::executors::SingleThreadedExecutor>(executor_options);
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
      context_->shutdown("ROS2 typed mapper bus stopping");
    }
    if (spin_thread_.joinable()) {
      spin_thread_.join();
    }
    std::lock_guard<std::mutex> lock(mutex_);
    subscriptions_.clear();
    publishers_.clear();
    executor_.reset();
    node_.reset();
    context_.reset();
  }

  bool Publish(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload) override {
    Bytes ros2_payload;
    auto mapper = TypedMapperRegistry::Instance().Find(channel);
    auto publisher = PublisherFor(channel);
    if (mapper == nullptr || publisher == nullptr ||
        !mapper->ProtoToRos2Bytes(channel, payload, &ros2_payload)) {
      return false;
    }
    rclcpp::SerializedMessage message(ros2_payload.size());
    message.reserve(ros2_payload.size());
    auto& target = message.get_rcl_serialized_message();
    if (!ros2_payload.empty()) {
      std::memcpy(target.buffer, ros2_payload.data(), ros2_payload.size());
    }
    target.buffer_length = ros2_payload.size();
    WaitForTopicSubscribers(channel, std::chrono::milliseconds(500));
    publisher->publish(message);
    return true;
  }

  bool Subscribe(
      const pacific_rim::communication::core::Channel& channel,
      pacific_rim::communication::core::BytesHandler handler) override {
    if (node_ == nullptr || handler == nullptr) {
      return false;
    }
    auto mapper = TypedMapperRegistry::Instance().Find(channel);
    if (mapper == nullptr) {
      return false;
    }
    auto callback = [channel, mapper = std::move(mapper), handler = std::move(handler)](
                        std::shared_ptr<rclcpp::SerializedMessage> message) {
      const auto& serialized = message->get_rcl_serialized_message();
      Bytes ros2_payload(
          serialized.buffer,
          serialized.buffer + serialized.buffer_length);
      Bytes payload;
      if (mapper->Ros2BytesToProto(channel, ros2_payload, &payload)) {
        handler(payload);
      }
    };
    std::lock_guard<std::mutex> lock(mutex_);
    subscriptions_.push_back(node_->create_generic_subscription(
        channel.name,
        TypedMapperRegistry::GraphType(channel),
        pacific_rim::communication::dds::QoSFromOptions(QosFromChannel(channel)),
        std::move(callback)));
    return true;
  }

  bool Request(
      const pacific_rim::communication::core::Channel& channel,
      const Bytes& payload,
      std::chrono::milliseconds,
      Bytes* response) override {
    Bytes ros2_payload;
    auto mapper = TypedMapperRegistry::Instance().Find(channel);
    if (mapper == nullptr || response == nullptr ||
        !mapper->ProtoToRos2Bytes(channel, payload, &ros2_payload)) {
      return false;
    }
    return mapper->Ros2BytesToProto(channel, ros2_payload, response);
  }

  bool HandleRequest(
      const pacific_rim::communication::core::Channel&,
      pacific_rim::communication::core::RequestHandler) override {
    return false;
  }

 private:
  static std::string Option(
      const std::map<std::string, std::string>& options,
      const std::string& key) {
    const auto iter = options.find(key);
    return iter == options.end() ? "" : iter->second;
  }

  static std::map<std::string, std::string> QosFromChannel(
      const pacific_rim::communication::core::Channel& channel) {
    std::map<std::string, std::string> qos;
    for (const auto& [key, value] : channel.metadata) {
      if (key == "qos") {
        qos["profile"] = value;
      } else if (key.rfind("qos.", 0) == 0) {
        qos[key.substr(4)] = value;
      }
    }
    return qos;
  }

  rclcpp::GenericPublisher::SharedPtr PublisherFor(
      const pacific_rim::communication::core::Channel& channel) {
    if (node_ == nullptr || channel.name.empty()) {
      return nullptr;
    }
    const auto graph_type = TypedMapperRegistry::GraphType(channel);
    if (graph_type.empty()) {
      return nullptr;
    }
    const auto key = channel.name + "|" + graph_type;
    std::lock_guard<std::mutex> lock(mutex_);
    auto iter = publishers_.find(key);
    if (iter != publishers_.end()) {
      return iter->second;
    }
    auto publisher = node_->create_generic_publisher(
        channel.name,
        graph_type,
        pacific_rim::communication::dds::QoSFromOptions(QosFromChannel(channel)));
    publishers_[key] = publisher;
    return publisher;
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

  rclcpp::Context::SharedPtr context_;
  rclcpp::Node::SharedPtr node_;
  std::unique_ptr<rclcpp::executors::SingleThreadedExecutor> executor_;
  std::thread spin_thread_;
  std::mutex mutex_;
  std::map<std::string, rclcpp::GenericPublisher::SharedPtr> publishers_;
  std::vector<rclcpp::GenericSubscription::SharedPtr> subscriptions_;
};

}  // namespace pacific_rim::communication::ros2
