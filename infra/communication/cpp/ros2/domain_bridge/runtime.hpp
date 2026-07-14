#pragma once

#include <atomic>
#include <cstddef>
#include <memory>
#include <string>
#include <thread>

#include "rclcpp/rclcpp.hpp"

namespace pacific_rim::communication::ros2::domain_bridge {

struct DomainBridgeRuntimeConfig {
  std::size_t primary_domain_id{0};
  std::size_t secondary_domain_id{0};
  std::string primary_node_name;
  std::string secondary_node_name;
  std::size_t primary_executor_threads{2};
  std::size_t secondary_executor_threads{4};
  bool primary_initialize_logging{true};
};

class DomainBridgeRuntime {
 public:
  explicit DomainBridgeRuntime(const DomainBridgeRuntimeConfig& config)
      : primary_context_(
            MakeContext(config.primary_domain_id, config.primary_initialize_logging)),
        secondary_context_(MakeContext(config.secondary_domain_id, false)),
        primary_node_(MakeNode(config.primary_node_name, primary_context_)),
        secondary_node_(MakeNode(config.secondary_node_name, secondary_context_)),
        primary_executor_(
            ExecutorOptions(primary_context_),
            config.primary_executor_threads),
        secondary_executor_(
            ExecutorOptions(secondary_context_),
            config.secondary_executor_threads) {
    primary_executor_.add_node(primary_node_);
    secondary_executor_.add_node(secondary_node_);
  }

  ~DomainBridgeRuntime() { Stop(); }

  DomainBridgeRuntime(const DomainBridgeRuntime&) = delete;
  DomainBridgeRuntime& operator=(const DomainBridgeRuntime&) = delete;

  rclcpp::Node::SharedPtr PrimaryNode() const { return primary_node_; }
  rclcpp::Node::SharedPtr SecondaryNode() const { return secondary_node_; }

  void Spin() {
    running_.store(true);
    primary_spin_thread_ = std::thread([this]() {
      primary_executor_.spin();
    });
    secondary_executor_.spin();
    Stop();
  }

  void Stop() {
    if (!running_.exchange(false)) {
      return;
    }
    secondary_executor_.cancel();
    primary_executor_.cancel();
    if (primary_context_->is_valid()) {
      primary_context_->shutdown("ROS2 domain bridge stopping");
    }
    if (secondary_context_->is_valid()) {
      secondary_context_->shutdown("ROS2 domain bridge stopping");
    }
    if (primary_spin_thread_.joinable()) {
      primary_spin_thread_.join();
    }
  }

 private:
  static rclcpp::Context::SharedPtr MakeContext(
      std::size_t domain_id,
      bool initialize_logging) {
    rclcpp::InitOptions options;
    options.set_domain_id(domain_id);
    options.auto_initialize_logging(initialize_logging);

    auto context = std::make_shared<rclcpp::Context>();
    context->init(0, nullptr, options);
    return context;
  }

  static rclcpp::Node::SharedPtr MakeNode(
      const std::string& name,
      const rclcpp::Context::SharedPtr& context) {
    rclcpp::NodeOptions options;
    options.context(context);
    options.start_parameter_services(false);
    options.start_parameter_event_publisher(false);
    return std::make_shared<rclcpp::Node>(name, options);
  }

  static rclcpp::ExecutorOptions ExecutorOptions(
      const rclcpp::Context::SharedPtr& context) {
    rclcpp::ExecutorOptions options;
    options.context = context;
    return options;
  }

  rclcpp::Context::SharedPtr primary_context_;
  rclcpp::Context::SharedPtr secondary_context_;
  rclcpp::Node::SharedPtr primary_node_;
  rclcpp::Node::SharedPtr secondary_node_;
  rclcpp::executors::MultiThreadedExecutor primary_executor_;
  rclcpp::executors::MultiThreadedExecutor secondary_executor_;
  std::thread primary_spin_thread_;
  std::atomic_bool running_{false};
};

inline std::string DomainLabel(std::size_t domain_id) {
  return std::to_string(domain_id);
}

}  // namespace pacific_rim::communication::ros2::domain_bridge
