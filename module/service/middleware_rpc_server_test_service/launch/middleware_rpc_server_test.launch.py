from launch import LaunchDescription
from launch.substitutions import PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
  config_path = PathJoinSubstitution([
    FindPackageShare("middleware_rpc_server_test"),
    "config",
    "config.yaml",
  ])

  return LaunchDescription([
    Node(
      package="middleware_rpc_server_test",
      executable="middleware_rpc_server_test_node",
      name="middleware_rpc_server_test",
      output="screen",
      arguments=["--config", config_path],
    ),
  ])
