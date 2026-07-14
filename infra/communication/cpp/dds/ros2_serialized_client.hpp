#pragma once

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <future>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "infra/communication/cpp/dds/bus.hpp"
#include "rclcpp/rclcpp.hpp"

namespace pacific_rim::communication::dds {

inline void EnsureCycloneDdsRmw() {
  if (std::getenv("RMW_IMPLEMENTATION") == nullptr) {
    setenv("RMW_IMPLEMENTATION", "rmw_cyclonedds_cpp", 0);
  }
}

inline std::string Lower(std::string value) {
  for (auto& ch : value) {
    ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  }
  return value;
}

inline long LongOption(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    long fallback) {
  const auto iter = options.find(key);
  if (iter == options.end()) {
    return fallback;
  }
  try {
    return std::stol(iter->second);
  } catch (...) {
    return fallback;
  }
}

inline std::chrono::milliseconds DurationOption(
    const std::map<std::string, std::string>& options,
    const std::string& key) {
  const auto iter = options.find(key);
  if (iter == options.end() || iter->second.empty()) {
    return std::chrono::milliseconds(0);
  }
  const auto value = iter->second;
  try {
    if (value.size() > 2 && value.substr(value.size() - 2) == "ms") {
      return std::chrono::milliseconds(std::stol(value.substr(0, value.size() - 2)));
    }
    if (value.size() > 1 && value.back() == 's') {
      return std::chrono::milliseconds(std::stol(value.substr(0, value.size() - 1)) * 1000);
    }
    return std::chrono::milliseconds(std::stol(value));
  } catch (...) {
    return std::chrono::milliseconds(0);
  }
}

inline void ApplyDuration(
    const std::map<std::string, std::string>& options,
    const std::string& key,
    const std::function<void(std::chrono::milliseconds)>& apply) {
  const auto duration = DurationOption(options, key);
  if (duration.count() > 0) {
    apply(duration);
  }
}

inline rmw_time_t ToRmwTime(std::chrono::milliseconds value) {
  const auto nanoseconds = std::chrono::duration_cast<std::chrono::nanoseconds>(value).count();
  rmw_time_t result;
  result.sec = static_cast<std::uint64_t>(nanoseconds / 1000000000);
  result.nsec = static_cast<std::uint64_t>(nanoseconds % 1000000000);
  return result;
}

inline rclcpp::QoS QoSFromOptions(const std::map<std::string, std::string>& options) {
  const auto history = Lower(options.count("history") ? options.at("history") : "keep_last");
  const auto depth_value = LongOption(options, "depth", 10);
  const auto depth = static_cast<std::size_t>(depth_value > 0 ? depth_value : 10);
  rclcpp::QoS qos = history == "keep_all"
                        ? rclcpp::QoS(rclcpp::KeepAll())
                        : rclcpp::QoS(rclcpp::KeepLast(depth));

  const auto reliability = Lower(options.count("reliability") ? options.at("reliability") : "");
  if (reliability == "best_effort" || reliability == "besteffort") {
    qos.best_effort();
  } else if (reliability == "reliable") {
    qos.reliable();
  }

  const auto durability = Lower(options.count("durability") ? options.at("durability") : "");
  if (durability == "transient_local" || durability == "transientlocal") {
    qos.transient_local();
  } else if (durability == "volatile") {
    qos.durability_volatile();
  }

  const auto liveliness = Lower(options.count("liveliness") ? options.at("liveliness") : "");
  if (liveliness == "automatic") {
    qos.liveliness(RMW_QOS_POLICY_LIVELINESS_AUTOMATIC);
  } else if (liveliness == "manual_by_topic" || liveliness == "manualbytopic") {
    qos.liveliness(RMW_QOS_POLICY_LIVELINESS_MANUAL_BY_TOPIC);
  }

  ApplyDuration(options, "deadline_ms", [&](auto value) { qos.deadline(ToRmwTime(value)); });
  ApplyDuration(options, "lifespan_ms", [&](auto value) { qos.lifespan(ToRmwTime(value)); });
  ApplyDuration(options, "liveliness_lease_duration_ms", [&](auto value) {
    qos.liveliness_lease_duration(ToRmwTime(value));
  });
  return qos;
}

class Ros2SerializedCycloneDdsByteClient final : public CycloneDdsByteClient {
 public:
  ~Ros2SerializedCycloneDdsByteClient() override { Close(); }

  bool Connect(const CycloneDdsConfig& config) override {
    if (context_ != nullptr) {
      return true;
    }
    EnsureCycloneDdsRmw();
    if (!config.config_uri.empty()) {
      setenv("CYCLONEDDS_URI", config.config_uri.c_str(), 1);
    }
    config_ = config;
    rclcpp::InitOptions init_options;
    init_options.set_domain_id(static_cast<std::size_t>(config.domain_id));
    init_options.auto_initialize_logging(false);
    context_ = std::make_shared<rclcpp::Context>();
    context_->init(0, nullptr, init_options);

    rclcpp::NodeOptions node_options;
    node_options.context(context_);
    node_options.start_parameter_services(false);
    node_options.start_parameter_event_publisher(false);
    node_ = std::make_shared<rclcpp::Node>(
        config.participant_name.empty() ? "pacific_rim_cyclonedds" : config.participant_name,
        node_options);

    rclcpp::ExecutorOptions executor_options;
    executor_options.context = context_;
    executor_ =
        std::make_unique<rclcpp::executors::SingleThreadedExecutor>(executor_options);
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
      context_->shutdown("CycloneDDS serialized client stopping");
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

  bool Publish(const DdsTopicConfig& topic, const Bytes& payload) override {
    auto publisher = PublisherFor(topic);
    if (publisher == nullptr) {
      return false;
    }
    WaitForSubscribers(topic, std::chrono::milliseconds(500));
    rclcpp::SerializedMessage message(payload.size());
    message.reserve(payload.size());
    auto& target = message.get_rcl_serialized_message();
    std::memcpy(target.buffer, payload.data(), payload.size());
    target.buffer_length = payload.size();
    publisher->publish(message);
    return true;
  }

  bool PreparePublish(const DdsTopicConfig& topic) override {
    return PublisherFor(topic) != nullptr;
  }

  bool Subscribe(const DdsSubscription& subscription, BytesHandler handler) override {
    return static_cast<bool>(SubscribeManaged(subscription, std::move(handler)));
  }

  std::function<void()> SubscribeManaged(
      const DdsSubscription& subscription,
      BytesHandler handler) override {
    if (node_ == nullptr || subscription.topic.topic_name.empty() ||
        subscription.topic.type_name.empty()) {
      return {};
    }
    auto callback = [handler = std::move(handler)](
                        std::shared_ptr<rclcpp::SerializedMessage> message) {
      const auto& serialized = message->get_rcl_serialized_message();
      Bytes payload(
          serialized.buffer,
          serialized.buffer + serialized.buffer_length);
      if (handler) {
        handler(payload);
      }
    };
    rclcpp::GenericSubscription::SharedPtr subscription_handle;
    const auto key = subscription.topic.topic_name + "|" + subscription.topic.type_name;
    std::lock_guard<std::mutex> lock(mutex_);
    subscription_handle = node_->create_generic_subscription(
        subscription.topic.topic_name,
        subscription.topic.type_name,
        QoSFromOptions(subscription.topic.qos),
        std::move(callback));
    subscriptions_.push_back(subscription_handle);
    if (subscriptions_by_key_.find(key) == subscriptions_by_key_.end()) {
      subscriptions_by_key_[key] = subscription_handle;
    }
    return [this, subscription_handle, key]() {
      std::lock_guard<std::mutex> lock(mutex_);
      subscriptions_.erase(
          std::remove(subscriptions_.begin(), subscriptions_.end(), subscription_handle),
          subscriptions_.end());
      const auto iter = subscriptions_by_key_.find(key);
      if (iter != subscriptions_by_key_.end() && iter->second == subscription_handle) {
        subscriptions_by_key_.erase(iter);
      }
    };
  }

  bool WaitForSubscribers(
      const DdsTopicConfig& topic,
      std::chrono::milliseconds timeout) override {
    if (node_ == nullptr || topic.topic_name.empty()) {
      return false;
    }
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      if (node_->count_subscribers(topic.topic_name) > 0) {
        return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
  }

  bool WaitForPublishers(
      const DdsTopicConfig& topic,
      std::chrono::milliseconds timeout) override {
    if (node_ == nullptr || topic.topic_name.empty()) {
      return false;
    }
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
      if (node_->count_publishers(topic.topic_name) > 0) {
        return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
  }

 private:
  rclcpp::GenericPublisher::SharedPtr PublisherFor(const DdsTopicConfig& topic) {
    if (node_ == nullptr || topic.topic_name.empty() || topic.type_name.empty()) {
      return nullptr;
    }
    const auto key = topic.topic_name + "|" + topic.type_name;
    std::lock_guard<std::mutex> lock(mutex_);
    auto iter = publishers_.find(key);
    if (iter != publishers_.end()) {
      return iter->second;
    }
    auto publisher = node_->create_generic_publisher(
        topic.topic_name,
        topic.type_name,
        QoSFromOptions(topic.qos));
    publishers_[key] = publisher;
    return publisher;
  }

  CycloneDdsConfig config_;
  rclcpp::Context::SharedPtr context_;
  rclcpp::Node::SharedPtr node_;
  std::unique_ptr<rclcpp::executors::SingleThreadedExecutor> executor_;
  std::thread spin_thread_;
  std::mutex mutex_;
  std::map<std::string, rclcpp::GenericPublisher::SharedPtr> publishers_;
  std::map<std::string, rclcpp::GenericSubscription::SharedPtr> subscriptions_by_key_;
  std::vector<rclcpp::GenericSubscription::SharedPtr> subscriptions_;
};

inline void RegisterRos2SerializedCycloneDdsBus() {
  RegisterBus([](const CycloneDdsConfig&) {
    return std::make_unique<Ros2SerializedCycloneDdsByteClient>();
  });
}

}  // namespace pacific_rim::communication::dds
