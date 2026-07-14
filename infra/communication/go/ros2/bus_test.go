package ros2

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

func TestBridgeModeCreatesRosbridgeBackend(t *testing.T) {
	RegisterNativeBackend(nil)
	bus, err := NewBus(core.BusConfig{Options: map[string]any{"mode": "bridge", "bridge.url": "ws://robot:9090"}})
	if err != nil {
		t.Fatalf("NewBus returned error: %v", err)
	}
	rosBus, ok := bus.(*Bus)
	if !ok || rosBus.mode != "bridge" || rosBus.backend == nil {
		t.Fatalf("expected rosbridge backend, got %#v", bus)
	}
	bridge, ok := rosBus.backend.(*RosbridgeBus)
	if !ok || bridge.url != "ws://robot:9090" {
		t.Fatalf("expected rosbridge backend URL, got %#v", rosBus.backend)
	}
}

func TestAutoModeFailsWithoutNativeOrDeploymentBridge(t *testing.T) {
	RegisterNativeBackend(nil)
	bus, err := NewBus(core.BusConfig{})
	if err != nil {
		t.Fatalf("NewBus returned error: %v", err)
	}
	err = bus.Connect(context.Background())
	if err == nil || !strings.Contains(err.Error(), "build with -tags pacific_rim_ros2_rclgo") {
		t.Fatalf("expected native build tag guidance, got %v", err)
	}
	if !strings.Contains(err.Error(), "PACIFIC_RIM_ROS2_BRIDGE=true") {
		t.Fatalf("expected rosbridge fallback guidance, got %v", err)
	}
}

func TestNativeModeFailsWithBindingGuidance(t *testing.T) {
	RegisterNativeBackend(nil)
	bus, err := NewBus(core.BusConfig{Options: map[string]any{"mode": "native"}})
	if err != nil {
		t.Fatalf("NewBus returned error: %v", err)
	}
	err = bus.Connect(context.Background())
	if err == nil || !strings.Contains(err.Error(), "build with -tags pacific_rim_ros2_rclgo") {
		t.Fatalf("expected native build tag guidance, got %v", err)
	}
}

func TestAutoModeUsesDeploymentBridgeWhenEnabled(t *testing.T) {
	RegisterNativeBackend(nil)
	t.Setenv("PACIFIC_RIM_ROS2_BRIDGE", "true")
	t.Setenv("PACIFIC_RIM_ROS2_BRIDGE_URL", "ws://robot:9090")
	bus, err := NewBus(core.BusConfig{})
	if err != nil {
		t.Fatalf("NewBus returned error: %v", err)
	}
	rosBus, ok := bus.(*Bus)
	if !ok || rosBus.mode != "bridge" || rosBus.backend == nil {
		t.Fatalf("expected auto bridge fallback, got %#v", bus)
	}
	bridge, ok := rosBus.backend.(*RosbridgeBus)
	if !ok || bridge.url != "ws://robot:9090" {
		t.Fatalf("expected env rosbridge URL, got %#v", rosBus.backend)
	}
}

func TestSplitROS2MessageType(t *testing.T) {
	tests := map[string]string{
		"std_msgs/msg/String":        "std_msgs/String",
		"std_msgs/String":            "std_msgs/String",
		"/common/msg/ProtoEnvelope/": "common/ProtoEnvelope",
	}
	for input, want := range tests {
		pkgName, ifaceName, err := splitROS2MessageType(input)
		if err != nil {
			t.Fatalf("splitROS2MessageType(%q) returned error: %v", input, err)
		}
		if got := pkgName + "/" + ifaceName; got != want {
			t.Fatalf("splitROS2MessageType(%q) = %q, want %q", input, got, want)
		}
	}
	if _, _, err := splitROS2MessageType("demo/srv/Call"); err == nil {
		t.Fatal("expected service type to be rejected as a message type")
	}
}

func TestSplitROS2ServiceType(t *testing.T) {
	tests := map[string]string{
		"example_interfaces/srv/AddTwoInts": "example_interfaces/AddTwoInts",
		"example_interfaces/AddTwoInts":     "example_interfaces/AddTwoInts",
		"/common/srv/ProtoCall/":            "common/ProtoCall",
	}
	for input, want := range tests {
		pkgName, ifaceName, err := splitROS2ServiceType(input)
		if err != nil {
			t.Fatalf("splitROS2ServiceType(%q) returned error: %v", input, err)
		}
		if got := pkgName + "/" + ifaceName; got != want {
			t.Fatalf("splitROS2ServiceType(%q) = %q, want %q", input, got, want)
		}
	}
	if _, _, err := splitROS2ServiceType("demo/msg/Event"); err == nil {
		t.Fatal("expected message type to be rejected as a service type")
	}
}

func TestRosbridgeGraphTypesUseRosbridgeForm(t *testing.T) {
	msgType, err := rosbridgeMessageType(core.Channel{MessageType: "common/msg/ProtoEnvelope"})
	if err != nil {
		t.Fatalf("rosbridgeMessageType returned error: %v", err)
	}
	if msgType != "common/ProtoEnvelope" {
		t.Fatalf("unexpected rosbridge message type %q", msgType)
	}
	serviceType, err := rosbridgeServiceType(core.Channel{MessageType: "common/srv/ProtoCall"})
	if err != nil {
		t.Fatalf("rosbridgeServiceType returned error: %v", err)
	}
	if serviceType != "common/ProtoCall" {
		t.Fatalf("unexpected rosbridge service type %q", serviceType)
	}
}

func TestProtoEnvelopeCDRRoundTrip(t *testing.T) {
	channel := core.Channel{
		Name:        "/proto/state",
		MessageType: "demo.RobotState",
		Metadata: map[string]string{
			"adapter":       "ros2_proto_envelope",
			"codec":         "protobuf",
			"logical_route": "robot_state",
			"trace_id":      "trace-1",
			"traceparent":   "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
		},
	}
	payload := []byte{0x08, 0x2a, 0x12, 0x03, 'b', 'o', 't'}
	encoded := encodeChannelProtoEnvelope(channel, payload)
	decoded, err := decodeProtoEnvelopeCDR(encoded)
	if err != nil {
		t.Fatalf("decodeProtoEnvelopeCDR returned error: %v", err)
	}
	if decoded.SchemaType != "demo.RobotState" ||
		decoded.Codec != "protobuf" ||
		decoded.Route != "robot_state" ||
		decoded.TraceID != "trace-1" ||
		decoded.Traceparent != "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00" ||
		string(decoded.Payload) != string(payload) ||
		decoded.CreatedAtUnixMS == 0 {
		t.Fatalf("unexpected decoded envelope: %#v", decoded)
	}
}

func TestProtoEnvelopeCDRMatchesRclpySerialization(t *testing.T) {
	encoded := encodeProtoEnvelopeCDR(protoEnvelope{
		SchemaType:      "demo.RobotState",
		Codec:           "protobuf",
		Route:           "robot_state",
		TraceID:         "trace-1",
		Traceparent:     "tp",
		CreatedAtUnixMS: 123456789,
		Payload:         []byte{0x08, 0x2a, 0x12, 0x03, 'b', 'o', 't'},
	})
	want := []byte{
		0, 1, 0, 0,
		16, 0, 0, 0, 'd', 'e', 'm', 'o', '.', 'R', 'o', 'b', 'o', 't', 'S', 't', 'a', 't', 'e', 0,
		9, 0, 0, 0, 'p', 'r', 'o', 't', 'o', 'b', 'u', 'f', 0,
		0, 0, 0,
		12, 0, 0, 0, 'r', 'o', 'b', 'o', 't', '_', 's', 't', 'a', 't', 'e', 0,
		8, 0, 0, 0, 't', 'r', 'a', 'c', 'e', '-', '1', 0,
		3, 0, 0, 0, 't', 'p', 0,
		0,
		21, 205, 91, 7, 0, 0, 0, 0,
		7, 0, 0, 0, 8, 42, 18, 3, 'b', 'o', 't',
	}
	if string(encoded) != string(want) {
		t.Fatalf("encoded CDR mismatch\n got: %v\nwant: %v", encoded, want)
	}
}

func TestRosbridgeProtoEnvelopeJSONUsesROSUint8Array(t *testing.T) {
	channel := core.Channel{
		Name:        "/proto/state",
		MessageType: "demo.RobotState",
		Metadata: map[string]string{
			"adapter":       "ros2_proto_envelope",
			"codec":         "protobuf",
			"logical_route": "robot_state",
			"trace_id":      "trace-1",
			"traceparent":   "tp",
		},
	}
	raw, err := rosbridgeOutboundMessage(channel, []byte{0x08, 0x2a, 0xff})
	if err != nil {
		t.Fatalf("rosbridgeOutboundMessage returned error: %v", err)
	}
	var got struct {
		SchemaType  string `json:"schema_type"`
		Codec       string `json:"codec"`
		Route       string `json:"route"`
		TraceID     string `json:"trace_id"`
		Traceparent string `json:"traceparent"`
		Payload     []int  `json:"payload"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal rosbridge envelope: %v", err)
	}
	if got.SchemaType != "demo.RobotState" || got.Codec != "protobuf" ||
		got.Route != "robot_state" || got.TraceID != "trace-1" || got.Traceparent != "tp" {
		t.Fatalf("unexpected rosbridge envelope metadata: %#v", got)
	}
	if len(got.Payload) != 3 || got.Payload[0] != 0x08 || got.Payload[1] != 0x2a || got.Payload[2] != 0xff {
		t.Fatalf("unexpected rosbridge payload array: %#v", got.Payload)
	}
	decoded, err := rosbridgeInboundMessage(channel, raw)
	if err != nil {
		t.Fatalf("rosbridgeInboundMessage returned error: %v", err)
	}
	if string(decoded) != string([]byte{0x08, 0x2a, 0xff}) {
		t.Fatalf("unexpected decoded payload: %v", decoded)
	}
}

func TestTypedMapperRegistryUsesSchemaAndROS2Type(t *testing.T) {
	channel := core.Channel{
		Name:        "/server/mode",
		MessageType: "std_msgs/msg/String",
		Metadata: map[string]string{
			"adapter":          "ros2_typed_mapper",
			"schema.type":      "demo.ServerMode",
			"ros_message_type": "std_msgs/msg/String",
		},
	}
	if _, err := encodeTypedMappedPayload(channel, []byte("proto")); err == nil {
		t.Fatal("expected missing typed mapper to fail")
	}
	RegisterTypedMapper("demo.ServerMode", "std_msgs/msg/String", TypedMapperFunc{
		ProtoToROS2CDRFunc: func(got core.Channel, payload []byte) ([]byte, error) {
			if got.Name != channel.Name {
				t.Fatalf("unexpected channel: %#v", got)
			}
			return append([]byte("cdr:"), payload...), nil
		},
		ROS2CDRToProtoFunc: func(got core.Channel, payload []byte) ([]byte, error) {
			if got.Name != channel.Name {
				t.Fatalf("unexpected channel: %#v", got)
			}
			return append([]byte("proto:"), payload...), nil
		},
	})
	encoded, err := encodeTypedMappedPayload(channel, []byte("payload"))
	if err != nil {
		t.Fatalf("encodeTypedMappedPayload returned error: %v", err)
	}
	if string(encoded) != "cdr:payload" {
		t.Fatalf("unexpected encoded payload: %q", encoded)
	}
	decoded, err := decodeTypedMappedPayload(channel, []byte("wire"))
	if err != nil {
		t.Fatalf("decodeTypedMappedPayload returned error: %v", err)
	}
	if string(decoded) != "proto:wire" {
		t.Fatalf("unexpected decoded payload: %q", decoded)
	}
}

func TestRosbridgeTypedMapperRegistryUsesSchemaAndROS2Type(t *testing.T) {
	channel := core.Channel{
		Name:        "/server/mode",
		MessageType: "std_msgs/msg/String",
		Metadata: map[string]string{
			"adapter":          "ros2_typed_mapper",
			"schema.type":      "demo.ServerMode",
			"ros_message_type": "std_msgs/msg/String",
		},
	}
	if _, err := rosbridgeOutboundMessage(channel, []byte("proto")); err == nil {
		t.Fatal("expected missing rosbridge typed mapper to fail")
	}
	RegisterRosbridgeTypedMapper("demo.ServerMode", "std_msgs/msg/String", RosbridgeTypedMapperFunc{
		ProtoToROS2JSONFunc: func(got core.Channel, payload []byte) (json.RawMessage, error) {
			if got.Name != channel.Name {
				t.Fatalf("unexpected channel: %#v", got)
			}
			return json.Marshal(map[string]string{"data": "json:" + string(payload)})
		},
		ROS2JSONToProtoFunc: func(got core.Channel, payload json.RawMessage) ([]byte, error) {
			if got.Name != channel.Name {
				t.Fatalf("unexpected channel: %#v", got)
			}
			var value map[string]string
			if err := json.Unmarshal(payload, &value); err != nil {
				return nil, err
			}
			return []byte("proto:" + value["data"]), nil
		},
	})
	encoded, err := rosbridgeOutboundMessage(channel, []byte("payload"))
	if err != nil {
		t.Fatalf("rosbridgeOutboundMessage returned error: %v", err)
	}
	if string(encoded) != `{"data":"json:payload"}` {
		t.Fatalf("unexpected encoded JSON: %s", encoded)
	}
	decoded, err := rosbridgeInboundMessage(channel, json.RawMessage(`{"data":"wire"}`))
	if err != nil {
		t.Fatalf("rosbridgeInboundMessage returned error: %v", err)
	}
	if string(decoded) != "proto:wire" {
		t.Fatalf("unexpected decoded payload: %q", decoded)
	}
}

func TestNativeModeDelegatesToRegisteredBackend(t *testing.T) {
	backend := &fakeNativeBackend{
		response: []byte("response"),
	}
	RegisterNativeBackend(func(core.BusConfig) (core.MessageBus, error) {
		return backend, nil
	})
	defer RegisterNativeBackend(nil)

	bus, err := NewBus(core.BusConfig{Options: map[string]any{"mode": "native"}})
	if err != nil {
		t.Fatalf("NewBus returned error: %v", err)
	}
	if err := bus.Connect(context.Background()); err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}
	channel := core.Channel{Name: "/proto/envelope"}
	if err := bus.Publish(context.Background(), channel, []byte("payload")); err != nil {
		t.Fatalf("Publish returned error: %v", err)
	}
	response, err := bus.Request(context.Background(), channel, []byte("request"), time.Second)
	if err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if string(response) != "response" {
		t.Fatalf("unexpected response: %q", response)
	}
	if err := bus.HandleRequest(context.Background(), channel, func(context.Context, []byte) ([]byte, error) {
		return []byte("handled"), nil
	}); err != nil {
		t.Fatalf("HandleRequest returned error: %v", err)
	}
	if err := bus.Close(context.Background()); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
	if !backend.connected || !backend.closed || string(backend.published) != "payload" ||
		string(backend.requested) != "request" || !backend.handled {
		t.Fatalf("backend was not delegated correctly: %#v", backend)
	}
}

type fakeNativeBackend struct {
	connected bool
	closed    bool
	published []byte
	requested []byte
	response  []byte
	handled   bool
}

func (b *fakeNativeBackend) Kind() communication.TransportKind {
	return communication.TransportROS2
}

func (b *fakeNativeBackend) Capabilities() core.Capabilities {
	return core.Capabilities{PublishSubscribe: true, RequestReply: true}
}

func (b *fakeNativeBackend) Connect(context.Context) error {
	b.connected = true
	return nil
}

func (b *fakeNativeBackend) Close(context.Context) error {
	b.closed = true
	return nil
}

func (b *fakeNativeBackend) Publish(_ context.Context, _ core.Channel, payload []byte) error {
	b.published = append([]byte(nil), payload...)
	return nil
}

func (b *fakeNativeBackend) Subscribe(context.Context, core.Channel, core.BytesHandler) error {
	return nil
}

func (b *fakeNativeBackend) Request(_ context.Context, _ core.Channel, payload []byte, _ time.Duration) ([]byte, error) {
	b.requested = append([]byte(nil), payload...)
	return append([]byte(nil), b.response...), nil
}

func (b *fakeNativeBackend) HandleRequest(context.Context, core.Channel, core.RequestHandler) error {
	b.handled = true
	return nil
}
