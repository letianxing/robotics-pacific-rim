#include <memory>

#include "ament_index_cpp/get_package_share_directory.hpp"
#include "infra/communication/cpp/core/bootstrap.hpp"
#include "pacific_rim/log/log.hpp"
#include "pacific_rim/metric/metric.hpp"
#include "pacific_rim/trace/trace.hpp"
#include "rclcpp/rclcpp.hpp"
#include "runtime/ros2/generated_interface_registry.hpp"

class MiddlewareRpcClientTestNode : public rclcpp::Node {
public:
  MiddlewareRpcClientTestNode() : Node("middleware_rpc_client_test") {
    const auto config_path =
        ament_index_cpp::get_package_share_directory("middleware_rpc_client_test") +
        "/config/config.yaml";
    communication_runtime_ =
        std::make_unique<pacific_rim::communication::core::CommunicationRuntime>(
            pacific_rim::communication::core::BootstrapCommunication(
                config_path,
                "middleware_rpc_client_test"));
    generated_interfaces_ =
        pacific_rim::generated::middleware_rpc_client_test::register_generated_interfaces(
            *this,
            *communication_runtime_);

    auto span = pacific_rim::trace::start_span("middleware_rpc_client_test.startup");
    startup_counter_.add();
    pacific_rim::log::info(
        get_logger(),
        "Middleware Rpc Client Test node started",
        {
            {"traceId", span.ids().trace_id},
            {"spanId", span.ids().span_id},
        });
    span.end();
  }

private:
  // After adding pkg/idl contracts and routes, generate a registry with:
  // ./tools/generate-interfaces.sh
  // Generated route bindings live in this module. Shared protocol abstractions
  // live in pkg/idl. Keep business logic outside node.cpp.
  pacific_rim::metric::Counter startup_counter_{
      pacific_rim::metric::message_count};
  std::unique_ptr<pacific_rim::communication::core::CommunicationRuntime>
      communication_runtime_;
  pacific_rim::generated::middleware_rpc_client_test::GeneratedInterfaceHandles
      generated_interfaces_;
};

int main(int argc, char **argv) {
  pacific_rim::communication::dds::EnsureCycloneDdsRmw();
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<MiddlewareRpcClientTestNode>());
  rclcpp::shutdown();
  return 0;
}
