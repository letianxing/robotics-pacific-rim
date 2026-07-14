package dds

import (
	"context"
	"testing"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

type fakeByteClient struct {
	published TopicConfig
}

type fakeRPCAdapter struct {
	binding    RPCBinding
	payload    []byte
	timeoutSet bool
}

type fakeClientRPCAdapter struct {
	fakeRPCAdapter
	client ByteClient
}

func (f *fakeByteClient) Connect(context.Context, CycloneDDSConfig) error { return nil }
func (f *fakeByteClient) Close(context.Context) error                     { return nil }

func (f *fakeByteClient) PreparePublish(_ context.Context, topic TopicConfig) error {
	f.published = topic
	return nil
}

func (f *fakeByteClient) Publish(_ context.Context, topic TopicConfig, _ []byte) error {
	f.published = topic
	return nil
}

func (f *fakeByteClient) Subscribe(context.Context, Subscription, ByteHandler) error {
	return nil
}

func (f *fakeRPCAdapter) Request(_ context.Context, binding RPCBinding, payload []byte, timeout time.Duration) ([]byte, error) {
	f.binding = binding
	f.payload = payload
	f.timeoutSet = timeout > 0
	return []byte("response"), nil
}

func (f *fakeRPCAdapter) HandleRequest(_ context.Context, binding RPCBinding, handler func(context.Context, []byte) ([]byte, error)) error {
	f.binding = binding
	response, err := handler(context.Background(), []byte("request"))
	if err != nil {
		return err
	}
	f.payload = response
	return nil
}

func (f *fakeClientRPCAdapter) RequestWithClient(
	_ context.Context,
	client ByteClient,
	binding RPCBinding,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	f.client = client
	return f.Request(context.Background(), binding, payload, timeout)
}

func (f *fakeClientRPCAdapter) HandleRequestWithClient(
	_ context.Context,
	client ByteClient,
	binding RPCBinding,
	handler func(context.Context, []byte) ([]byte, error),
) error {
	f.client = client
	return f.HandleRequest(context.Background(), binding, handler)
}

func TestBusMergesMiddlewareAndRouteQoS(t *testing.T) {
	client := &fakeByteClient{}
	bus := NewBus(
		DefaultConfig(),
		"PacificRimMessageEnvelope",
		map[string]string{"reliability": "reliable", "depth": "10"},
		client,
	)

	err := bus.Publish(
		context.Background(),
		core.Channel{
			Name:        "RobotState",
			MessageType: "RobotStateType",
			Metadata: map[string]string{
				"qos.reliability": "best_effort",
				"qos.deadline_ms": "50",
			},
		},
		[]byte("payload"),
	)
	if err != nil {
		t.Fatalf("Publish returned error: %v", err)
	}

	if client.published.TypeName != "PacificRimMessageEnvelope" {
		t.Fatalf("expected DDS envelope type, got %#v", client.published)
	}
	if client.published.QoS["reliability"] != "best_effort" ||
		client.published.QoS["depth"] != "10" ||
		client.published.QoS["deadline_ms"] != "50" {
		t.Fatalf("unexpected QoS merge: %#v", client.published.QoS)
	}
}

func TestConfigFromOptionsParsesQoS(t *testing.T) {
	cfg, typeName, qos, err := ConfigFromOptions(map[string]any{
		"domain_id":       37,
		"type_name":       "RobotState",
		"read_period_sec": "0.02",
		"qos.reliability": "reliable",
	})
	if err != nil {
		t.Fatalf("ConfigFromOptions returned error: %v", err)
	}
	if cfg.DomainID != 37 || typeName != "RobotState" {
		t.Fatalf("unexpected config: %#v type=%q", cfg, typeName)
	}
	if cfg.ReadPeriodSec != 0.02 {
		t.Fatalf("unexpected read period: %#v", cfg)
	}
	if qos["reliability"] != "reliable" {
		t.Fatalf("unexpected QoS: %#v", qos)
	}
}

func TestConfigFromOptionsDefaultsNativeDomainAwayFromROSDomain(t *testing.T) {
	t.Setenv("ROS_DOMAIN_ID", "42")
	t.Setenv("PACIFIC_RIM_NATIVE_DDS_DOMAIN_ID", "")
	t.Setenv("PACIFIC_RIM_NATIVE_DDS_DOMAIN_OFFSET", "")

	cfg, _, _, err := ConfigFromOptions(map[string]any{})
	if err != nil {
		t.Fatalf("ConfigFromOptions returned error: %v", err)
	}
	if cfg.DomainID != 142 {
		t.Fatalf("expected default native DDS domain to be offset from ROS domain, got %#v", cfg)
	}

	cfg, _, _, err = ConfigFromOptions(map[string]any{"native_domain_offset": 5})
	if err != nil {
		t.Fatalf("ConfigFromOptions returned error: %v", err)
	}
	if cfg.DomainID != 47 {
		t.Fatalf("expected custom native DDS domain offset, got %#v", cfg)
	}

	cfg, _, _, err = ConfigFromOptions(map[string]any{"ros_domain_id": 42})
	if err != nil {
		t.Fatalf("ConfigFromOptions returned error: %v", err)
	}
	if cfg.DomainID != 142 {
		t.Fatalf("ros_domain_id should be a base for native DDS isolation, got %#v", cfg)
	}

	cfg, _, _, err = ConfigFromOptions(map[string]any{"domain_id": 42})
	if err != nil {
		t.Fatalf("ConfigFromOptions returned error: %v", err)
	}
	if cfg.DomainID != 42 {
		t.Fatalf("explicit domain_id must be honored, got %#v", cfg)
	}

	cfg, _, _, err = ConfigFromOptions(map[string]any{"native_domain_id": 9})
	if err != nil {
		t.Fatalf("ConfigFromOptions returned error: %v", err)
	}
	if cfg.DomainID != 9 {
		t.Fatalf("explicit native_domain_id must be honored, got %#v", cfg)
	}
}

func TestBusKind(t *testing.T) {
	bus := NewBus(DefaultConfig(), "PacificRimBytes", nil, &fakeByteClient{})
	if bus.Kind() != communication.TransportCycloneDDS {
		t.Fatalf("unexpected kind: %s", bus.Kind())
	}
}

func TestBusRequestsThroughConfiguredDDSRPCAdapter(t *testing.T) {
	adapter := &fakeRPCAdapter{}
	bus := NewBusWithRPCAdapters(
		DefaultConfig(),
		"DefaultBytes",
		map[string]string{"reliability": "reliable"},
		&fakeByteClient{},
		map[string]RPCAdapter{"rmw_cyclonedds": adapter},
	)
	response, err := bus.Request(
		context.Background(),
		core.Channel{
			Name:        "fallback.request",
			MessageType: "demo.Plan",
			Metadata: map[string]string{
				"rpc.standard":         "rmw-cyclonedds",
				"rpc.request_channel":  "planner.request.plan_action",
				"rpc.response_channel": "planner.response.plan_action",
				"qos.depth":            "3",
			},
		},
		[]byte("request"),
		time.Second,
	)
	if err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if string(response) != "response" || string(adapter.payload) != "request" || !adapter.timeoutSet {
		t.Fatalf("unexpected adapter response: response=%q adapter=%#v", response, adapter)
	}
	if adapter.binding.Standard != "rmw_cyclonedds" {
		t.Fatalf("unexpected standard: %#v", adapter.binding)
	}
	if adapter.binding.RequestChannel.TopicName != "planner.request.plan_action" ||
		adapter.binding.ResponseChannel.TopicName != "planner.response.plan_action" ||
		adapter.binding.RequestChannel.TypeName != "DefaultBytes" ||
		adapter.binding.RequestChannel.QoS["depth"] != "3" {
		t.Fatalf("unexpected binding: %#v", adapter.binding)
	}
}

func TestBusHandlesRequestsThroughConfiguredDDSRPCAdapter(t *testing.T) {
	adapter := &fakeRPCAdapter{}
	bus := NewBusWithRPCAdapters(
		DefaultConfig(),
		"DefaultBytes",
		map[string]string{"reliability": "reliable"},
		&fakeByteClient{},
		map[string]RPCAdapter{"omg_dds_rpc": adapter},
	)
	err := bus.HandleRequest(
		context.Background(),
		core.Channel{
			Name:        "planner.request.plan_action",
			MessageType: "demo.Plan",
			Metadata: map[string]string{
				"rpc.standard":         "omg-dds-rpc",
				"rpc.response_channel": "planner.response.plan_action",
				"qos.depth":            "3",
			},
		},
		func(context.Context, []byte) ([]byte, error) {
			return []byte("response"), nil
		},
	)
	if err != nil {
		t.Fatalf("HandleRequest returned error: %v", err)
	}
	if string(adapter.payload) != "response" {
		t.Fatalf("unexpected adapter payload: %q", adapter.payload)
	}
	if adapter.binding.Standard != "omg_dds_rpc" ||
		adapter.binding.RequestChannel.TopicName != "planner.request.plan_action" ||
		adapter.binding.ResponseChannel.TopicName != "planner.response.plan_action" ||
		adapter.binding.RequestChannel.TypeName != "DefaultBytes" ||
		adapter.binding.RequestChannel.QoS["depth"] != "3" {
		t.Fatalf("unexpected binding: %#v", adapter.binding)
	}
}

func TestBusPassesConnectedClientToClientAwareRPCAdapter(t *testing.T) {
	client := &fakeByteClient{}
	adapter := &fakeClientRPCAdapter{}
	bus := NewBusWithRPCAdapters(
		DefaultConfig(),
		"DefaultBytes",
		nil,
		client,
		map[string]RPCAdapter{"omg_dds_rpc": adapter},
	)
	_, err := bus.Request(
		context.Background(),
		core.Channel{
			Name: "planner.request",
			Metadata: map[string]string{
				"rpc.standard": "omg_dds_rpc",
			},
		},
		[]byte("request"),
		time.Second,
	)
	if err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if adapter.client != client {
		t.Fatalf("expected adapter to reuse bus byte client")
	}
}
