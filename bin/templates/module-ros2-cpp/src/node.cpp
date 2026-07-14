#include <memory>

#include "ament_index_cpp/get_package_share_directory.hpp"
#include "infra/communication/cpp/core/bootstrap.hpp"
#include "rclcpp/rclcpp.hpp"
#include "runtime/ros2/generated_interface_registry.hpp"

class {{className}}Node : public rclcpp::Node {
public:
  {{className}}Node() : Node("{{packageName}}") {
    const auto config_path =
        ament_index_cpp::get_package_share_directory("{{packageName}}") +
        "/config/config.yaml";
    communication_runtime_ =
        std::make_unique<pacific_rim::communication::core::CommunicationRuntime>(
            pacific_rim::communication::core::BootstrapCommunication(
                config_path,
                "{{packageName}}"));
    generated_interfaces_ =
        pacific_rim::generated::{{packageName}}::register_generated_interfaces(
            *this,
            *communication_runtime_);
  }

private:
  // After adding pkg/idl contracts and routes, generate a registry with:
  // ./tools/generate-interfaces.sh
  // Generated route bindings live in this module. Shared role files live in
  // pkg/idl. Keep business logic outside node.cpp.
  std::unique_ptr<pacific_rim::communication::core::CommunicationRuntime>
      communication_runtime_;
  pacific_rim::generated::{{packageName}}::GeneratedInterfaceHandles
      generated_interfaces_;
};

int main(int argc, char **argv) {
  pacific_rim::communication::dds::EnsureCycloneDdsRmw();
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<{{className}}Node>());
  rclcpp::shutdown();
  return 0;
}
