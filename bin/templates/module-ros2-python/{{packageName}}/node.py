import os

import rclpy
from rclpy.node import Node
from ament_index_python.packages import get_package_share_directory
from pathlib import Path
from pacific_rim_communication_infra import CommunicationRuntimeThread
from {{packageName}}.api.generated.register import register_generated_interfaces


class {{className}}Node(Node):
  def __init__(self):
    super().__init__("{{packageName}}")
    self._communication_thread = None
    self.communication = self.start_communication()
    self.run_communication(register_generated_interfaces(self.communication))
    # After adding pkg/idl contracts and config routes, run tools/generate-interfaces.sh.
    # Generated route bindings live in this module; shared abstractions live in pkg/idl.

  def start_communication(self):
    config_path = Path(get_package_share_directory("{{packageName}}")) / "config" / "config.yaml"
    self._communication_thread = CommunicationRuntimeThread(config_path)
    runtime = self._communication_thread.start()
    return runtime

  def run_communication(self, coroutine):
    if self._communication_thread is None:
      raise RuntimeError("communication runtime is not started")
    return self._communication_thread.run(coroutine)

  def stop_communication(self):
    if self._communication_thread is not None:
      self._communication_thread.stop()
      self._communication_thread = None
    self.communication = None


def main(args=None):
  os.environ.setdefault("RMW_IMPLEMENTATION", "rmw_cyclonedds_cpp")
  rclpy.init(args=args)
  node = {{className}}Node()

  try:
    rclpy.spin(node)
  except KeyboardInterrupt:
    pass
  finally:
    node.stop_communication()
    node.destroy_node()
    if rclpy.ok():
      rclpy.shutdown()


if __name__ == "__main__":
  main()
