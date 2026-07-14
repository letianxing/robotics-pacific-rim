//go:build pacific_rim_cyclonedds

package dds

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestNativeByteClientPublishesAndSubscribes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	cfg := DefaultConfig()
	cfg.DomainID = 57
	cfg.ReadPeriodSec = 0.005

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

	topic := TopicConfig{
		TopicName: fmt.Sprintf("pacific_rim_native_go_test_%d", time.Now().UnixNano()),
		TypeName:  "PacificRimMessageEnvelope",
		QoS: map[string]string{
			"reliability": "reliable",
			"depth":       "4",
		},
	}

	received := make(chan []byte, 1)
	if err := subscriber.Subscribe(ctx, Subscription{Topic: topic}, func(_ context.Context, payload []byte) error {
		received <- append([]byte(nil), payload...)
		return nil
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	deadline := time.After(3 * time.Second)
	payload := []byte("native-dds-ok")
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
			t.Fatal("timed out waiting for native CycloneDDS payload")
		case <-ctx.Done():
			t.Fatalf("context ended: %v", ctx.Err())
		}
	}
}
