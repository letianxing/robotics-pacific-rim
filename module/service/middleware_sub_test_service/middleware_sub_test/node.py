import rclpy
import importlib
import sys
from rclpy.node import Node
from ament_index_python.packages import get_package_share_directory
from pathlib import Path
from pacific_rim_log import info
from pacific_rim_metric import counter, runtime_metric_names
from pacific_rim_otel import init_observability
from pacific_rim_trace import start_span
from pacific_rim_communication_infra import CommunicationRuntimeThread


def load_generated_register():
  for root in Path(__file__).resolve().parents:
    generated_root = root / "pkg" / "idl" / "middleware_sub_test_service" / "generated"
    candidate = generated_root / "python" / "register.py"
    if candidate.exists():
      sys.path.insert(0, str(generated_root))
      module = importlib.import_module("python.register")
      return module.register_generated_interfaces
  async def register_generated_interfaces(runtime, provider=None):
    _ = runtime
    _ = provider
  return register_generated_interfaces


class MiddlewareSubTestNode(Node):
  def __init__(self):
    super().__init__("middleware_sub_test")
    self.observability = init_observability("middleware_sub_test")
    self._communication_thread = None
    self.communication = self.start_communication()
    self.run_communication(load_generated_register()(self.communication))
    span = start_span("middleware_sub_test.startup")
    counter(runtime_metric_names["message_count"]).add()
    info(
      "Middleware Sub Test node started",
      {
        "traceId": span.trace_id,
        "spanId": span.span_id,
      },
    )
    span.end()
    # After adding pkg/idl contracts and config routes, run tools/generate-interfaces.sh.
    # Generated route bindings live in pkg/idl; middleware bootstrap stays in infra.

  def start_communication(self):
    config_path = Path(get_package_share_directory("middleware_sub_test")) / "config" / "config.yaml"
    self._communication_thread = CommunicationRuntimeThread(config_path)
    runtime = self._communication_thread.start()
    info("Middleware Sub Test communication started", {"config": str(config_path)})
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
  rclpy.init(args=args)
  node = MiddlewareSubTestNode()

  try:
    rclpy.spin(node)
  except KeyboardInterrupt:
    pass
  finally:
    node.stop_communication()
    node.observability.shutdown()
    node.destroy_node()
    if rclpy.ok():
      rclpy.shutdown()


if __name__ == "__main__":
  main()
