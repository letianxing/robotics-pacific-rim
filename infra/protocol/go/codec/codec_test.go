package codec

import "testing"

import "google.golang.org/protobuf/types/known/wrapperspb"
import protocolformats "github.com/pacific-rim/pacific-rim/infra/protocol/go/codec/formats"

func TestRawBytesCodecCopiesData(t *testing.T) {
	codec := RawBytesCodec{}
	encoded, err := codec.Encode([]byte("abc"))
	if err != nil {
		t.Fatalf("encode failed: %v", err)
	}
	encoded[0] = 'x'

	decoded, err := codec.Decode([]byte("abc"))
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	decoded[0] = 'y'

	if string(encoded) != "xbc" {
		t.Fatalf("encoded copy was not mutable independently: %q", string(encoded))
	}
	if string(decoded) != "ybc" {
		t.Fatalf("decoded copy was not mutable independently: %q", string(decoded))
	}
}

func TestJSONCodecRoundTrip(t *testing.T) {
	type payload struct {
		OK bool `json:"ok"`
	}

	codec := JSONCodec[payload]{}
	encoded, err := codec.Encode(payload{OK: true})
	if err != nil {
		t.Fatalf("encode failed: %v", err)
	}

	decoded, err := codec.Decode(encoded)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if !decoded.OK {
		t.Fatalf("decoded payload mismatch: %#v", decoded)
	}
}

func TestProtobufCodecRoundTrip(t *testing.T) {
	codec := ProtobufCodec[*wrapperspb.StringValue]{
		New: func() *wrapperspb.StringValue { return &wrapperspb.StringValue{} },
	}

	encoded, err := codec.Encode(wrapperspb.String("payload"))
	if err != nil {
		t.Fatalf("encode failed: %v", err)
	}

	decoded, err := codec.Decode(encoded)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if decoded.Value != "payload" {
		t.Fatalf("decoded protobuf mismatch: %#v", decoded)
	}
}

func TestDataFormatResolvedContentType(t *testing.T) {
	format := protocolformats.ROS2SrvFormat("action_service/srv/PlayAction")
	if got := format.ResolvedContentType(); got != "application/vnd.ros2.srv" {
		t.Fatalf("unexpected ROS2 srv content type: %q", got)
	}

	format.ContentType = "application/custom"
	if got := format.ResolvedContentType(); got != "application/custom" {
		t.Fatalf("expected custom content type, got %q", got)
	}
}
