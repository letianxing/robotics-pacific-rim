#include <chrono>
#include <memory>

#include "rclcpp/rclcpp.hpp"

class ImuNode : public rclcpp::Node {
public:
  ImuNode() : Node("imu") {
    declare_parameter("sample_name", "pure_driver_sample");
    heartbeat_timer_ = create_wall_timer(
        std::chrono::seconds(5),
        [this]() {
          RCLCPP_INFO_THROTTLE(
              get_logger(),
              *get_clock(),
              30000,
              "imu_service sample node is running");
        });
  }

private:
  rclcpp::TimerBase::SharedPtr heartbeat_timer_;
};

int main(int argc, char **argv) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<ImuNode>());
  rclcpp::shutdown();
  return 0;
}
