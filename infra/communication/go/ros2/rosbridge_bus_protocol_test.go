package ros2

import (
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
	"golang.org/x/net/websocket"
)

func TestRosbridgeBusWebSocketProtoEnvelopeTopicAndService(t *testing.T) {
	var mu sync.Mutex
	seen := make([]rosbridgeMessage, 0, 8)
	gotServicePayload := make(chan []byte, 1)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("local TCP listener unavailable in this environment: %v", err)
	}
	server := httptest.NewUnstartedServer(websocket.Handler(func(conn *websocket.Conn) {
		for {
			var msg rosbridgeMessage
			if err := websocket.JSON.Receive(conn, &msg); err != nil {
				return
			}
			mu.Lock()
			seen = append(seen, msg)
			mu.Unlock()
			switch msg.Op {
			case "subscribe":
				envelope, err := marshalRosbridgeProtoEnvelope(protoEnvelope{
					SchemaType: "demo.State",
					Codec:      "protobuf",
					Route:      "robot_state",
					Payload:    []byte{0x0a, 0x03, 's', 'u', 'b'},
				})
				if err != nil {
					t.Errorf("marshal subscription envelope: %v", err)
					return
				}
				_ = websocket.JSON.Send(conn, rosbridgeMessage{
					Op:    "publish",
					Topic: msg.Topic,
					Msg:   envelope,
				})
			case "call_service":
				envelope, err := protoEnvelopeFromJSON(msg.Args)
				if err != nil {
					t.Errorf("decode service args: %v", err)
					return
				}
				gotServicePayload <- envelope.Payload
				values, err := marshalRosbridgeProtoEnvelope(protoEnvelope{
					SchemaType: "demo.CallResponse",
					Codec:      "protobuf",
					Route:      "robot_call",
					Payload:    []byte{0x12, 0x03, 'r', 'p', 'c'},
				})
				if err != nil {
					t.Errorf("marshal service response: %v", err)
					return
				}
				_ = websocket.JSON.Send(conn, rosbridgeMessage{
					Op:      "service_response",
					ID:      msg.ID,
					Service: msg.Service,
					Result:  true,
					Values:  values,
				})
			}
		}
	}))
	server.Listener = listener
	server.Start()
	defer server.Close()

	bus, err := NewRosbridgeBus(core.BusConfig{Options: map[string]any{
		"rosbridge_url": "ws" + strings.TrimPrefix(server.URL, "http"),
	}})
	if err != nil {
		t.Fatalf("NewRosbridgeBus returned error: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := bus.Connect(ctx); err != nil {
		t.Fatalf("Connect returned error: %v", err)
	}
	defer bus.Close(context.Background())

	topic := core.Channel{
		Name:        "/robot/state",
		MessageType: "common/msg/ProtoEnvelope",
		Metadata: map[string]string{
			"adapter":       "ros2_proto_envelope",
			"schema.type":   "demo.State",
			"logical_route": "robot_state",
		},
	}
	received := make(chan []byte, 1)
	if err := bus.Subscribe(ctx, topic, func(_ context.Context, payload []byte) error {
		received <- append([]byte(nil), payload...)
		return nil
	}); err != nil {
		t.Fatalf("Subscribe returned error: %v", err)
	}
	if err := bus.Publish(ctx, topic, []byte{0x08, 0x2a}); err != nil {
		t.Fatalf("Publish returned error: %v", err)
	}
	select {
	case payload := <-received:
		if string(payload) != string([]byte{0x0a, 0x03, 's', 'u', 'b'}) {
			t.Fatalf("unexpected subscription payload: %v", payload)
		}
	case <-ctx.Done():
		t.Fatal("subscription payload timeout")
	}

	service := core.Channel{
		Name:        "/robot/call",
		MessageType: "common/srv/ProtoCall",
		Metadata: map[string]string{
			"adapter":       "ros2_proto_envelope",
			"schema.type":   "demo.CallRequest",
			"logical_route": "robot_call",
		},
	}
	response, err := bus.Request(ctx, service, []byte{0x08, 0x07}, time.Second)
	if err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if string(response) != string([]byte{0x12, 0x03, 'r', 'p', 'c'}) {
		t.Fatalf("unexpected service response payload: %v", response)
	}
	select {
	case payload := <-gotServicePayload:
		if string(payload) != string([]byte{0x08, 0x07}) {
			t.Fatalf("unexpected service request payload: %v", payload)
		}
	default:
		t.Fatal("server did not receive service payload")
	}

	mu.Lock()
	defer mu.Unlock()
	if !hasRosbridgeOp(seen, "subscribe", "/robot/state", "common/ProtoEnvelope") {
		t.Fatalf("subscribe op was not sent correctly: %#v", seen)
	}
	if !hasRosbridgeOp(seen, "advertise", "/robot/state", "common/ProtoEnvelope") {
		t.Fatalf("advertise op was not sent correctly: %#v", seen)
	}
	if !hasRosbridgePublishEnvelope(seen, "/robot/state", []byte{0x08, 0x2a}) {
		t.Fatalf("publish envelope was not sent correctly: %#v", seen)
	}
	if !hasRosbridgeServiceCall(seen, "/robot/call", "common/ProtoCall") {
		t.Fatalf("service call was not sent correctly: %#v", seen)
	}
}

func hasRosbridgeOp(messages []rosbridgeMessage, op string, topic string, typ string) bool {
	for _, msg := range messages {
		if msg.Op == op && msg.Topic == topic && msg.Type == typ {
			return true
		}
	}
	return false
}

func hasRosbridgePublishEnvelope(messages []rosbridgeMessage, topic string, want []byte) bool {
	for _, msg := range messages {
		if msg.Op != "publish" || msg.Topic != topic {
			continue
		}
		envelope, err := protoEnvelopeFromJSON(msg.Msg)
		if err == nil && string(envelope.Payload) == string(want) {
			return true
		}
	}
	return false
}

func hasRosbridgeServiceCall(messages []rosbridgeMessage, service string, typ string) bool {
	for _, msg := range messages {
		if msg.Op != "call_service" || msg.Service != service || msg.Type != typ {
			continue
		}
		var value map[string]json.RawMessage
		if json.Unmarshal(msg.Args, &value) == nil && len(value["payload"]) > 0 {
			return true
		}
	}
	return false
}
