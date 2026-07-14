cmake_minimum_required(VERSION 3.8)
project({{packageName}})

find_package(ament_cmake REQUIRED)
find_package(common REQUIRED)
find_program(GO_EXECUTABLE go REQUIRED)
find_program(BASH_EXECUTABLE bash REQUIRED)

set(PACIFIC_RIM_GO_BUILD_TAGS "$ENV{PACIFIC_RIM_GO_BUILD_TAGS}" CACHE STRING "Extra Go build tags for this ROS2 Go module")
set(PACIFIC_RIM_GO_ROS_DISTRO "$ENV{ROS_DISTRO}" CACHE STRING "ROS2 distribution used to build Go ROS2 bindings")
if(PACIFIC_RIM_GO_ROS_DISTRO STREQUAL "")
  set(PACIFIC_RIM_GO_ROS_DISTRO "{{rosDistro}}")
endif()
set(PACIFIC_RIM_GO_ROS_PREFIX "/opt/ros/${PACIFIC_RIM_GO_ROS_DISTRO}" CACHE PATH "ROS2 prefix used for Go cgo flags")
set(PACIFIC_RIM_GO_ROS_CFLAGS
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/rcl"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/rmw"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/rosidl_runtime_c"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/rosidl_typesupport_interface"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/rcutils"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/rcl_action"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/action_msgs"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/unique_identifier_msgs"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/builtin_interfaces"
  "-I${PACIFIC_RIM_GO_ROS_PREFIX}/include/rcl_yaml_param_parser"
)
list(JOIN PACIFIC_RIM_GO_ROS_CFLAGS " " PACIFIC_RIM_GO_ROS_CFLAGS_JOINED)

set(PACIFIC_RIM_GO_BUILD_ARGS build)
if(NOT PACIFIC_RIM_GO_BUILD_TAGS STREQUAL "")
  list(APPEND PACIFIC_RIM_GO_BUILD_ARGS -tags ${PACIFIC_RIM_GO_BUILD_TAGS})
endif()

set(PACIFIC_RIM_GO_ROS2_BINDING_COMMAND)
if(PACIFIC_RIM_GO_BUILD_TAGS MATCHES "(^|[, ])pacific_rim_ros2_rclgo($|[, ])")
  set(PACIFIC_RIM_GO_ROS2_BINDING_COMMAND
    COMMAND ${CMAKE_COMMAND} -E env
      ROS_DISTRO=${PACIFIC_RIM_GO_ROS_DISTRO}
      PACIFIC_RIM_GO_ROS_PREFIX=${PACIFIC_RIM_GO_ROS_PREFIX}
      CGO_ENABLED=1
      GOCACHE=${CMAKE_BINARY_DIR}/go-cache
      "CGO_CFLAGS=${PACIFIC_RIM_GO_ROS_CFLAGS_JOINED}"
      CGO_LDFLAGS=-L${PACIFIC_RIM_GO_ROS_PREFIX}/lib
      ${BASH_EXECUTABLE}
        ${CMAKE_CURRENT_SOURCE_DIR}/tools/generate-ros2-bindings.sh
  )
endif()

add_custom_target({{executableName}} ALL
  ${PACIFIC_RIM_GO_ROS2_BINDING_COMMAND}
  COMMAND ${CMAKE_COMMAND} -E env
    CGO_ENABLED=1
    GOCACHE=${CMAKE_BINARY_DIR}/go-cache
    "CGO_CFLAGS=${PACIFIC_RIM_GO_ROS_CFLAGS_JOINED}"
    CGO_LDFLAGS=-L${PACIFIC_RIM_GO_ROS_PREFIX}/lib
    ${GO_EXECUTABLE}
      ${PACIFIC_RIM_GO_BUILD_ARGS}
      -o ${CMAKE_CURRENT_BINARY_DIR}/{{executableName}}
      ./cmd/{{packageName}}
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
)

install(PROGRAMS ${CMAKE_CURRENT_BINARY_DIR}/{{executableName}}
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY launch config
  DESTINATION share/${PROJECT_NAME}
)

ament_package()
