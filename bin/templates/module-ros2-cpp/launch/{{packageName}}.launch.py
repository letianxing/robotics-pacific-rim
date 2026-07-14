from launch import LaunchDescription
from launch.substitutions import PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
  params_file = PathJoinSubstitution([
    FindPackageShare("{{packageName}}"),
    "config",
    "params.yaml",
  ])

  return LaunchDescription([
    Node(
      package="{{packageName}}",
      executable="{{executableName}}",
      name="{{packageName}}",
      output="screen",
      parameters=[params_file],
    )
  ])
