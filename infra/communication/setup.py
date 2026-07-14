from setuptools import find_namespace_packages, setup

package_name = "pacific_rim_communication_infra"

setup(
    name=package_name,
    version="0.1.0",
    package_dir={"": "python"},
    packages=find_namespace_packages(where="python"),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
    ],
    install_requires=["setuptools", "nats-py", "PyYAML", "pacific_rim_protocol_infra"],
    zip_safe=True,
    maintainer="Pacific-Rim Developers",
    maintainer_email="dev@example.com",
    description="Reusable communication bridge runtimes for Pacific-Rim modules.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "nats_ros2_bridge_node = pacific_rim_communication_infra.ros2.nats_bridge_node:main",
        ],
    },
)
