import unittest

from pacific_rim_protocol import JsonCodec, ProtobufCodec, RawBytesCodec, ros2_srv_format


class FakeProto:
  def __init__(self) -> None:
    self.data = b""

  def SerializeToString(self) -> bytes:
    return self.data

  def ParseFromString(self, data: bytes) -> None:
    self.data = data


class CodecTest(unittest.TestCase):
  def test_raw_bytes_codec_copies_data(self) -> None:
    self.assertEqual(RawBytesCodec().decode(RawBytesCodec().encode(b"abc")), b"abc")

  def test_json_codec_round_trip(self) -> None:
    self.assertEqual(JsonCodec().decode(JsonCodec().encode({"ok": True})), {"ok": True})

  def test_protobuf_codec_round_trip(self) -> None:
    proto = FakeProto()
    proto.data = b"payload"
    decoded = ProtobufCodec(FakeProto).decode(ProtobufCodec(FakeProto).encode(proto))
    self.assertEqual(decoded.data, b"payload")

  def test_ros2_format_descriptor_content_type(self) -> None:
    fmt = ros2_srv_format("action_service/srv/PlayAction")
    self.assertEqual(fmt.resolved_content_type(), "application/vnd.ros2.srv")


if __name__ == "__main__":
  unittest.main()
