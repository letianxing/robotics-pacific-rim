#pragma once

#include <cstddef>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "rclcpp/rclcpp.hpp"

#include "infra/communication/cpp/ros2/domain_bridge/runtime.hpp"

namespace pacific_rim::communication::ros2::domain_bridge {

struct TopicBridgeSpec {
  const char* topic_name;
  const char* topic_type;
  std::size_t from_domain;
  std::size_t to_domain;
  std::size_t qos_depth{10};
};

class TopicBridgeRegistry {
 public:
  TopicBridgeRegistry(
      rclcpp::Node::SharedPtr primary_node,
      rclcpp::Node::SharedPtr secondary_node,
      std::size_t primary_domain_id,
      std::size_t secondary_domain_id)
      : primary_node_(std::move(primary_node)),
        secondary_node_(std::move(secondary_node)),
        primary_domain_id_(primary_domain_id),
        secondary_domain_id_(secondary_domain_id) {}

  void Add(const TopicBridgeSpec& spec) {
    auto source = NodeForDomain(spec.from_domain);
    auto target = NodeForDomain(spec.to_domain);

    TopicBridge bridge;
    bridge.publisher = target->create_generic_publisher(
        spec.topic_name,
        spec.topic_type,
        rclcpp::QoS(spec.qos_depth));

    auto publisher = bridge.publisher;
    bridge.subscription = source->create_generic_subscription(
        spec.topic_name,
        spec.topic_type,
        rclcpp::QoS(spec.qos_depth),
        [publisher](std::shared_ptr<rclcpp::SerializedMessage> message) {
          publisher->publish(*message);
        });
    bridges_.push_back(std::move(bridge));

    RCLCPP_INFO(
        secondary_node_->get_logger(),
        "topic bridge: %s [%s] %s -> %s",
        spec.topic_name,
        spec.topic_type,
        DomainLabel(spec.from_domain).c_str(),
        DomainLabel(spec.to_domain).c_str());
  }

 private:
  struct TopicBridge {
    rclcpp::GenericPublisher::SharedPtr publisher;
    rclcpp::GenericSubscription::SharedPtr subscription;
  };

  rclcpp::Node::SharedPtr NodeForDomain(std::size_t domain_id) const {
    if (domain_id == primary_domain_id_) {
      return primary_node_;
    }
    if (domain_id == secondary_domain_id_) {
      return secondary_node_;
    }
    throw std::runtime_error("unsupported topic bridge domain");
  }

  rclcpp::Node::SharedPtr primary_node_;
  rclcpp::Node::SharedPtr secondary_node_;
  std::size_t primary_domain_id_;
  std::size_t secondary_domain_id_;
  std::vector<TopicBridge> bridges_;
};

}  // namespace pacific_rim::communication::ros2::domain_bridge
