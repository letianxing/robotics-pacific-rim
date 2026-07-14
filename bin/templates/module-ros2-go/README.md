# module-{{name}}

{{title}} ROS2 Go module.

The process entrypoint starts shared communication bootstrap from
`infra/communication/go`. Define public IDL under `pkg/idl/{{name}}/{pb,ros2,public}`,
bind logical services/topics in `config/config.yaml`, run
`tools/generate-interfaces.sh`, then implement business behavior under
`internal/service`.

Routes choose only `data` (`msg`, `srv`, or `proto`) plus `middleware` (`nats`,
`cyclonedds`, or `ros2`) and optional QoS. The communication runtime expands
that contract to native CycloneDDS, RMW CycloneDDS, ROS2 protobuf envelope, or
native ROSIDL as needed.

For Go ROS2 native builds, set
`PACIFIC_RIM_GO_BUILD_TAGS=pacific_rim_ros2_rclgo` inside the selected ROS
distro environment. `ROS_DISTRO=humble|jazzy|kilted|lyrical|rolling` controls
the `/opt/ros/<distro>` cgo include/lib paths used by CMake. CMake runs
`tools/generate-ros2-bindings.sh` and imports generated rclgo bindings through
`internal/api/generated`; business code should not import rclgo packages. If a
deployment uses a sidecar bridge instead, it keeps the same route config.
