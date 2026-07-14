from launch import LaunchDescription
from launch.substitutions import PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
  params_file = PathJoinSubstitution([
    FindPackageShare("middleware_rpc_client_test"),
    "config",
    "params.yaml",
  ])

  return LaunchDescription([
    Node(
      package="middleware_rpc_client_test",
      executable="middleware_rpc_client_test_node",
      name="middleware_rpc_client_test",
      output="screen",
      parameters=[params_file],
    )
  ])
