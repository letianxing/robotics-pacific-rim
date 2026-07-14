import json
import unittest

from pacific_rim_protocol import BridgeEnvelopeCodec, DdsEnvelopeCodec


class EnvelopeCodecTest(unittest.TestCase):
  def test_round_trip_envelope(self) -> None:
    codec = DdsEnvelopeCodec(source="unit-test")
    encoded = codec.encode("example/State", {"value": 7, "ok": True})
    decoded = codec.decode(encoded)

    self.assertEqual(decoded.source, "unit-test")
    self.assertEqual(decoded.message.message_type, "example/State")
    self.assertEqual(decoded.message.payload["value"], 7)
    self.assertEqual(decoded.message.payload["ok"], True)
    self.assertEqual(
      decoded.payload_sha256,
      DdsEnvelopeCodec.compute_digest("example/State", {"value": 7, "ok": True}),
    )

  def test_rejects_non_object_payload(self) -> None:
    codec = DdsEnvelopeCodec(source="unit-test")
    encoded = json.dumps({"message": {"payload": []}}).encode("utf-8")

    with self.assertRaisesRegex(ValueError, "payload"):
      codec.decode(encoded)

  def test_bridge_codec_decodes_legacy_envelope(self) -> None:
    codec = BridgeEnvelopeCodec(source="bridge")
    encoded = json.dumps(
      {
        "bridge_id": "legacy-bridge",
        "message_type": "example/State",
        "payload": {"ok": True},
        "rule_name": "state_rule",
      }
    ).encode("utf-8")

    decoded = codec.decode(encoded)
    self.assertEqual(decoded.source, "legacy-bridge")
    self.assertEqual(decoded.message.message_type, "example/State")
    self.assertEqual(decoded.message.payload, {"ok": True})
    self.assertEqual(decoded.message.metadata["rule_name"], "state_rule")


if __name__ == "__main__":
  unittest.main()
