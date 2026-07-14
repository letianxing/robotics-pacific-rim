import unittest
from pathlib import Path

from pacific_rim_communication_infra.ros2.communication_config import load_yaml_mapping
from pacific_rim_communication_infra.ros2.communication_config import rules_from_communication_config


class ROS2CommunicationConfigTest(unittest.TestCase):
  def test_builds_bridge_rules_from_service_and_topic_routes(self):
    rules = rules_from_communication_config(
      {
        "services": {
          "play_action_rpc": {
            "transport": "nats_rpc",
            "subject": "robot.rpc.play_action",
            "queue_group": "action_service",
            "ros_service": "/action_service_node/play_action",
            "service_type": "action_service/srv/PlayAction",
          },
          "native_ros": {
            "transport": "ros2",
            "service": "/native",
            "service_type": "std_srvs/srv/Trigger",
          },
        },
        "topics": {
          "rgb_state": {
            "transport": "nats_topic",
            "direction": "subscribe",
            "subject": "robot.topic.rgb_expression_light_state",
            "ros_topic": "/action_service_node/rgb_expression_light_state",
            "message_type": "action_service/msg/RgbExpressionLightState",
          },
          "audio_wavefile": {
            "transport": "nats_topic",
            "direction": "publish",
            "subject": "robot.topic.audio.wavefile",
            "ros_topic": "/audio_wavefile",
            "msg_type": "std_msgs/msg/String",
          },
        },
      }
    )

    by_name = {rule["name"]: rule for rule in rules}
    self.assertEqual(by_name["play_action_rpc"]["direction"], "nats_rpc_to_ros_service")
    self.assertEqual(by_name["play_action_rpc"]["nats_subject"], "robot.rpc.play_action")
    self.assertEqual(by_name["rgb_state"]["direction"], "nats_to_ros_topic")
    self.assertEqual(by_name["rgb_state"]["msg_type"], "action_service/msg/RgbExpressionLightState")
    self.assertEqual(by_name["audio_wavefile"]["direction"], "ros_topic_to_nats")
    self.assertNotIn("native_ros", by_name)

  def test_builds_bridge_rules_from_bindings(self):
    rules = rules_from_communication_config(
      {
        "services": {
          "play_action": {
            "service_type": "action_service/srv/PlayAction",
            "bindings": [
              {"transport": "ros2_service", "service": "/action_service_node/play_action"},
              {"transport": "nats_rpc", "subject": "robot.rpc.play_action"},
              {"transport": "nats_rpc", "subject": "robot.rpc.play_action_alias"},
            ],
          }
        },
        "topics": {
          "rgb_state": {
            "direction": "publish",
            "message_type": "action_service/msg/RgbExpressionLightState",
            "bindings": [
              {"transport": "ros2_topic", "topic": "/brain/rgb_expression_light_state"},
              {"transport": "nats_topic", "subject": "robot.topic.rgb_expression_light_state"},
            ],
          }
        },
      }
    )

    by_subject = {rule["nats_subject"]: rule for rule in rules}
    self.assertEqual(by_subject["robot.rpc.play_action"]["ros_service"], "/action_service_node/play_action")
    self.assertEqual(
      by_subject["robot.rpc.play_action_alias"]["ros_service"],
      "/action_service_node/play_action",
    )
    self.assertEqual(
      by_subject["robot.topic.rgb_expression_light_state"]["ros_topic"],
      "/brain/rgb_expression_light_state",
    )
    self.assertEqual(by_subject["robot.topic.rgb_expression_light_state"]["direction"], "ros_topic_to_nats")

  def test_bridge_rules_inherit_middleware_security_profile(self):
    rules = rules_from_communication_config(
      {
        "middleware": {
          "action_nats": {
            "transport": "nats",
            "security_profile": "robot_control",
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
      }
    )

    self.assertEqual(rules[0]["security_profile"], "robot_control")
    self.assertEqual(rules[0]["logical_route"], "play_action")
    self.assertEqual(rules[0]["binding_name"], "action_nats")

  def test_builds_proto_envelope_topic_and_service_rules(self):
    rules = rules_from_communication_config(
      {
        "services": {
          "plan_action": {
            "contract": {"format": "protobuf_rpc", "type": "demo.Planner/Plan"},
            "bindings": [
              {
                "transport": "ros2_service",
                "adapter": "ros2_proto_envelope",
                "service": "/demo/plan_action",
              },
              {"transport": "nats_rpc", "subject": "demo.plan_action"},
            ],
          }
        },
        "topics": {
          "proto_state": {
            "payload": {"format": "protobuf", "type": "demo.RobotState"},
            "bindings": [
              {
                "transport": "ros2_topic",
                "adapter": "ros2_proto_envelope",
                "topic": "/demo/proto_state",
              },
              {"transport": "nats_topic", "subject": "demo.proto_state"},
            ],
          }
        },
      }
    )

    by_name = {rule["name"]: rule for rule in rules}
    self.assertEqual(by_name["proto_state"]["adapter"], "ros2_proto_envelope")
    self.assertEqual(by_name["proto_state"]["msg_type"], "common/msg/ProtoEnvelope")
    self.assertEqual(by_name["proto_state"]["schema_type"], "demo.RobotState")
    self.assertEqual(by_name["proto_state"]["codec"], "protobuf")
    self.assertEqual(by_name["plan_action"]["adapter"], "ros2_proto_envelope")
    self.assertEqual(by_name["plan_action"]["service_type"], "common/srv/ProtoCall")
    self.assertEqual(by_name["plan_action"]["schema_type"], "demo.Planner/Plan")

  def test_builds_typed_mapper_rule_with_explicit_ros_type(self):
    rules = rules_from_communication_config(
      {
        "topics": {
          "rgb_state": {
            "payload": {"format": "protobuf", "type": "demo.RgbExpressionLightState"},
            "ros_message_type": "std_msgs/msg/String",
            "bindings": [
              {
                "transport": "ros2_topic",
                "adapter": "ros2_typed_mapper",
                "topic": "/brain/rgb_expression_light_state",
              },
              {"transport": "nats_topic", "subject": "robot.topic.rgb_expression_light_state"},
            ],
          }
        },
      }
    )

    self.assertEqual(rules[0]["adapter"], "ros2_typed_mapper")
    self.assertEqual(rules[0]["msg_type"], "std_msgs/msg/String")
    self.assertEqual(rules[0]["schema_type"], "demo.RgbExpressionLightState")

  def test_high_level_ros2_routes_do_not_generate_nats_bridge_rules(self):
    rules = rules_from_communication_config(
      {
        "services": {
          "plan_action": {
            "data": "proto",
            "type": "demo.Planner/Plan",
            "middleware": "ros2",
            "service": "/demo/plan_action",
          }
        },
        "topics": {
          "proto_state": {
            "data": "proto",
            "type": "demo.RobotState",
            "middleware": "ros2",
            "topic": "/demo/proto_state",
          },
          "joint_state": {
            "data": "msg",
            "type": "sensor_msgs/msg/JointState",
            "middleware": "ros2",
            "topic": "/joint_states",
          },
        },
      }
    )

    self.assertEqual(rules, [])

  def test_robo_brain_bridge_yaml_stays_native_typed_rules(self):
    root = Path(__file__).resolve().parents[5]
    path = root / "module" / "service" / "robo_brain_service" / "bridge" / "nats" / "robo_brain_bridge.yaml"
    raw = load_yaml_mapping(path)
    rules = rules_from_communication_config(raw["adapter"]["communication"], config_path=path)
    by_name = {rule["name"]: rule for rule in rules}

    self.assertEqual(by_name["rgb_expression_light_state_to_nats"]["msg_type"], "std_msgs/msg/String")
    self.assertEqual(by_name["rgb_expression_light_state_to_nats"]["nats_message_type"], "action_service/msg/RgbExpressionLightState")
    self.assertNotIn("adapter", by_name["rgb_expression_light_state_to_nats"])
    self.assertEqual(by_name["music_beat_from_nats"]["direction"], "nats_to_ros_topic")
    self.assertEqual(by_name["upperbody_look_at_to_nats"]["msg_type"], "sensor_msgs/msg/JointState")


if __name__ == "__main__":
  unittest.main()
