cmake_minimum_required(VERSION 3.8)
project(middleware_rpc_client_test)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
endif()

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(ament_index_cpp REQUIRED)
find_package(yaml-cpp REQUIRED)
find_package(common REQUIRED)
find_package(CycloneDDS REQUIRED)
find_package(fastcdr REQUIRED)
find_package(fastrtps REQUIRED)

add_executable(middleware_rpc_client_test_node src/node.cpp)
ament_target_dependencies(middleware_rpc_client_test_node rclcpp ament_index_cpp common)

target_include_directories(middleware_rpc_client_test_node PRIVATE
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/../..>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/../../..>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src/api/handler/include>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src/api/publisher/include>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src/service>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src/service/generated/include>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/src/runtime/ros2>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/../../../infra/communication/cpp/include>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/../../../infra/log/cpp/include>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/../../../infra/metric/cpp/include>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/../../../infra/otel/cpp/include>
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/../../../infra/trace/cpp/include>
  $<INSTALL_INTERFACE:include>
)

target_link_libraries(middleware_rpc_client_test_node yaml-cpp CycloneDDS::ddsc fastcdr fastrtps)

install(TARGETS middleware_rpc_client_test_node
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY launch config
  DESTINATION share/${PROJECT_NAME}
)

ament_package()
