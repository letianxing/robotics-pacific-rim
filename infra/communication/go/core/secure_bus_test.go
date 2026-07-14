package core

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

type securityRecordingBus struct {
	publishedPayload []byte
	handler          BytesHandler
	requestHandler   RequestHandler
}

func (b *securityRecordingBus) Kind() communication.TransportKind {
	return communication.TransportNATS
}

func (b *securityRecordingBus) Capabilities() Capabilities {
	return Capabilities{PublishSubscribe: true, RequestReply: true}
}

func (b *securityRecordingBus) Connect(context.Context) error {
	return nil
}

func (b *securityRecordingBus) Close(context.Context) error {
	return nil
}

func (b *securityRecordingBus) Publish(_ context.Context, _ Channel, payload []byte) error {
	b.publishedPayload = append([]byte(nil), payload...)
	return nil
}

func (b *securityRecordingBus) Subscribe(_ context.Context, _ Channel, handler BytesHandler) error {
	b.handler = handler
	return nil
}

func (b *securityRecordingBus) Request(context.Context, Channel, []byte, time.Duration) ([]byte, error) {
	return nil, nil
}

func (b *securityRecordingBus) HandleRequest(_ context.Context, _ Channel, handler RequestHandler) error {
	b.requestHandler = handler
	return nil
}

func TestSecureFabricEncryptsPubSubEndpointPayloads(t *testing.T) {
	t.Setenv("PR_TEST_COMM_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
	t.Setenv("PR_TEST_COMM_SALT", "cGFjaWZpYy1yaW0tc2VjdXJpdHktc2FsdC0wMDAx")

	rawBus := &securityRecordingBus{}
	security, err := NewSecurityRuntime(SecuritySettings{
		Profiles: map[string]SecurityProfileConfig{
			"robot_control": {
				Enabled: boolPtr(true),
				KeyID:   "robot-control-v1",
				KeyEnv:  "PR_TEST_COMM_KEY",
				SaltEnv: "PR_TEST_COMM_SALT",
			},
		},
	})
	if err != nil {
		t.Fatalf("NewSecurityRuntime returned error: %v", err)
	}
	routeMetadata := map[string]string{
		"middleware":            "nats",
		SecurityMetadataProfile: "robot_control",
		"source_name":           "robot_state",
		"logical_route":         "robot_state",
		"binding_name":          "state_nats",
	}
	fabric := &Fabric{
		buses: map[string]MessageBus{"nats": rawBus},
		busConfigs: map[string]BusConfig{
			"nats": {Transport: communication.TransportNATS},
		},
		pubsubRoutes: map[string]communication.PubSubRoute{
			"robot_state": {
				Name: "robot_state",
				Publisher: communication.Endpoint{
					Transport:   communication.TransportNATS,
					Address:     "robot.state",
					MessageType: "RobotState",
					Metadata:    routeMetadata,
				},
				Subscriber: communication.Endpoint{
					Transport:   communication.TransportNATS,
					Address:     "robot.state",
					MessageType: "RobotState",
					Metadata:    routeMetadata,
				},
				Enabled: true,
			},
		},
		rpcRoutes: map[string]communication.RPCRoute{},
		security:  security,
	}

	publisher, err := fabric.Publisher("robot_state")
	if err != nil {
		t.Fatalf("Publisher returned error: %v", err)
	}
	if err := publisher.Bus.Publish(context.Background(), publisher.Channel, []byte("hello")); err != nil {
		t.Fatalf("secure publish returned error: %v", err)
	}
	if string(rawBus.publishedPayload) == "hello" {
		t.Fatalf("raw bus received plaintext")
	}

	subscriber, err := fabric.Subscriber("robot_state")
	if err != nil {
		t.Fatalf("Subscriber returned error: %v", err)
	}
	var received []byte
	if err := subscriber.Bus.Subscribe(context.Background(), subscriber.Channel, func(_ context.Context, payload []byte) error {
		received = append([]byte(nil), payload...)
		return nil
	}); err != nil {
		t.Fatalf("secure subscribe returned error: %v", err)
	}
	if rawBus.handler == nil {
		t.Fatalf("raw bus handler was not registered")
	}
	if err := rawBus.handler(context.Background(), rawBus.publishedPayload); err != nil {
		t.Fatalf("raw handler returned error: %v", err)
	}
	if string(received) != "hello" {
		t.Fatalf("received = %q, want hello", received)
	}
}

func TestSecurityRuntimeRequiresExplicitNATSProfile(t *testing.T) {
	security, err := NewSecurityRuntime(SecuritySettings{RequireExplicitProfile: true})
	if err != nil {
		t.Fatalf("NewSecurityRuntime returned error: %v", err)
	}
	_, err = security.ResolveBinding(
		"nats",
		BusConfig{Transport: communication.TransportNATS},
		communication.Endpoint{Transport: communication.TransportNATS, Address: "robot.state"},
	)
	if err == nil {
		t.Fatalf("expected missing explicit security_profile to fail")
	}
}

func TestSecureMessageBusEncryptsRPCServerResponses(t *testing.T) {
	t.Setenv("PR_TEST_COMM_KEY", base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	t.Setenv("PR_TEST_COMM_SALT", base64.StdEncoding.EncodeToString([]byte("pacific-rim-security-salt-0001")))

	rawBus := &securityRecordingBus{}
	security, err := NewSecurityRuntime(SecuritySettings{
		Profiles: map[string]SecurityProfileConfig{
			"robot_control": {
				KeyID:   "robot-control-v1",
				KeyEnv:  "PR_TEST_COMM_KEY",
				SaltEnv: "PR_TEST_COMM_SALT",
			},
		},
	})
	if err != nil {
		t.Fatalf("NewSecurityRuntime returned error: %v", err)
	}
	endpoint := communication.Endpoint{
		Transport:   communication.TransportNATS,
		Address:     "robot.rpc",
		MessageType: "RobotRpc",
		Metadata: map[string]string{
			SecurityMetadataProfile: "robot_control",
			"logical_route":         "robot_rpc",
			"binding_name":          "rpc_nats",
		},
	}
	binding, err := security.ResolveBinding("nats", BusConfig{Transport: communication.TransportNATS}, endpoint)
	if err != nil {
		t.Fatalf("ResolveBinding returned error: %v", err)
	}
	bus, err := NewSecureMessageBus(rawBus, *binding)
	if err != nil {
		t.Fatalf("NewSecureMessageBus returned error: %v", err)
	}
	if err := bus.HandleRequest(context.Background(), Channel{Name: "robot.rpc"}, func(_ context.Context, payload []byte) ([]byte, error) {
		if string(payload) != "ping" {
			t.Fatalf("handler payload = %q, want ping", payload)
		}
		return []byte("pong"), nil
	}); err != nil {
		t.Fatalf("HandleRequest returned error: %v", err)
	}
	if rawBus.requestHandler == nil {
		t.Fatalf("raw bus request handler was not registered")
	}

	codec, err := NewSecurityCodec(*binding)
	if err != nil {
		t.Fatalf("NewSecurityCodec returned error: %v", err)
	}
	encryptedRequest, err := codec.Encrypt([]byte("ping"), "rpc_request")
	if err != nil {
		t.Fatalf("Encrypt request returned error: %v", err)
	}
	encryptedResponse, err := rawBus.requestHandler(context.Background(), encryptedRequest)
	if err != nil {
		t.Fatalf("raw request handler returned error: %v", err)
	}
	response, err := codec.Decrypt(encryptedResponse, "rpc_response")
	if err != nil {
		t.Fatalf("Decrypt response returned error: %v", err)
	}
	if string(response) != "pong" {
		t.Fatalf("response = %q, want pong", response)
	}
}

func boolPtr(value bool) *bool {
	return &value
}

func TestSecurityRuntimeResolvesSecrets(t *testing.T) {
	t.Setenv("PR_TEST_COMM_KEY", base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	t.Setenv("PR_TEST_COMM_SALT", base64.StdEncoding.EncodeToString([]byte("pacific-rim-security-salt-0001")))
	security, err := NewSecurityRuntime(SecuritySettings{
		Profiles: map[string]SecurityProfileConfig{
			"robot_control": {
				KeyID:   "robot-control-v1",
				KeyEnv:  "PR_TEST_COMM_KEY",
				SaltEnv: "PR_TEST_COMM_SALT",
			},
		},
	})
	if err != nil {
		t.Fatalf("NewSecurityRuntime returned error: %v", err)
	}
	binding, err := security.ResolveBinding(
		"nats",
		BusConfig{Transport: communication.TransportNATS, Options: map[string]any{SecurityOptionProfile: "robot_control"}},
		communication.Endpoint{Transport: communication.TransportNATS, Address: "robot.state"},
	)
	if err != nil {
		t.Fatalf("ResolveBinding returned error: %v", err)
	}
	if binding == nil || binding.Profile.Name != "robot_control" {
		t.Fatalf("binding profile = %#v, want robot_control", binding)
	}
}
