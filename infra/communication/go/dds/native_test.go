package dds

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"
)

type recordingManagedByteClient struct {
	mu              sync.Mutex
	subscriptions   map[string][]ByteHandler
	subscribeCounts map[string]int
	publishCounts   map[string]int
}

func newRecordingManagedByteClient() *recordingManagedByteClient {
	return &recordingManagedByteClient{
		subscriptions:   map[string][]ByteHandler{},
		subscribeCounts: map[string]int{},
		publishCounts:   map[string]int{},
	}
}

func (c *recordingManagedByteClient) Connect(context.Context, CycloneDDSConfig) error { return nil }
func (c *recordingManagedByteClient) Close(context.Context) error                     { return nil }
func (c *recordingManagedByteClient) PreparePublish(context.Context, TopicConfig) error {
	return nil
}

func (c *recordingManagedByteClient) Publish(ctx context.Context, topic TopicConfig, payload []byte) error {
	c.mu.Lock()
	c.publishCounts[topic.TopicName]++
	handlers := append([]ByteHandler(nil), c.subscriptions[topic.TopicName]...)
	if bytes.HasPrefix(payload, topicRPCProbePrefix) {
		ackTopic := topic.TopicName[:len(topic.TopicName)-len(".__pr_probe")] + ".reply.__pr_probe_ack"
		handlers = append(handlers, c.subscriptions[ackTopic]...)
		payload = topicRPCAckFrameForProbe(payload)
	} else if topic.TopicName == "planner.request" {
		handlers = append(handlers, c.subscriptions["planner.request.reply"]...)
		payload = append([]byte("reply:"), payload...)
	}
	c.mu.Unlock()
	for _, handler := range handlers {
		if err := handler(ctx, append([]byte(nil), payload...)); err != nil {
			return err
		}
	}
	return nil
}

func (c *recordingManagedByteClient) Subscribe(ctx context.Context, subscription Subscription, handler ByteHandler) error {
	_, err := c.SubscribeManaged(ctx, subscription, handler)
	return err
}

func (c *recordingManagedByteClient) SubscribeManaged(
	ctx context.Context,
	subscription Subscription,
	handler ByteHandler,
) (func(), error) {
	topicName := subscription.Topic.TopicName
	c.mu.Lock()
	c.subscribeCounts[topicName]++
	c.subscriptions[topicName] = append(c.subscriptions[topicName], handler)
	index := len(c.subscriptions[topicName]) - 1
	c.mu.Unlock()
	if topicName == "planner.request.__pr_ready" {
		go func() {
			select {
			case <-ctx.Done():
			case <-time.After(time.Millisecond):
				_ = handler(ctx, []byte("ready"))
			}
		}()
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			handlers := c.subscriptions[topicName]
			if index < len(handlers) {
				c.subscriptions[topicName] = append(handlers[:index], handlers[index+1:]...)
			}
		})
	}, nil
}

func (c *recordingManagedByteClient) SubscribeCount(topic string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.subscribeCounts[topic]
}

func (c *recordingManagedByteClient) PublishCount(topic string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.publishCounts[topic]
}

func TestTopicRPCAdapterReusesClientSessionSubscriptions(t *testing.T) {
	client := newRecordingManagedByteClient()
	adapter := &TopicRPCAdapter{}
	binding := RPCBinding{
		Standard: "omg_dds_rpc",
		RequestChannel: TopicConfig{
			TopicName: "planner.request",
			TypeName:  "PacificRimMessageEnvelope",
		},
		ResponseChannel: TopicConfig{
			TopicName: "planner.request.reply",
			TypeName:  "PacificRimMessageEnvelope",
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	for _, payload := range [][]byte{[]byte("first"), []byte("second")} {
		response, err := adapter.RequestWithClient(ctx, client, binding, payload, 200*time.Millisecond)
		if err != nil {
			t.Fatalf("RequestWithClient returned error: %v", err)
		}
		if !bytes.Equal(response, append([]byte("reply:"), payload...)) {
			t.Fatalf("unexpected response: %q", response)
		}
	}

	if got := client.SubscribeCount("planner.request.reply"); got != 1 {
		t.Fatalf("expected one persistent response subscription, got %d", got)
	}
	if got := client.SubscribeCount("planner.request.reply.__pr_probe_ack"); got != 1 {
		t.Fatalf("expected one persistent probe ack subscription, got %d", got)
	}
	if got := client.SubscribeCount("planner.request.__pr_ready"); got != 1 {
		t.Fatalf("expected ready check to run once, got %d", got)
	}
	if got := client.PublishCount("planner.request.__pr_probe"); got != 1 {
		t.Fatalf("expected pairing probe to run once, got %d", got)
	}
}
