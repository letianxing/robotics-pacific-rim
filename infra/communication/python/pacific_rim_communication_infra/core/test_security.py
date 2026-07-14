import base64
import asyncio
import json
import os
import unittest
from pathlib import Path

from pacific_rim_communication_infra.contracts import Endpoint, MiddlewareConfig, PubSubRoute, TransportKind
from pacific_rim_communication_infra.core.middleware import Channel
from pacific_rim_communication_infra.core.routing import CommunicationFabric
from pacific_rim_communication_infra.core.security import (
  ResolvedSecurityKey,
  ResolvedSecurityProfile,
  SECURITY_METADATA_PROFILE,
  SECURITY_OPTION_PROFILE,
  SecurityBinding,
  SecurityCodec,
  SecurityRuntime,
  SecuritySettings,
  SecurityProfileConfig,
  _parse_algorithm,
)


class SecurityCodecTest(unittest.TestCase):
  def test_vectors_round_trip_and_replay_rejection(self):
    for vector in load_vectors():
      with self.subTest(vector=vector["name"]):
        codec = codec_from_vector(vector)
        plaintext = bytes.fromhex(vector["plaintext_hex"])
        envelope = codec.encrypt_with_options(
          plaintext,
          vector["direction"],
          int(vector["sender_id"]),
          int(vector["sequence"]),
          bytes.fromhex(vector["nonce_hex"]),
        )
        if vector.get("envelope_hex"):
          self.assertEqual(envelope.hex(), vector["envelope_hex"])
        self.assertEqual(codec.decrypt(envelope, vector["direction"]), plaintext)
        with self.assertRaises(ValueError):
          codec.decrypt(envelope, vector["direction"])

  def test_rejects_aad_mismatch(self):
    vector = load_vectors()[0]
    codec = codec_from_vector(vector)
    envelope = codec.encrypt_with_options(
      bytes.fromhex(vector["plaintext_hex"]),
      vector["direction"],
      int(vector["sender_id"]),
      int(vector["sequence"]),
      bytes.fromhex(vector["nonce_hex"]),
    )
    with self.assertRaises(ValueError):
      codec.decrypt(envelope, "rpc_response")

  def test_fabric_encrypts_pubsub_endpoint_payloads(self):
    async def run():
      os.environ["PR_TEST_COMM_KEY"] = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
      os.environ["PR_TEST_COMM_SALT"] = "cGFjaWZpYy1yaW0tc2VjdXJpdHktc2FsdC0wMDAx"
      raw_bus = RecordingBus()
      metadata = {
        "middleware": "nats",
        SECURITY_METADATA_PROFILE: "robot_control",
        "source_name": "robot_state",
        "logical_route": "robot_state",
        "binding_name": "state_nats",
      }
      fabric = CommunicationFabric(
        {"nats": raw_bus},
        {"nats": MiddlewareConfig(transport=TransportKind.NATS, name="nats")},
        pubsub_routes=[
          PubSubRoute(
            name="robot_state",
            publisher=Endpoint(
              transport=TransportKind.NATS,
              address="robot.state",
              message_type="RobotState",
              metadata=metadata,
            ),
            subscriber=Endpoint(
              transport=TransportKind.NATS,
              address="robot.state",
              message_type="RobotState",
              metadata=metadata,
            ),
          )
        ],
        security=SecurityRuntime(
          SecuritySettings(
            profiles={
              "robot_control": SecurityProfileConfig(
                key_id="robot-control-v1",
                key_env="PR_TEST_COMM_KEY",
                salt_env="PR_TEST_COMM_SALT",
              )
            }
          )
        ),
      )
      publisher = fabric.publisher("robot_state")
      await publisher.bus.publish_bytes(publisher.channel, b"hello")
      self.assertNotEqual(raw_bus.published_payload, b"hello")

      received = []

      async def handler(payload):
        received.append(payload)

      subscriber = fabric.subscriber("robot_state")
      await subscriber.bus.subscribe_bytes(subscriber.channel, handler)
      await raw_bus.handler(raw_bus.published_payload)
      self.assertEqual(received, [b"hello"])

    asyncio.run(run())

  def test_runtime_requires_explicit_nats_profile(self):
    runtime = SecurityRuntime(SecuritySettings(require_explicit_profile=True))
    with self.assertRaises(ValueError):
      runtime.resolve_binding(
        "nats",
        MiddlewareConfig(transport=TransportKind.NATS, name="nats"),
        Endpoint(transport=TransportKind.NATS, address="robot.state"),
      )

  def test_runtime_resolves_middleware_profile(self):
    os.environ["PR_TEST_COMM_KEY"] = base64.b64encode(b"0123456789abcdef0123456789abcdef").decode()
    os.environ["PR_TEST_COMM_SALT"] = base64.b64encode(b"pacific-rim-security-salt-0001").decode()
    runtime = SecurityRuntime(
      SecuritySettings(
        profiles={
          "robot_control": SecurityProfileConfig(
            key_id="robot-control-v1",
            key_env="PR_TEST_COMM_KEY",
            salt_env="PR_TEST_COMM_SALT",
          )
        }
      )
    )
    binding = runtime.resolve_binding(
      "nats",
      MiddlewareConfig(
        transport=TransportKind.NATS,
        name="nats",
        options={SECURITY_OPTION_PROFILE: "robot_control"},
      ),
      Endpoint(transport=TransportKind.NATS, address="robot.state"),
    )
    self.assertEqual(binding.profile.name, "robot_control")


def load_vectors():
  path = Path(__file__).parents[3] / "testdata" / "security_vectors.json"
  return json.loads(path.read_text(encoding="utf-8"))["vectors"]


def codec_from_vector(vector):
  key_id = vector["key_id"]
  profile = ResolvedSecurityProfile(
    name=vector["profile"],
    algorithm=_parse_algorithm(vector["algorithm"]),
    aad_context=vector["aad_context"],
    replay_window=4096,
    encrypt_key_id=key_id,
    fail_open=False,
    keys={
      key_id: ResolvedSecurityKey(
        key_id=key_id,
        master_key=base64.b64decode(vector["master_key_b64"]),
        salt=base64.b64decode(vector["salt_b64"]),
      )
    },
  )
  return SecurityCodec(
    SecurityBinding(
      profile=profile,
      route=vector["route"],
      binding=vector["binding"],
      transport=vector["transport"],
      address=vector["address"],
      message_type=vector["message_type"],
    )
  )


class RecordingBus:
  kind = TransportKind.NATS

  class Capabilities:
    publish_subscribe = True
    request_reply = True

  capabilities = Capabilities()

  def __init__(self):
    self.published_payload = b""
    self.handler = None

  async def connect(self):
    pass

  async def close(self):
    pass

  async def publish_bytes(self, channel: Channel, payload: bytes):
    self.published_payload = payload

  async def subscribe_bytes(self, channel: Channel, handler):
    self.handler = handler

  async def request_bytes(self, channel: Channel, payload: bytes, timeout_sec: float = 2.0):
    return payload


if __name__ == "__main__":
  unittest.main()
