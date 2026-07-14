//go:build pacific_rim_fastdds

package fastdds

import (
	"context"
	"fmt"
	"testing"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/dds"
)

func TestNativeByteClientPublishesAndSubscribes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cfg := dds.DefaultConfig()
	cfg.DomainID = 68

	subscriber, err := NewNativeByteClient(cfg)
	if err != nil {
		t.Fatalf("new subscriber: %v", err)
	}
	if err := subscriber.Connect(ctx, cfg); err != nil {
		t.Fatalf("connect subscriber: %v", err)
	}
	defer func() {
		_ = subscriber.Close(context.Background())
	}()

	publisher, err := NewNativeByteClient(cfg)
	if err != nil {
		t.Fatalf("new publisher: %v", err)
	}
	if err := publisher.Connect(ctx, cfg); err != nil {
		t.Fatalf("connect publisher: %v", err)
	}
	defer func() {
		_ = publisher.Close(context.Background())
	}()

	topic := dds.TopicConfig{
		TopicName: fmt.Sprintf("pacific_rim_native_go_fastdds_test_%d", time.Now().UnixNano()),
		TypeName:  "PacificRimMessageEnvelope",
		QoS: map[string]string{
			"reliability": "reliable",
			"history":     "keep_last",
			"depth":       "16",
		},
	}

	received := make(chan []byte, 1)
	unsubscribe, err := subscriber.SubscribeManaged(ctx, dds.Subscription{Topic: topic}, func(_ context.Context, payload []byte) error {
		select {
		case received <- append([]byte(nil), payload...):
		default:
		}
		return nil
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer unsubscribe()

	deadline := time.After(4 * time.Second)
	payload := []byte("native-fastdds-go-ok")
	for {
		if err := publisher.Publish(ctx, topic, payload); err != nil {
			t.Fatalf("publish: %v", err)
		}
		select {
		case got := <-received:
			if string(got) != string(payload) {
				t.Fatalf("unexpected payload: %q", got)
			}
			return
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			t.Fatal("timed out waiting for native Fast DDS payload")
		case <-ctx.Done():
			t.Fatalf("context ended: %v", ctx.Err())
		}
	}
}

func TestNativeByteClientReceivesReliableBurst(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	cfg := dds.DefaultConfig()
	cfg.DomainID = 69

	subscriber, err := NewNativeByteClient(cfg)
	if err != nil {
		t.Fatalf("new subscriber: %v", err)
	}
	if err := subscriber.Connect(ctx, cfg); err != nil {
		t.Fatalf("connect subscriber: %v", err)
	}
	defer func() {
		_ = subscriber.Close(context.Background())
	}()

	publisher, err := NewNativeByteClient(cfg)
	if err != nil {
		t.Fatalf("new publisher: %v", err)
	}
	if err := publisher.Connect(ctx, cfg); err != nil {
		t.Fatalf("connect publisher: %v", err)
	}
	defer func() {
		_ = publisher.Close(context.Background())
	}()

	topic := dds.TopicConfig{
		TopicName: fmt.Sprintf("pacific_rim_native_go_fastdds_burst_%d", time.Now().UnixNano()),
		TypeName:  "PacificRimMessageEnvelope",
		QoS: map[string]string{
			"reliability": "reliable",
			"history":     "keep_last",
			"depth":       "128",
		},
	}

	received := make(chan string, 256)
	unsubscribe, err := subscriber.SubscribeManaged(ctx, dds.Subscription{Topic: topic}, func(_ context.Context, payload []byte) error {
		select {
		case received <- string(payload):
		default:
		}
		return nil
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer unsubscribe()

	warmup := []byte("warmup")
	for deadline := time.Now().Add(3 * time.Second); ; {
		if err := publisher.Publish(ctx, topic, warmup); err != nil {
			t.Fatalf("publish warmup: %v", err)
		}
		select {
		case got := <-received:
			if got == string(warmup) {
				goto burst
			}
		case <-time.After(50 * time.Millisecond):
			if time.Now().After(deadline) {
				t.Fatal("timed out waiting for Fast DDS warmup payload")
			}
		case <-ctx.Done():
			t.Fatalf("context ended: %v", ctx.Err())
		}
	}

burst:
	for {
		select {
		case <-received:
		default:
			goto publishBurst
		}
	}

publishBurst:
	const total = 64
	for i := 0; i < total; i++ {
		if err := publisher.Publish(ctx, topic, []byte(fmt.Sprintf("burst-%03d", i))); err != nil {
			t.Fatalf("publish burst %d: %v", i, err)
		}
		time.Sleep(time.Millisecond)
	}

	seen := map[string]bool{}
	for deadline := time.Now().Add(4 * time.Second); len(seen) < total; {
		select {
		case got := <-received:
			if len(got) == len("burst-000") && got[:6] == "burst-" {
				seen[got] = true
			}
		case <-time.After(20 * time.Millisecond):
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for Fast DDS burst payloads: got %d/%d", len(seen), total)
			}
		case <-ctx.Done():
			t.Fatalf("context ended after %d/%d burst payloads: %v", len(seen), total, ctx.Err())
		}
	}
}

func TestNativeBusPublishesSubscribesAndRequests(t *testing.T) {
	RegisterNativeBus()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	domainID := 78
	server, err := core.NewBusByKind(communication.TransportFastDDS, map[string]any{
		"domain_id":       domainID,
		"type_name":       "PacificRimMessageEnvelope",
		"qos.reliability": "reliable",
		"qos.history":     "keep_last",
		"qos.depth":       "32",
	})
	if err != nil {
		t.Fatalf("new server bus: %v", err)
	}
	if err := server.Connect(ctx); err != nil {
		t.Fatalf("connect server bus: %v", err)
	}
	defer func() {
		_ = server.Close(context.Background())
	}()

	client, err := core.NewBusByKind(communication.TransportFastDDS, map[string]any{
		"domain_id":       domainID,
		"type_name":       "PacificRimMessageEnvelope",
		"qos.reliability": "reliable",
		"qos.history":     "keep_last",
		"qos.depth":       "32",
	})
	if err != nil {
		t.Fatalf("new client bus: %v", err)
	}
	if err := client.Connect(ctx); err != nil {
		t.Fatalf("connect client bus: %v", err)
	}
	defer func() {
		_ = client.Close(context.Background())
	}()

	pubSubChannel := core.Channel{
		Name: fmt.Sprintf("pacific_rim_go_fastdds_bus_pubsub_%d", time.Now().UnixNano()),
	}
	received := make(chan []byte, 1)
	if err := server.Subscribe(ctx, pubSubChannel, func(_ context.Context, payload []byte) error {
		select {
		case received <- append([]byte(nil), payload...):
		default:
		}
		return nil
	}); err != nil {
		t.Fatalf("bus subscribe: %v", err)
	}
	pubSubPayload := []byte("bus-pubsub-ok")
	for deadline := time.Now().Add(3 * time.Second); ; {
		if err := client.Publish(ctx, pubSubChannel, pubSubPayload); err != nil {
			t.Fatalf("bus publish: %v", err)
		}
		select {
		case got := <-received:
			if string(got) != string(pubSubPayload) {
				t.Fatalf("unexpected bus payload: %q", got)
			}
			goto rpc
		case <-time.After(50 * time.Millisecond):
			if time.Now().After(deadline) {
				t.Fatal("timed out waiting for Fast DDS bus pub/sub payload")
			}
		case <-ctx.Done():
			t.Fatalf("context ended: %v", ctx.Err())
		}
	}

rpc:
	rpcChannel := core.Channel{
		Name: fmt.Sprintf("pacific_rim_go_fastdds_rpc_%d", time.Now().UnixNano()),
		Metadata: map[string]string{
			"rpc.standard": "omg_dds_rpc",
		},
	}
	if err := server.HandleRequest(ctx, rpcChannel, func(_ context.Context, payload []byte) ([]byte, error) {
		return append([]byte("reply:"), payload...), nil
	}); err != nil {
		t.Fatalf("handle request: %v", err)
	}
	response, err := client.Request(ctx, rpcChannel, []byte("hello"), 4*time.Second)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if string(response) != "reply:hello" {
		t.Fatalf("unexpected rpc response: %q", response)
	}
}
