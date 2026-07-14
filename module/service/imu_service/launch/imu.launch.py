from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch.substitutions import PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
  params_file = PathJoinSubstitution([
    FindPackageShare("imu"),
    "config",
    "params.yaml",
  ])

  return LaunchDescription([
    DeclareLaunchArgument(
      "params_file",
      default_value=params_file,
      description="Parameter YAML for imu_node.",
    ),
    DeclareLaunchArgument(
      "sample_name",
      default_value="pure_driver_sample",
      description="Sample name parameter for imu_node.",
    ),
    Node(
      package="imu",
      executable="imu_node",
      name="imu",
      output="screen",
      parameters=[
        LaunchConfiguration("params_file"),
        {
          "sample_name": LaunchConfiguration("sample_name"),
        },
      ],
    )
  ])
