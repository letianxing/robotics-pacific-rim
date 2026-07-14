from launch import LaunchDescription
from launch.substitutions import PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
  config_path = PathJoinSubstitution([
    FindPackageShare("{{packageName}}"),
    "config",
    "config.yaml",
  ])

  return LaunchDescription([
    Node(
      package="{{packageName}}",
      executable="{{executableName}}",
      name="{{packageName}}",
      output="screen",
      arguments=["--config", config_path],
    ),
  ])
