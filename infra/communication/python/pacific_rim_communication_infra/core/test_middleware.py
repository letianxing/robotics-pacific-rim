import asyncio
import os
import tempfile
import unittest
from pathlib import Path

from pacific_rim_communication_infra.contracts import Endpoint, MiddlewareConfig, RpcRoute, TransportKind
from pacific_rim_protocol import JsonCodec, ProtobufCodec, RawBytesCodec
from pacific_rim_communication_infra.core import (
  Channel,
  CommunicationFabric,
  TypedMessageBus,
  FanoutMessageBus,
  CommunicationRuntimeThread,
  bootstrap_communication,
  create_message_bus,
  create_message_bus_from_config,
  load_communication_config,
  load_communication_config_file,
  load_service_communication_config,
  normalize_transport_kind,
)
from pacific_rim_communication_infra.dds import (
  CycloneDdsMessageBus,
  clear_typed_dds_topic_types,
  register_typed_dds_topic_type,
)
from pacific_rim_communication_infra.fastdds import FastDdsMessageBus
from pacific_rim_communication_infra.nats import NatsMessageBus
from pacific_rim_communication_infra.ros2.communication_config import rules_from_communication_config
from pacific_rim_communication_infra.ros2.envelope_bus import Ros2ProtoEnvelopeBus


def _restore_env(key: str, value: str | None) -> None:
  if value is None:
    os.environ.pop(key, None)
  else:
    os.environ[key] = value


class FakeProto:
  def __init__(self):
    self.value = b""

  def SerializeToString(self):
    return self.value

  def ParseFromString(self, data):
    self.value = bytes(data)


class FakeBus:
  def __init__(self):
    self.published = []
    self.handler = None
    self.request_handler = None

  async def connect(self):
    pass

  async def close(self):
    pass

  async def publish_bytes(self, channel, payload):
    self.published.append((channel, payload))

  async def subscribe_bytes(self, channel, handler):
    self.handler = handler

  async def request_bytes(self, channel, payload, timeout_sec=2.0):
    return payload + b"-response"

  async def handle_request_bytes(self, channel, handler):
    self.request_handler = handler


class FakeDdsRPCAdapter:
  def __init__(self):
    self.binding = None
    self.payload = b""
    self.timeout_sec = 0.0
    self.handler_response = b""

  async def request(self, binding, payload, timeout_sec):
    self.binding = binding
    self.payload = payload
    self.timeout_sec = timeout_sec
    return b"dds-response"

  async def handle_request(self, binding, handler):
    self.binding = binding
    result = handler(b"dds-request")
    if asyncio.iscoroutine(result):
      result = await result
    self.handler_response = result


class FakeCycloneDdsClient:
  def __init__(self):
    self.config = type("Config", (), {"qos": {}})()
    self.published = []
    self.subscriptions = []
    self.is_connected = True

  async def connect(self):
    self.is_connected = True
    pass

  async def close(self):
    self.is_connected = False
    pass

  async def publish(self, topic, payload):
    self.published.append((topic, payload))
    for subscription, callback in list(self.subscriptions):
      if subscription.topic.topic_name == topic.topic_name:
        result = callback(payload)
        if asyncio.iscoroutine(result):
          await result

  async def prepare_publish(self, topic):
    pass

  async def subscribe(self, subscription, callback):
    entry = (subscription, callback)
    self.subscriptions.append(entry)

    def unsubscribe():
      try:
        self.subscriptions.remove(entry)
      except ValueError:
        pass

    return unsubscribe


class MiddlewareTest(unittest.TestCase):
  def test_normalize_transport_kind_accepts_aliases(self):
    self.assertEqual(normalize_transport_kind("nats"), TransportKind.NATS)
    self.assertEqual(normalize_transport_kind("cyclone-dds"), TransportKind.CYCLONE_DDS)
    self.assertEqual(normalize_transport_kind("dds"), TransportKind.CYCLONE_DDS)
    with self.assertRaises(ValueError):
      normalize_transport_kind("cyclonedds-rmw-cyclonedds")
    with self.assertRaises(ValueError):
      normalize_transport_kind("fastdds-rmw-fastrtps")

  def test_create_message_bus_from_enum_and_config(self):
    bus = create_message_bus(TransportKind.NATS, {"server_url": "nats://example:4222"})
    self.assertIsInstance(bus, NatsMessageBus)
    self.assertTrue(bus.capabilities.request_reply)

    config_bus = create_message_bus_from_config(
      MiddlewareConfig(
        transport=TransportKind.CYCLONE_DDS,
        options={"domain_id": 7},
      )
    )
    self.assertIsInstance(config_bus, CycloneDdsMessageBus)
    self.assertTrue(config_bus.capabilities.request_reply)

  def test_load_communication_config_builds_fabric(self):
    config = load_communication_config(
      {
        "middleware": {
          "default_nats": {
            "transport": "nats",
            "server_url": "nats://example:4222",
          },
          "fast_dds": {
            "transport": "cyclonedds",
            "options": {"domain_id": 3},
            "qos": {"reliability": "reliable", "depth": 10},
          },
        },
        "pubsub_routes": [
          {
            "name": "state_updates",
            "publisher": {"transport": "nats", "address": "robot.state"},
            "subscriber": {
              "transport": "cyclonedds",
              "address": "RobotState",
              "qos": {"reliability": "best_effort", "deadline_ms": 50},
            },
          }
        ],
        "rpc_routes": [
          {
            "name": "submit_action",
            "client": {"transport": "nats", "address": "robo.brain"},
            "server": {"transport": "nats", "address": "action.submit"},
          }
        ],
      }
    )

    self.assertEqual(config.middleware["default_nats"].options["server_url"], "nats://example:4222")
    self.assertEqual(config.middleware["fast_dds"].options["qos.reliability"], "reliable")
    fabric = config.create_fabric()
    self.assertEqual(fabric.publisher("state_updates").channel.name, "robot.state")
    self.assertEqual(fabric.rpc_client("submit_action").channel.name, "action.submit")

  def test_fabric_channels_carry_queue_group_metadata(self):
    bus = FakeBus()
    fabric = CommunicationFabric(
      buses={"local_nats": bus},
      bus_configs={
        "local_nats": MiddlewareConfig(
          transport=TransportKind.NATS,
          name="local_nats",
          options={},
        )
      },
      rpc_routes=[
        RpcRoute(
          name="play_action",
          client=Endpoint(
            transport=TransportKind.NATS,
            address="action.client",
            metadata={"middleware": "local_nats"},
          ),
          server=Endpoint(
            transport=TransportKind.NATS,
            address="robot.rpc.play_action",
            metadata={
              "middleware": "local_nats",
              "queue_group": "action_service",
            },
          ),
        )
      ],
    )

    self.assertEqual(fabric.rpc_server("play_action").channel.queue_group, "action_service")
    self.assertEqual(fabric.rpc_client("play_action").channel.queue_group, "action_service")

  def test_bootstrap_communication_connects_empty_config(self):
    async def run():
      with tempfile.TemporaryDirectory() as tmp:
        config_path = Path(tmp) / "config.json"
        config_path.write_text('{"communication":{"middleware":{}}}', encoding="utf-8")
        runtime = await bootstrap_communication(config_path)
        self.assertEqual(runtime.config_path, config_path)
        await runtime.close()

    asyncio.run(run())

  def test_communication_runtime_thread_starts_empty_config(self):
    with tempfile.TemporaryDirectory() as tmp:
      config_path = Path(tmp) / "config.json"
      config_path.write_text('{"communication":{"middleware":{}}}', encoding="utf-8")
      runtime_thread = CommunicationRuntimeThread(config_path)
      runtime = runtime_thread.start()
      self.assertEqual(runtime.config_path, config_path)
      runtime_thread.stop()

  def test_load_service_communication_config_from_business_section(self):
    middleware, pubsub_routes, rpc_routes = load_service_communication_config(
      {
        "trace": {"service_name": "robo-brain"},
        "communication": {
          "middleware": {
            "action_nats": {
              "transport": "nats",
              "server_url": "nats://example:4222",
            },
            "motion_dds": {
              "transport": "cyclonedds",
              "domain_id": 3,
              "qos": {"reliability": "reliable"},
            },
          },
          "topics": {
            "robot_state": {
              "transport": "cyclonedds_topic",
              "direction": "subscribe",
              "topic": "RobotState",
              "queue_size": 5,
              "qos": {"reliability": "best_effort", "deadline_ms": 50},
            }
          },
          "services": {
            "play_action": {
              "transport": "nats_rpc",
              "subject": "robot.rpc.play_action",
              "timeout": "2s",
            }
          },
        },
      }
    )

    self.assertEqual(middleware["action_nats"].transport, TransportKind.NATS)
    self.assertEqual(middleware["motion_dds"].options["qos.reliability"], "reliable")
    self.assertEqual(pubsub_routes[0].subscriber.address, "RobotState")
    self.assertEqual(pubsub_routes[0].subscriber.metadata["qos.reliability"], "best_effort")
    self.assertEqual(pubsub_routes[0].subscriber.metadata["qos.deadline_ms"], 50)
    self.assertEqual(pubsub_routes[0].subscriber.metadata["qos.depth"], 5)
    self.assertEqual(rpc_routes[0].server.address, "robot.rpc.play_action")
    self.assertEqual(rpc_routes[0].timeout_ms, 2000)

  def test_load_service_communication_config_expands_bindings(self):
    _, pubsub_routes, rpc_routes = load_service_communication_config(
      {
        "trace": {"service_name": "robo-brain"},
        "communication": {
          "topics": {
            "robot_state": {
              "direction": "publish",
              "message_type": "RobotState",
              "bindings": [
                {"transport": "ros2_topic", "topic": "/robot/state"},
                {"transport": "nats_topic", "middleware": "action_nats", "subject": "robot.state"},
              ],
            }
          },
          "services": {
            "play_action": {
              "service_type": "action_service/srv/PlayAction",
              "bindings": [
                {"transport": "ros2_service", "service": "/action_service_node/play_action"},
                {"transport": "nats_rpc", "middleware": "action_nats", "subject": "robot.rpc.play_action"},
              ],
            }
          },
        },
      }
    )

    self.assertEqual(len(pubsub_routes), 2)
    self.assertEqual({route.publisher.address for route in pubsub_routes}, {"/robot/state", "robot.state"})
    self.assertEqual(len(rpc_routes), 2)
    self.assertEqual({route.server.address for route in rpc_routes}, {"/action_service_node/play_action", "robot.rpc.play_action"})
    self.assertTrue(all(route.server.metadata["logical_route"] == "play_action" for route in rpc_routes))

  def test_load_service_communication_config_accepts_cyclonedds_rpc_standard(self):
    _, _, rpc_routes = load_service_communication_config(
      {
        "trace": {"service_name": "planner"},
        "communication": {
          "services": {
            "plan_action": {
              "contract": {"format": "protobuf_rpc", "type": "demo.Planner/Plan"},
              "bindings": [
                {
                  "transport": "cyclonedds_rpc",
                  "middleware": "motion_dds",
                  "standard": "rmw_cyclonedds",
                  "request": "planner.request.plan_action",
                  "response": "planner.response.plan_action",
                }
              ],
            }
          }
        },
      }
    )

    self.assertEqual(len(rpc_routes), 1)
    route = rpc_routes[0]
    self.assertEqual(route.server.transport, TransportKind.CYCLONE_DDS)
    self.assertEqual(route.server.address, "planner.request.plan_action")
    self.assertEqual(route.server.message_type, "demo.Planner/Plan")
    self.assertEqual(route.server.metadata["rpc.transport"], "cyclonedds_rpc")
    self.assertEqual(route.server.metadata["rpc.standard"], "rmw_cyclonedds")
    self.assertEqual(route.server.metadata["rpc.response_channel"], "planner.response.plan_action")

  def test_load_service_communication_config_expands_high_level_routes(self):
    middleware, pubsub_routes, rpc_routes = load_service_communication_config(
      {
        "trace": {"service_name": "planner"},
        "communication": {
          "topics": {
            "proto_state": {
              "data": "proto",
              "type": "demo.RobotState",
              "middleware": "ros2",
              "topic": "/demo/proto_state",
              "direction": "publish",
            },
            "type_only_proto_state": {
              "type": "demo.TypeOnlyState",
              "middleware": "cyclonedds",
              "topic": "/demo/type_only_proto_state",
              "direction": "publish",
            },
            "joint_state": {
              "data": "msg",
              "type": "sensor_msgs/msg/JointState",
              "middleware": "cyclonedds",
              "topic": "JointState",
              "direction": "subscribe",
              "queue_size": 7,
            },
            "fast_state": {
              "data": "proto",
              "type": "demo.FastState",
              "middleware": "fastdds",
              "topic": "/demo/fast_state",
              "direction": "publish",
            },
            "dds_idl_state": {
              "data": "dds_idl",
              "type": "demo::DdsState",
              "middleware": "fastdds",
              "topic": "/demo/dds_idl_state",
              "direction": "publish",
            },
            "omg_idl_state": {
              "data": "omg_idl",
              "type": "demo::OmgState",
              "middleware": "cyclonedds",
              "topic": "/demo/omg_idl_state",
              "direction": "publish",
            },
            "cyclone_rmw_state": {
              "data": "msg",
              "type": "demo/msg/CycloneRMWState",
              "middleware": "cyclonedds",
              "topic": "/demo/cyclone_rmw_state",
              "direction": "publish",
            },
          },
          "services": {
            "plan_action": {
              "data": "proto",
              "type": "demo.Planner/Plan",
              "middleware": "cyclonedds",
              "service": "/demo/plan_action",
            },
            "type_only_plan": {
              "type": "demo.Planner/TypeOnlyPlan",
              "middleware": "cyclonedds",
              "service": "/demo/type_only_plan",
            },
            "play_action": {
              "data": "srv",
              "type": "demo/srv/PlayAction",
              "middleware": "ros2",
              "service": "/demo/play_action",
            },
            "fast_play": {
              "data": "srv",
              "type": "demo/srv/FastPlay",
              "middleware": "fastdds",
              "service": "/demo/fast_play",
            },
            "dds_idl_plan": {
              "data": "dds_idl",
              "type": "demo::DdsPlanner",
              "middleware": "fastdds",
              "service": "/demo/dds_idl_plan",
            },
            "omg_idl_plan": {
              "data": "omg_idl",
              "type": "demo::OmgPlanner",
              "middleware": "cyclonedds",
              "service": "/demo/omg_idl_plan",
            },
            "cyclone_rmw_plan": {
              "data": "srv",
              "type": "demo/srv/CycloneRMWPlan",
              "middleware": "cyclonedds",
              "service": "/demo/cyclone_rmw_plan",
            },
          },
        },
      }
    )

    self.assertEqual(middleware["ros2"].transport, TransportKind.ROS2)
    self.assertEqual(middleware["cyclonedds"].transport, TransportKind.CYCLONE_DDS)
    self.assertEqual(middleware["cyclonedds"].options["implementation"], "native_cyclonedds")
    self.assertEqual(middleware["cyclonedds__rmw"].transport, TransportKind.ROS2)
    self.assertEqual(middleware["cyclonedds__rmw"].options["middleware.family"], "cyclonedds")
    self.assertEqual(middleware["cyclonedds__rmw"].options["implementation"], "rmw_cyclonedds")
    self.assertEqual(middleware["cyclonedds__rmw"].options["rmw_implementation"], "rmw_cyclonedds_cpp")
    self.assertEqual(middleware["fastdds__rmw"].transport, TransportKind.ROS2)
    self.assertEqual(middleware["fastdds__rmw"].options["middleware.family"], "fastdds")
    self.assertEqual(middleware["fastdds__rmw"].options["implementation"], "rmw_fastrtps")
    self.assertEqual(middleware["fastdds__rmw"].options["rmw_implementation"], "rmw_fastrtps_cpp")
    self.assertEqual(middleware["fastdds"].transport, TransportKind.FAST_DDS)
    self.assertEqual(middleware["fastdds"].options["implementation"], "native_fastdds")
    topics = {route.name: route for route in pubsub_routes}
    proto_state = topics["proto_state"]
    self.assertEqual(proto_state.publisher.transport, TransportKind.ROS2)
    self.assertEqual(proto_state.publisher.metadata["adapter"], "ros2_proto_envelope")
    self.assertEqual(proto_state.publisher.metadata["codec"], "protobuf")
    self.assertEqual(proto_state.publisher.metadata["schema.type"], "demo.RobotState")
    type_only_proto_state = topics["type_only_proto_state"]
    self.assertEqual(type_only_proto_state.publisher.transport, TransportKind.CYCLONE_DDS)
    self.assertEqual(type_only_proto_state.publisher.metadata["middleware.implementation"], "native_cyclonedds")
    self.assertEqual(type_only_proto_state.publisher.metadata["codec"], "protobuf")
    self.assertEqual(type_only_proto_state.publisher.metadata["schema.type"], "demo.TypeOnlyState")
    joint_state = topics["joint_state"]
    self.assertEqual(joint_state.subscriber.transport, TransportKind.ROS2)
    self.assertEqual(joint_state.subscriber.metadata["middleware"], "cyclonedds")
    self.assertEqual(joint_state.subscriber.metadata["middleware.runtime"], "cyclonedds__rmw")
    self.assertNotIn("middleware.user", joint_state.subscriber.metadata)
    self.assertEqual(joint_state.subscriber.metadata["middleware.family"], "cyclonedds")
    self.assertEqual(joint_state.subscriber.metadata["middleware.implementation"], "rmw_cyclonedds")
    self.assertEqual(joint_state.subscriber.message_type, "sensor_msgs/msg/JointState")
    self.assertEqual(joint_state.subscriber.metadata["qos.depth"], 7)
    fast_state = topics["fast_state"]
    self.assertEqual(fast_state.publisher.transport, TransportKind.FAST_DDS)
    self.assertEqual(fast_state.publisher.metadata["middleware"], "fastdds")
    self.assertEqual(fast_state.publisher.metadata["middleware.family"], "fastdds")
    self.assertEqual(fast_state.publisher.metadata["middleware.implementation"], "native_fastdds")
    self.assertNotIn("adapter", fast_state.publisher.metadata)
    self.assertEqual(fast_state.publisher.metadata["codec"], "protobuf")
    self.assertEqual(fast_state.publisher.metadata["schema.type"], "demo.FastState")
    dds_idl_state = topics["dds_idl_state"]
    self.assertEqual(dds_idl_state.publisher.transport, TransportKind.FAST_DDS)
    self.assertEqual(dds_idl_state.publisher.metadata["middleware.implementation"], "native_fastdds")
    self.assertEqual(dds_idl_state.publisher.metadata["codec"], "cdr")
    self.assertEqual(dds_idl_state.publisher.metadata["schema.format"], "dds_idl")
    self.assertEqual(dds_idl_state.publisher.metadata["schema.language"], "omg_idl")
    self.assertEqual(dds_idl_state.publisher.metadata["schema.type"], "demo::DdsState")
    self.assertEqual(dds_idl_state.publisher.metadata["dds.mode"], "typed_preferred")
    self.assertEqual(dds_idl_state.publisher.metadata["dds.fallback"], "byte_envelope")
    self.assertEqual(dds_idl_state.publisher.metadata["dds.runtime"], "typed_native")
    self.assertEqual(dds_idl_state.publisher.metadata["dds.type"], "demo::DdsState")
    omg_idl_state = topics["omg_idl_state"]
    self.assertEqual(omg_idl_state.publisher.transport, TransportKind.CYCLONE_DDS)
    self.assertEqual(omg_idl_state.publisher.metadata["middleware.implementation"], "native_cyclonedds")
    self.assertEqual(omg_idl_state.publisher.metadata["schema.format"], "dds_idl")
    self.assertEqual(omg_idl_state.publisher.metadata["schema.language"], "omg_idl")
    cyclone_rmw_state = topics["cyclone_rmw_state"]
    self.assertEqual(cyclone_rmw_state.publisher.transport, TransportKind.ROS2)
    self.assertEqual(cyclone_rmw_state.publisher.metadata["middleware"], "cyclonedds")
    self.assertEqual(cyclone_rmw_state.publisher.metadata["middleware.runtime"], "cyclonedds__rmw")
    self.assertEqual(cyclone_rmw_state.publisher.metadata["middleware.family"], "cyclonedds")
    self.assertEqual(cyclone_rmw_state.publisher.metadata["middleware.implementation"], "rmw_cyclonedds")
    self.assertEqual(cyclone_rmw_state.publisher.metadata["rmw_implementation"], "rmw_cyclonedds_cpp")
    self.assertEqual(cyclone_rmw_state.publisher.message_type, "demo/msg/CycloneRMWState")
    self.assertNotIn("adapter", cyclone_rmw_state.publisher.metadata)
    services = {route.name: route for route in rpc_routes}
    plan_action = services["plan_action"]
    self.assertEqual(plan_action.server.transport, TransportKind.CYCLONE_DDS)
    self.assertEqual(plan_action.server.metadata["middleware"], "cyclonedds")
    self.assertEqual(plan_action.server.metadata["middleware.implementation"], "native_cyclonedds")
    self.assertNotIn("adapter", plan_action.server.metadata)
    self.assertEqual(plan_action.server.metadata["schema.type"], "demo.Planner/Plan")
    self.assertEqual(plan_action.server.metadata["rpc.standard"], "omg_dds_rpc")
    type_only_plan = services["type_only_plan"]
    self.assertEqual(type_only_plan.server.transport, TransportKind.CYCLONE_DDS)
    self.assertEqual(type_only_plan.server.metadata["middleware.implementation"], "native_cyclonedds")
    self.assertEqual(type_only_plan.server.metadata["codec"], "protobuf")
    self.assertEqual(type_only_plan.server.metadata["schema.type"], "demo.Planner/TypeOnlyPlan")
    play_action = services["play_action"]
    self.assertEqual(play_action.server.transport, TransportKind.ROS2)
    self.assertEqual(play_action.server.message_type, "demo/srv/PlayAction")
    self.assertNotIn("adapter", play_action.server.metadata)
    fast_play = services["fast_play"]
    self.assertEqual(fast_play.server.transport, TransportKind.ROS2)
    self.assertEqual(fast_play.server.metadata["middleware"], "fastdds")
    self.assertEqual(fast_play.server.metadata["middleware.runtime"], "fastdds__rmw")
    self.assertEqual(fast_play.server.metadata["middleware.family"], "fastdds")
    self.assertEqual(fast_play.server.metadata["middleware.implementation"], "rmw_fastrtps")
    self.assertEqual(fast_play.server.metadata["rmw_implementation"], "rmw_fastrtps_cpp")
    self.assertEqual(fast_play.server.message_type, "demo/srv/FastPlay")
    self.assertNotIn("adapter", fast_play.server.metadata)
    dds_idl_plan = services["dds_idl_plan"]
    self.assertEqual(dds_idl_plan.server.transport, TransportKind.FAST_DDS)
    self.assertEqual(dds_idl_plan.server.metadata["middleware.implementation"], "native_fastdds")
    self.assertEqual(dds_idl_plan.server.metadata["codec"], "cdr")
    self.assertEqual(dds_idl_plan.server.metadata["schema.format"], "dds_idl_rpc")
    self.assertEqual(dds_idl_plan.server.metadata["schema.language"], "omg_idl")
    self.assertEqual(dds_idl_plan.server.metadata["schema.type"], "demo::DdsPlanner")
    self.assertEqual(dds_idl_plan.server.metadata["dds.mode"], "typed_preferred")
    self.assertEqual(dds_idl_plan.server.metadata["dds.fallback"], "byte_envelope")
    self.assertEqual(dds_idl_plan.server.metadata["dds.runtime"], "typed_native")
    self.assertEqual(dds_idl_plan.server.metadata["rpc.standard"], "omg_dds_rpc")
    omg_idl_plan = services["omg_idl_plan"]
    self.assertEqual(omg_idl_plan.server.transport, TransportKind.CYCLONE_DDS)
    self.assertEqual(omg_idl_plan.server.metadata["middleware.implementation"], "native_cyclonedds")
    self.assertEqual(omg_idl_plan.server.metadata["schema.format"], "dds_idl_rpc")
    self.assertEqual(omg_idl_plan.server.metadata["schema.language"], "omg_idl")
    self.assertEqual(omg_idl_plan.server.metadata["rpc.standard"], "omg_dds_rpc")
    cyclone_rmw_plan = services["cyclone_rmw_plan"]
    self.assertEqual(cyclone_rmw_plan.server.transport, TransportKind.ROS2)
    self.assertEqual(cyclone_rmw_plan.server.metadata["middleware"], "cyclonedds")
    self.assertEqual(cyclone_rmw_plan.server.metadata["middleware.runtime"], "cyclonedds__rmw")
    self.assertEqual(cyclone_rmw_plan.server.metadata["middleware.family"], "cyclonedds")
    self.assertEqual(cyclone_rmw_plan.server.metadata["middleware.implementation"], "rmw_cyclonedds")
    self.assertEqual(cyclone_rmw_plan.server.metadata["rmw_implementation"], "rmw_cyclonedds_cpp")
    self.assertEqual(cyclone_rmw_plan.server.message_type, "demo/srv/CycloneRMWPlan")
    self.assertNotIn("adapter", cyclone_rmw_plan.server.metadata)

  def test_load_service_communication_config_adds_defaults_for_explicit_fastdds_middleware(self):
    middleware, _, _ = load_service_communication_config(
      {
        "trace": {"service_name": "planner"},
        "communication": {
          "middleware": {
            "demo_fastdds": {
              "transport": "fastdds",
            },
          },
        },
      }
    )

    config = middleware["demo_fastdds"]
    self.assertEqual(config.transport, TransportKind.FAST_DDS)
    self.assertEqual(config.options["middleware.family"], "fastdds")
    self.assertEqual(config.options["implementation"], "native_fastdds")

  def test_load_service_communication_config_keeps_ros_domain_id_separate_from_native_domain_id(self):
    middleware, _, _ = load_service_communication_config(
      {
        "trace": {"service_name": "planner"},
        "communication": {
          "middleware": {
            "robot_dds": {
              "transport": "cyclonedds",
              "ros_domain_id": 42,
            },
          },
        },
      }
    )

    self.assertNotIn("domain_id", middleware["robot_dds"].options)
    self.assertEqual(middleware["robot_dds"].options["ros_domain_id"], 42)

  def test_load_service_communication_config_rejects_explicit_dds_runtime_high_level_route(self):
    with self.assertRaisesRegex(ValueError, "unsupported high-level route middleware"):
      load_service_communication_config(
        {
          "trace": {"service_name": "planner"},
          "communication": {
            "topics": {
              "fast_native_state": {
                "data": "proto",
                "type": "demo.FastNativeState",
                "middleware": "fastdds_native",
              },
            },
          },
        }
      )

  def test_load_service_communication_config_rejects_unsupported_native_binding(self):
    with self.assertRaisesRegex(ValueError, "requires an adapter"):
      load_service_communication_config(
        {
          "trace": {"service_name": "planner"},
          "communication": {
            "services": {
              "plan_action": {
                "contract": {"format": "protobuf_rpc", "type": "demo.Planner/Plan"},
                "bindings": [
                  {"transport": "ros2_service", "service": "/planner/plan_action"},
                ],
              }
            }
          },
        }
      )

  def test_load_service_communication_config_accepts_ros2_proto_envelope_adapter(self):
    middleware, pubsub_routes, rpc_routes = load_service_communication_config(
      {
        "trace": {"service_name": "planner"},
        "communication": {
          "middleware": {
            "local_ros2": {
              "transport": "ros2",
              "mode": "bridge",
              "bridge": {"url": "ws://robot:9090"},
            }
          },
          "topics": {
            "robot_state": {
              "payload": {"format": "protobuf", "type": "demo.RobotState"},
              "bindings": [
                {
                  "transport": "ros2_topic",
                  "middleware": "local_ros2",
                  "adapter": "ros2_proto_envelope",
                  "topic": "/demo/robot_state",
                }
              ],
            }
          },
          "services": {
            "plan_action": {
              "contract": {"format": "protobuf_rpc", "type": "demo.Planner/Plan"},
              "bindings": [
                {
                  "transport": "ros2_service",
                  "middleware": "local_ros2",
                  "adapter": "ros2_proto_envelope",
                  "service": "/demo/plan_action",
                }
              ],
            }
          },
        },
      }
    )

    self.assertEqual(middleware["local_ros2"].transport, TransportKind.ROS2)
    self.assertEqual(middleware["local_ros2"].options["mode"], "bridge")
    self.assertEqual(middleware["local_ros2"].options["bridge.url"], "ws://robot:9090")
    self.assertEqual(pubsub_routes[0].publisher.metadata["adapter"], "ros2_proto_envelope")
    self.assertEqual(pubsub_routes[0].publisher.metadata["codec"], "protobuf")
    self.assertEqual(pubsub_routes[0].publisher.metadata["schema.type"], "demo.RobotState")
    self.assertEqual(rpc_routes[0].server.metadata["adapter"], "ros2_proto_envelope")
    self.assertEqual(rpc_routes[0].server.metadata["codec"], "protobuf")
    self.assertEqual(rpc_routes[0].server.metadata["schema.type"], "demo.Planner/Plan")

  def test_load_service_communication_config_accepts_ros2_typed_mapper_adapter(self):
    _, pubsub_routes, rpc_routes = load_service_communication_config(
      {
        "trace": {"service_name": "planner"},
        "communication": {
          "topics": {
            "robot_state": {
              "payload": {"format": "protobuf", "type": "demo.RobotState"},
              "bindings": [
                {
                  "transport": "ros2_topic",
                  "adapter": "ros2_typed_mapper",
                  "topic": "/demo/robot_state",
                }
              ],
            }
          },
          "services": {
            "plan_action": {
              "contract": {"format": "protobuf_rpc", "type": "demo.Planner/Plan"},
              "bindings": [
                {
                  "transport": "ros2_service",
                  "adapter": "ros2_typed_mapper",
                  "service": "/demo/plan_action",
                }
              ],
            }
          },
        },
      }
    )

    self.assertEqual(pubsub_routes[0].publisher.metadata["adapter"], "ros2_typed_mapper")
    self.assertEqual(pubsub_routes[0].publisher.metadata["schema.type"], "demo.RobotState")
    self.assertEqual(rpc_routes[0].server.metadata["adapter"], "ros2_typed_mapper")
    self.assertEqual(rpc_routes[0].server.metadata["schema.type"], "demo.Planner/Plan")

  def test_load_service_communication_config_accepts_official_ros2_common_interface_types(self):
    middleware, pubsub_routes, rpc_routes = load_service_communication_config(
      {
        "trace": {"service_name": "demo"},
        "communication": {
          "topics": {
            "std_string": {
              "data": "msg",
              "type": "std_msgs/msg/String",
              "middleware": "ros2",
              "topic": "/std_string",
            },
            "pose": {
              "data": "msg",
              "type": "geometry_msgs/msg/PoseStamped",
              "middleware": "ros2",
              "topic": "/pose",
            },
            "joint_state": {
              "data": "msg",
              "type": "sensor_msgs/msg/JointState",
              "middleware": "ros2",
              "topic": "/joint_states",
            },
            "odometry": {
              "data": "msg",
              "type": "nav_msgs/msg/Odometry",
              "middleware": "ros2",
              "topic": "/odom",
            },
            "trajectory": {
              "data": "msg",
              "type": "trajectory_msgs/msg/JointTrajectory",
              "middleware": "ros2",
              "topic": "/trajectory",
            },
            "marker": {
              "data": "msg",
              "type": "visualization_msgs/msg/Marker",
              "middleware": "ros2",
              "topic": "/marker",
            },
            "goal_status": {
              "data": "msg",
              "type": "action_msgs/msg/GoalStatusArray",
              "middleware": "ros2",
              "topic": "/goal_status",
            },
            "time": {
              "data": "msg",
              "type": "builtin_interfaces/msg/Time",
              "middleware": "ros2",
              "topic": "/time",
            },
            "diagnostics": {
              "data": "msg",
              "type": "diagnostic_msgs/msg/DiagnosticArray",
              "middleware": "ros2",
              "topic": "/diagnostics",
            },
            "mesh": {
              "data": "msg",
              "type": "shape_msgs/msg/Mesh",
              "middleware": "ros2",
              "topic": "/mesh",
            },
            "disparity": {
              "data": "msg",
              "type": "stereo_msgs/msg/DisparityImage",
              "middleware": "ros2",
              "topic": "/disparity",
            },
          },
          "services": {
            "set_map": {
              "data": "srv",
              "type": "nav_msgs/srv/SetMap",
              "middleware": "ros2",
              "service": "/set_map",
            },
            "trigger": {
              "data": "srv",
              "type": "std_srvs/srv/Trigger",
              "middleware": "ros2",
              "service": "/trigger",
            },
          },
        },
      }
    )

    self.assertEqual(middleware["ros2"].transport, TransportKind.ROS2)
    topics = {route.name: route for route in pubsub_routes}
    expected_topics = {
      "std_string": "std_msgs/msg/String",
      "pose": "geometry_msgs/msg/PoseStamped",
      "joint_state": "sensor_msgs/msg/JointState",
      "odometry": "nav_msgs/msg/Odometry",
      "trajectory": "trajectory_msgs/msg/JointTrajectory",
      "marker": "visualization_msgs/msg/Marker",
      "goal_status": "action_msgs/msg/GoalStatusArray",
      "time": "builtin_interfaces/msg/Time",
      "diagnostics": "diagnostic_msgs/msg/DiagnosticArray",
      "mesh": "shape_msgs/msg/Mesh",
      "disparity": "stereo_msgs/msg/DisparityImage",
    }
    for name, expected_type in expected_topics.items():
      self.assertEqual(topics[name].publisher.transport, TransportKind.ROS2)
      self.assertEqual(topics[name].publisher.message_type, expected_type)
      self.assertNotIn("adapter", topics[name].publisher.metadata)
    services = {route.name: route for route in rpc_routes}
    expected_services = {
      "set_map": "nav_msgs/srv/SetMap",
      "trigger": "std_srvs/srv/Trigger",
    }
    for name, expected_type in expected_services.items():
      self.assertEqual(services[name].server.transport, TransportKind.ROS2)
      self.assertEqual(services[name].server.message_type, expected_type)
      self.assertNotIn("adapter", services[name].server.metadata)

  def test_load_service_communication_config_uses_ros2_graph_type_for_typed_mapper(self):
    _, pubsub_routes, rpc_routes = load_service_communication_config(
      {
        "service_name": "brain",
        "communication": {
          "middleware": {"local_ros2": {"transport": "ros2"}},
          "topics": {
            "brain_mode": {
              "transport": "ros2_topic",
              "middleware": "local_ros2",
              "topic": "/server/mode",
              "adapter": "ros2_typed_mapper",
              "ros_message_type": "std_msgs/msg/String",
              "payload": {
                "format": "protobuf",
                "type": "pacific_rim.robo_brain_service.protocols.pb.ServerMode",
              },
            }
          },
          "services": {
            "plan": {
              "transport": "ros2_service",
              "middleware": "local_ros2",
              "service": "/planner/plan",
              "adapter": "ros2_typed_mapper",
              "ros_service_type": "example_interfaces/srv/AddTwoInts",
              "contract": {
                "format": "protobuf_rpc",
                "type": "demo.Planner/Plan",
              },
            }
          },
        },
      }
    )

    self.assertEqual(pubsub_routes[0].publisher.message_type, "std_msgs/msg/String")
    self.assertEqual(
      pubsub_routes[0].publisher.metadata["schema.type"],
      "pacific_rim.robo_brain_service.protocols.pb.ServerMode",
    )
    self.assertEqual(rpc_routes[0].server.message_type, "example_interfaces/srv/AddTwoInts")
    self.assertEqual(rpc_routes[0].server.metadata["schema.type"], "demo.Planner/Plan")

  def test_load_communication_config_file_adds_own_public_provider_routes(self):
    with tempfile.TemporaryDirectory() as tmp:
      root = Path(tmp)
      public_dir = root / "pkg" / "idl" / "demo_service" / "public"
      public_dir.mkdir(parents=True)
      (public_dir / "interfaces.yaml").write_text(
        """
topics:
  demo_state:
    role: publisher
    direction: publish
    data: proto
    type: demo.State
    addresses:
      fastdds: demo.state
services:
  demo_reset:
    role: server
    direction: server
    data: proto
    type: demo.ResetRequest
    response_type: demo.ResetResponse
    addresses:
      cyclonedds: /demo/reset
""",
        encoding="utf-8",
      )
      config_dir = root / "module" / "service" / "demo_service" / "config"
      config_dir.mkdir(parents=True)
      config_path = config_dir / "config.yaml"
      config_path.write_text(
        """{
  "service": {
    "name": "demo_service",
    "runtime_package": "demo"
  },
  "trace": {
    "service_name": "demo_service"
  },
  "communication": {
    "middleware": {},
    "services": {},
    "topics": {}
  }
}
""",
        encoding="utf-8",
      )

      config = load_communication_config_file(config_path)

    self.assertEqual([route.name for route in config.pubsub_routes], ["demo_state_fastdds"])
    self.assertEqual([route.name for route in config.rpc_routes], ["demo_reset_cyclonedds"])

  def test_ros2_proto_envelope_bus_mode_selection(self):
    bus = Ros2ProtoEnvelopeBus.from_options({"mode": "native", "name": "test_ros2"})
    self.assertIsInstance(bus, Ros2ProtoEnvelopeBus)
    with self.assertRaisesRegex(NotImplementedError, "sidecar bridge"):
      Ros2ProtoEnvelopeBus.from_options({"mode": "bridge"})

  def test_ros2_bridge_rules_resolve_public_topic_refs(self):
    with tempfile.TemporaryDirectory() as tmp:
      root = Path(tmp)
      public_dir = root / "pkg" / "idl" / "demo_service" / "public"
      public_dir.mkdir(parents=True)
      (public_dir / "interfaces.yaml").write_text(
        """
topics:
  robot_state:
    payload:
      format: ros2_msg
      type: demo/msg/RobotState
    bindings:
      - transport: ros2_topic
        direction: subscribe
        topic: /demo/robot_state
      - transport: nats_topic
        direction: publish
        subject: robot.topic.demo.robot_state
""",
        encoding="utf-8",
      )
      rules = rules_from_communication_config(
        {
          "topics": {
            "robot_state": {
              "topic_ref": "demo_service.robot_state",
              "bindings": [
                {"transport": "ros2_topic", "middleware": "local_ros2"},
                {"transport": "nats_topic", "middleware": "local_nats", "queue_group": "demo_service"},
              ],
            }
          }
        },
        workspace_root=root,
      )

    self.assertEqual(len(rules), 1)
    self.assertEqual(rules[0]["nats_subject"], "robot.topic.demo.robot_state")
    self.assertEqual(rules[0]["ros_topic"], "/demo/robot_state")
    self.assertEqual(rules[0]["msg_type"], "demo/msg/RobotState")
    self.assertEqual(rules[0]["queue_group"], "demo_service")

  def test_ros2_bridge_rules_resolve_bare_public_topic_refs(self):
    with tempfile.TemporaryDirectory() as tmp:
      root = Path(tmp)
      public_dir = root / "pkg" / "idl" / "demo_service" / "public"
      public_dir.mkdir(parents=True)
      (public_dir / "interfaces.yaml").write_text(
        """
topics:
  robot_state:
    payload:
      format: ros2_msg
      type: demo/msg/RobotState
    bindings:
      - transport: ros2_topic
        direction: subscribe
        topic: /demo/robot_state
      - transport: nats_topic
        direction: publish
        subject: robot.topic.demo.robot_state
""",
        encoding="utf-8",
      )
      rules = rules_from_communication_config(
        {
          "topics": {
            "robot_state": {
              "topic_ref": "/demo/robot_state",
              "bindings": [
                {"transport": "ros2_topic", "middleware": "local_ros2"},
                {"transport": "nats_topic", "middleware": "local_nats", "queue_group": "demo_service"},
              ],
            }
          }
        },
        workspace_root=root,
      )

    self.assertEqual(len(rules), 1)
    self.assertEqual(rules[0]["nats_subject"], "robot.topic.demo.robot_state")
    self.assertEqual(rules[0]["ros_topic"], "/demo/robot_state")
    self.assertEqual(rules[0]["msg_type"], "demo/msg/RobotState")
    self.assertEqual(rules[0]["queue_group"], "demo_service")

  def test_ros2_bridge_rules_resolve_public_service_refs(self):
    with tempfile.TemporaryDirectory() as tmp:
      root = Path(tmp)
      public_dir = root / "pkg" / "idl" / "demo_service" / "public"
      public_dir.mkdir(parents=True)
      (public_dir / "interfaces.yaml").write_text(
        """
services:
  play_action:
    contract:
      format: ros2_srv
      type: demo/srv/PlayAction
    bindings:
      - transport: ros2_service
        service: /demo/play_action
      - transport: nats_rpc
        subject: robot.rpc.demo.play_action
""",
        encoding="utf-8",
      )
      rules = rules_from_communication_config(
        {
          "services": {
            "play_action": {
              "service_ref": "demo_service.play_action",
              "bindings": [
                {"transport": "ros2_service", "middleware": "local_ros2"},
                {"transport": "nats_rpc", "middleware": "local_nats", "queue_group": "demo_service"},
              ],
            }
          }
        },
        workspace_root=root,
      )

    self.assertEqual(len(rules), 1)
    self.assertEqual(rules[0]["nats_subject"], "robot.rpc.demo.play_action")
    self.assertEqual(rules[0]["ros_service"], "/demo/play_action")
    self.assertEqual(rules[0]["service_type"], "demo/srv/PlayAction")
    self.assertEqual(rules[0]["queue_group"], "demo_service")

  def test_ros2_bridge_rules_resolve_bare_public_service_refs(self):
    with tempfile.TemporaryDirectory() as tmp:
      root = Path(tmp)
      public_dir = root / "pkg" / "idl" / "demo_service" / "public"
      public_dir.mkdir(parents=True)
      (public_dir / "interfaces.yaml").write_text(
        """
services:
  play_action:
    contract:
      format: ros2_srv
      type: demo/srv/PlayAction
    bindings:
      - transport: ros2_service
        service: /demo/play_action
      - transport: nats_rpc
        subject: robot.rpc.demo.play_action
""",
        encoding="utf-8",
      )
      rules = rules_from_communication_config(
        {
          "services": {
            "play_action": {
              "service_ref": "/demo/play_action",
              "bindings": [
                {"transport": "ros2_service", "middleware": "local_ros2"},
                {"transport": "nats_rpc", "middleware": "local_nats", "queue_group": "demo_service"},
              ],
            }
          }
        },
        workspace_root=root,
      )

    self.assertEqual(len(rules), 1)
    self.assertEqual(rules[0]["nats_subject"], "robot.rpc.demo.play_action")
    self.assertEqual(rules[0]["ros_service"], "/demo/play_action")
    self.assertEqual(rules[0]["service_type"], "demo/srv/PlayAction")
    self.assertEqual(rules[0]["queue_group"], "demo_service")

  def test_load_communication_config_accepts_robo_brain_ros_shape(self):
    config = load_communication_config(
      {
        "trace": {"service_name": "robo-brain"},
        "ros": {
          "nats": {
            "enabled": True,
            "server_url": "nats://example:4222",
            "connect_timeout": "2s",
          },
          "service_routes": {
            "/action_service_node/play_action": {
              "transport": "nats_rpc",
              "nats_subject": "robot.rpc.play_action",
              "timeout": "500ms",
            },
            "/action_service_node/upperbody/LookAt": {
              "transport": "rosbridge",
              "timeout": "2s",
            },
          },
          "rgb_expression_light": {
            "enabled": True,
            "ros_topic": "/brain/rgb_expression_light_state",
            "nats_subject": "robot.topic.rgb_expression_light_state",
          },
        },
      }
    )

    self.assertEqual(config.middleware["nats"].options["server_url"], "nats://example:4222")
    self.assertEqual(len(config.rpc_routes), 1)
    self.assertEqual(config.rpc_routes[0].name, "action_service_node_play_action")
    self.assertEqual(config.rpc_routes[0].timeout_ms, 500)
    self.assertEqual(config.pubsub_routes[0].publisher.address, "robot.topic.rgb_expression_light_state")

  def test_codecs(self):
    self.assertEqual(RawBytesCodec().decode(RawBytesCodec().encode(b"abc")), b"abc")
    self.assertEqual(JsonCodec().decode(JsonCodec().encode({"ok": True})), {"ok": True})

    proto = FakeProto()
    proto.value = b"payload"
    decoded = ProtobufCodec(FakeProto).decode(ProtobufCodec(FakeProto).encode(proto))
    self.assertEqual(decoded.value, b"payload")

  def test_typed_message_bus_uses_codec(self):
    async def run():
      raw = FakeBus()
      bus = TypedMessageBus(raw)
      await bus.publish(Channel("topic"), {"value": 3}, codec=JsonCodec())
      self.assertEqual(raw.published[0][1], b'{"value":3}')

      values = []
      await bus.subscribe("topic", values.append, codec=JsonCodec())
      await raw.handler(b'{"value":4}')
      self.assertEqual(values, [{"value": 4}])

      response = await bus.request("rpc", b"request")
      self.assertEqual(response, b"request-response")

    asyncio.run(run())

  def test_fanout_message_bus_publishes_to_all_buses(self):
    async def run():
      first = FakeBus()
      second = FakeBus()
      bus = FanoutMessageBus([first, second])
      await bus.publish_bytes(Channel("robot.state"), b"payload")
      self.assertEqual(first.published, [(Channel("robot.state"), b"payload")])
      self.assertEqual(second.published, [(Channel("robot.state"), b"payload")])

    asyncio.run(run())

  def test_cyclonedds_bus_merges_qos(self):
    bus = CycloneDdsMessageBus.from_options(
      {"type_name": "DefaultType", "qos.reliability": "reliable", "qos.depth": 10}
    )
    topic = bus._topic(
      Channel(
        "RobotState",
        message_type="RobotStateType",
        metadata={"qos.reliability": "best_effort", "qos.deadline_ms": 50},
      )
    )

    self.assertEqual(topic.topic_name, "RobotState")
    self.assertEqual(topic.type_name, "DefaultType")
    self.assertEqual(topic.qos["reliability"], "best_effort")
    self.assertEqual(topic.qos["depth"], 10)
    self.assertEqual(topic.qos["deadline_ms"], 50)

  def test_native_dds_buses_default_to_isolated_domain(self):
    previous_ros_domain = os.environ.get("ROS_DOMAIN_ID")
    previous_native_domain = os.environ.get("PACIFIC_RIM_NATIVE_DDS_DOMAIN_ID")
    previous_native_offset = os.environ.get("PACIFIC_RIM_NATIVE_DDS_DOMAIN_OFFSET")
    try:
      os.environ["ROS_DOMAIN_ID"] = "42"
      os.environ.pop("PACIFIC_RIM_NATIVE_DDS_DOMAIN_ID", None)
      os.environ.pop("PACIFIC_RIM_NATIVE_DDS_DOMAIN_OFFSET", None)

      cyclone_bus = CycloneDdsMessageBus.from_options({"type_name": "DefaultType"})
      self.assertEqual(cyclone_bus._client.config.domain_id, 142)

      fast_bus = FastDdsMessageBus.from_options({"type_name": "DefaultType"})
      self.assertEqual(fast_bus._client.config.domain_id, 142)

      explicit_bus = CycloneDdsMessageBus.from_options({"domain_id": 42})
      self.assertEqual(explicit_bus._client.config.domain_id, 42)

      offset_bus = CycloneDdsMessageBus.from_options({"native_domain_offset": 5})
      self.assertEqual(offset_bus._client.config.domain_id, 47)

      ros_domain_bus = CycloneDdsMessageBus.from_options({"ros_domain_id": 42})
      self.assertEqual(ros_domain_bus._client.config.domain_id, 142)

      native_domain_bus = CycloneDdsMessageBus.from_options({"native_domain_id": 9})
      self.assertEqual(native_domain_bus._client.config.domain_id, 9)
    finally:
      _restore_env("ROS_DOMAIN_ID", previous_ros_domain)
      _restore_env("PACIFIC_RIM_NATIVE_DDS_DOMAIN_ID", previous_native_domain)
      _restore_env("PACIFIC_RIM_NATIVE_DDS_DOMAIN_OFFSET", previous_native_offset)

  def test_cyclonedds_bus_uses_registered_typed_dds_type(self):
    clear_typed_dds_topic_types()
    try:
      register_typed_dds_topic_type("demo::RobotState", object)
      bus = CycloneDdsMessageBus.from_options({"type_name": "DefaultType"})
      topic = bus._topic(
        Channel(
          "RobotState",
          message_type="demo::RobotState",
          metadata={
            "schema.language": "omg_idl",
            "schema.type": "demo::RobotState",
            "dds.mode": "typed_preferred",
          },
        )
      )
      self.assertEqual(topic.type_name, "demo::RobotState")
    finally:
      clear_typed_dds_topic_types()

  def test_cyclonedds_bus_requests_through_configured_rpc_adapter(self):
    adapter = FakeDdsRPCAdapter()
    bus = CycloneDdsMessageBus.from_options(
      {"type_name": "DefaultType", "qos.reliability": "reliable"}
    )
    bus._rpc_adapters["rmw_cyclonedds"] = adapter

    async def run():
      response = await bus.request_bytes(
        Channel(
          "fallback.request",
          message_type="demo.Plan",
          metadata={
            "rpc.standard": "rmw-cyclonedds",
            "rpc.request_channel": "planner.request.plan_action",
            "rpc.response_channel": "planner.response.plan_action",
            "qos.depth": 3,
          },
        ),
        b"request",
        timeout_sec=1.5,
      )
      self.assertEqual(response, b"dds-response")

    asyncio.run(run())
    self.assertEqual(adapter.payload, b"request")
    self.assertEqual(adapter.timeout_sec, 1.5)
    self.assertEqual(adapter.binding.standard, "rmw_cyclonedds")
    self.assertEqual(adapter.binding.request_channel.topic_name, "planner.request.plan_action")
    self.assertEqual(adapter.binding.response_channel.topic_name, "planner.response.plan_action")
    self.assertEqual(adapter.binding.request_channel.type_name, "DefaultType")
    self.assertEqual(adapter.binding.request_channel.qos["depth"], 3)

  def test_cyclonedds_bus_handles_requests_through_configured_rpc_adapter(self):
    adapter = FakeDdsRPCAdapter()
    bus = CycloneDdsMessageBus.from_options(
      {"type_name": "DefaultType", "qos.reliability": "reliable"}
    )
    bus._rpc_adapters["omg_dds_rpc"] = adapter

    async def run():
      await bus.handle_request_bytes(
        Channel(
          "planner.request.plan_action",
          message_type="demo.Plan",
          metadata={
            "rpc.standard": "omg-dds-rpc",
            "rpc.response_channel": "planner.response.plan_action",
            "qos.depth": 3,
          },
        ),
        lambda payload: payload + b"-response",
      )

    asyncio.run(run())
    self.assertEqual(adapter.handler_response, b"dds-request-response")
    self.assertEqual(adapter.binding.standard, "omg_dds_rpc")
    self.assertEqual(adapter.binding.request_channel.topic_name, "planner.request.plan_action")
    self.assertEqual(adapter.binding.response_channel.topic_name, "planner.response.plan_action")
    self.assertEqual(adapter.binding.request_channel.type_name, "DefaultType")
    self.assertEqual(adapter.binding.request_channel.qos["depth"], 3)

  def test_cyclonedds_bus_has_default_topic_rpc_adapter(self):
    client = FakeCycloneDdsClient()
    bus = CycloneDdsMessageBus(client, type_name="DefaultType")

    async def run():
      await bus.handle_request_bytes(
        Channel(
          "planner.request.plan_action",
          metadata={
            "rpc.standard": "rmw_cyclonedds",
            "rpc.response_channel": "planner.response.plan_action",
          },
        ),
        lambda payload: payload + b"-response",
      )
      response = await bus.request_bytes(
        Channel(
          "planner.request.plan_action",
          metadata={
            "rpc.standard": "rmw_cyclonedds",
            "rpc.response_channel": "planner.response.plan_action",
          },
        ),
        b"request",
        timeout_sec=1.0,
      )
      self.assertEqual(response, b"request-response")

    asyncio.run(run())


if __name__ == "__main__":
  unittest.main()
