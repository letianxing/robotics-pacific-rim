cmake_minimum_required(VERSION 3.8)
project(middleware_pub_test)

find_package(ament_cmake REQUIRED)
find_program(GO_EXECUTABLE go REQUIRED)

add_custom_target(middleware_pub_test_node ALL
  COMMAND ${CMAKE_COMMAND} -E env
    GOCACHE=${CMAKE_BINARY_DIR}/go-cache
    ${GO_EXECUTABLE} build
      -o ${CMAKE_CURRENT_BINARY_DIR}/middleware_pub_test_node
      ./cmd/middleware_pub_test
  WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
)

install(PROGRAMS ${CMAKE_CURRENT_BINARY_DIR}/middleware_pub_test_node
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY launch config
  DESTINATION share/${PROJECT_NAME}
)

ament_package()
