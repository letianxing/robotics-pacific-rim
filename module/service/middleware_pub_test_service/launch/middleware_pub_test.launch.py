from launch import LaunchDescription
from launch.substitutions import PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
  config_path = PathJoinSubstitution([
    FindPackageShare("middleware_pub_test"),
    "config",
    "config.yaml",
  ])

  return LaunchDescription([
    Node(
      package="middleware_pub_test",
      executable="middleware_pub_test_node",
      name="middleware_pub_test",
      output="screen",
      arguments=["--config", config_path],
    ),
  ])
