package core

import (
	"context"
	"testing"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

type fakeBus struct{}

func (fakeBus) Kind() communication.TransportKind {
	return communication.TransportNATS
}

func (fakeBus) Capabilities() Capabilities {
	return Capabilities{PublishSubscribe: true, RequestReply: true}
}

func (fakeBus) Connect(context.Context) error {
	return nil
}

func (fakeBus) Close(context.Context) error {
	return nil
}

func (fakeBus) Publish(context.Context, Channel, []byte) error {
	return nil
}

func (fakeBus) Subscribe(context.Context, Channel, BytesHandler) error {
	return nil
}

func (fakeBus) Request(context.Context, Channel, []byte, time.Duration) ([]byte, error) {
	return []byte("ok"), nil
}

func (fakeBus) HandleRequest(context.Context, Channel, RequestHandler) error {
	return nil
}

func TestNormalizeKind(t *testing.T) {
	kind, err := NormalizeKind("cyclone-dds")
	if err != nil {
		t.Fatalf("NormalizeKind returned error: %v", err)
	}
	if kind != communication.TransportCycloneDDS {
		t.Fatalf("kind = %q, want %q", kind, communication.TransportCycloneDDS)
	}

	if _, err = NormalizeKind("cyclonedds-rmw-cyclonedds"); err == nil {
		t.Fatal("expected explicit CycloneDDS runtime alias to be rejected")
	}
	if _, err = NormalizeKind("fastdds-rmw-fastrtps"); err == nil {
		t.Fatal("expected explicit Fast DDS runtime alias to be rejected")
	}
}

func TestRegistry(t *testing.T) {
	Register(communication.TransportNATS, func(BusConfig) (MessageBus, error) {
		return fakeBus{}, nil
	})

	bus, err := NewBusByKind(communication.TransportNATS, nil)
	if err != nil {
		t.Fatalf("NewBusByKind returned error: %v", err)
	}
	if !bus.Capabilities().RequestReply {
		t.Fatalf("registered bus should support request/reply")
	}
}

func TestFabricBindsRuntimeMiddlewareName(t *testing.T) {
	Register(communication.TransportFastDDS, func(BusConfig) (MessageBus, error) {
		return fakeBus{}, nil
	})
	Register(communication.TransportROS2, func(BusConfig) (MessageBus, error) {
		return fakeBus{}, nil
	})
	fabric, err := NewFabric(
		map[string]BusConfig{
			"fastdds":      {Transport: communication.TransportFastDDS},
			"fastdds__rmw": {Transport: communication.TransportROS2},
		},
		[]communication.PubSubRoute{
			{
				Name: "fast_play",
				Publisher: communication.Endpoint{
					Transport: communication.TransportROS2,
					Address:   "/fast/play",
					Metadata: map[string]string{
						"middleware":         "fastdds",
						"middleware.runtime": "fastdds__rmw",
					},
				},
				Subscriber: communication.Endpoint{Transport: communication.TransportInProcess, Address: "planner"},
				Enabled:    true,
			},
		},
		nil,
	)
	if err != nil {
		t.Fatalf("NewFabric returned error: %v", err)
	}
	bound, err := fabric.Publisher("fast_play")
	if err != nil {
		t.Fatalf("Publisher returned error: %v", err)
	}
	if bound.BusName != "fastdds__rmw" {
		t.Fatalf("expected runtime middleware bus, got %q", bound.BusName)
	}
}

func TestChannelFromEndpointCarriesQueueGroup(t *testing.T) {
	channel := ChannelFromEndpoint(communication.Endpoint{
		Address:     "robot.rpc.play_action",
		MessageType: "demo/PlayAction",
		Metadata: map[string]string{
			"middleware":  "local_nats",
			"queue_group": "action_service",
		},
	})

	if channel.QueueGroup != "action_service" {
		t.Fatalf("QueueGroup = %q, want action_service", channel.QueueGroup)
	}
	if channel.Metadata["middleware"] != "local_nats" {
		t.Fatalf("metadata should be preserved")
	}
}

type recordingBus struct {
	published int
	requested int
	handled   int
}

func (b *recordingBus) Kind() communication.TransportKind {
	return communication.TransportNATS
}

func (b *recordingBus) Capabilities() Capabilities {
	return Capabilities{PublishSubscribe: true, RequestReply: true}
}

func (b *recordingBus) Connect(context.Context) error {
	return nil
}

func (b *recordingBus) Close(context.Context) error {
	return nil
}

func (b *recordingBus) Publish(context.Context, Channel, []byte) error {
	b.published++
	return nil
}

func (b *recordingBus) Subscribe(context.Context, Channel, BytesHandler) error {
	return nil
}

func (b *recordingBus) Request(context.Context, Channel, []byte, time.Duration) ([]byte, error) {
	b.requested++
	return []byte("ok"), nil
}

func (b *recordingBus) HandleRequest(context.Context, Channel, RequestHandler) error {
	b.handled++
	return nil
}

func TestFanoutBusPublishesToAllAndRequestsPrimary(t *testing.T) {
	first := &recordingBus{}
	second := &recordingBus{}
	bus, err := NewFanoutBus(0, first, second)
	if err != nil {
		t.Fatalf("NewFanoutBus returned error: %v", err)
	}

	if err := bus.Publish(context.Background(), Channel{Name: "robot.state"}, []byte("payload")); err != nil {
		t.Fatalf("Publish returned error: %v", err)
	}
	if first.published != 1 || second.published != 1 {
		t.Fatalf("expected both buses to publish, got first=%d second=%d", first.published, second.published)
	}

	if _, err := bus.Request(context.Background(), Channel{Name: "robot.rpc"}, []byte("request"), time.Second); err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if first.requested != 1 || second.requested != 0 {
		t.Fatalf("expected only primary request, got first=%d second=%d", first.requested, second.requested)
	}

	if err := bus.HandleRequest(context.Background(), Channel{Name: "robot.rpc"}, func(context.Context, []byte) ([]byte, error) {
		return []byte("ok"), nil
	}); err != nil {
		t.Fatalf("HandleRequest returned error: %v", err)
	}
	if first.handled != 1 || second.handled != 0 {
		t.Fatalf("expected only primary request handler, got first=%d second=%d", first.handled, second.handled)
	}
}
