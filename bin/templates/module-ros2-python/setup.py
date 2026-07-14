from setuptools import find_packages, setup
from pathlib import Path

package_name = "{{packageName}}"
workspace_root = Path(__file__).resolve().parents[2]

setup(
  name=package_name,
  version="0.1.0",
  packages=find_packages(exclude=["test"])
  + find_packages(where=str(workspace_root / "infra/protocol/python"))
  + find_packages(where=str(workspace_root / "infra/communication/python"))
  + find_packages(where=str(workspace_root / "infra/otel/python"))
  + find_packages(where=str(workspace_root / "infra/log/python"))
  + find_packages(where=str(workspace_root / "infra/metric/python"))
  + find_packages(where=str(workspace_root / "infra/trace/python")),
  package_dir={
    "pacific_rim_protocol": str(workspace_root / "infra/protocol/python/pacific_rim_protocol"),
    "pacific_rim_communication_infra": str(workspace_root / "infra/communication/python/pacific_rim_communication_infra"),
    "pacific_rim_otel": str(workspace_root / "infra/otel/python/pacific_rim_otel"),
    "pacific_rim_log": str(workspace_root / "infra/log/python/pacific_rim_log"),
    "pacific_rim_metric": str(workspace_root / "infra/metric/python/pacific_rim_metric"),
    "pacific_rim_trace": str(workspace_root / "infra/trace/python/pacific_rim_trace"),
  },
  data_files=[
    ("share/ament_index/resource_index/packages", [f"resource/{package_name}"]),
    (f"share/{package_name}", ["package.xml"]),
    (f"share/{package_name}/launch", ["launch/{{packageName}}.launch.py"]),
    (f"share/{package_name}/config", ["config/params.yaml", "config/config.yaml"]),
  ],
  install_requires=["setuptools"],
  zip_safe=True,
  maintainer="Pacific-Rim Developers",
  maintainer_email="dev@example.com",
  description="{{title}} ROS2 Python module.",
  license="TODO",
  entry_points={
    "console_scripts": [
      "{{executableName}} = {{packageName}}.node:main",
    ],
  },
)
