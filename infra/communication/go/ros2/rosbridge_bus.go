package ros2

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
	"golang.org/x/net/websocket"
)

const defaultRosbridgeURL = "ws://127.0.0.1:9090"

type RosbridgeBus struct {
	config core.BusConfig
	url    string

	mu            sync.RWMutex
	writeMu       sync.Mutex
	conn          *websocket.Conn
	pending       map[string]chan rosbridgeMessage
	subscriptions map[string]rosbridgeSubscription
	services      map[string]rosbridgeServiceHandler
	advertised    map[string]string
	closed        chan struct{}
	counter       atomic.Uint64
}

type rosbridgeSubscription struct {
	channel core.Channel
	handler core.BytesHandler
}

type rosbridgeServiceHandler struct {
	channel core.Channel
	handler core.RequestHandler
}

type rosbridgeMessage struct {
	Op      string          `json:"op"`
	ID      string          `json:"id,omitempty"`
	Topic   string          `json:"topic,omitempty"`
	Type    string          `json:"type,omitempty"`
	Msg     json.RawMessage `json:"msg,omitempty"`
	Service string          `json:"service,omitempty"`
	Args    json.RawMessage `json:"args,omitempty"`
	Result  bool            `json:"result,omitempty"`
	Values  json.RawMessage `json:"values,omitempty"`
}

func NewRosbridgeBus(config core.BusConfig) (core.MessageBus, error) {
	return &RosbridgeBus{
		config:        config,
		url:           rosbridgeURL(config.Options),
		pending:       map[string]chan rosbridgeMessage{},
		subscriptions: map[string]rosbridgeSubscription{},
		services:      map[string]rosbridgeServiceHandler{},
		advertised:    map[string]string{},
		closed:        make(chan struct{}),
	}, nil
}

func (b *RosbridgeBus) Kind() communication.TransportKind {
	return communication.TransportROS2
}

func (b *RosbridgeBus) Capabilities() core.Capabilities {
	return core.Capabilities{PublishSubscribe: true, RequestReply: true}
}

func (b *RosbridgeBus) Connect(ctx context.Context) error {
	b.mu.Lock()
	if b.conn != nil {
		b.mu.Unlock()
		return nil
	}
	url := b.url
	b.mu.Unlock()

	type connectResult struct {
		conn *websocket.Conn
		err  error
	}
	result := make(chan connectResult, 1)
	go func() {
		conn, err := websocket.Dial(url, "", "http://localhost/")
		result <- connectResult{conn: conn, err: err}
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case got := <-result:
		if got.err != nil {
			return fmt.Errorf("connect rosbridge %s: %w", url, got.err)
		}
		b.mu.Lock()
		if b.closed == nil {
			b.closed = make(chan struct{})
		}
		b.conn = got.conn
		b.mu.Unlock()
		go b.readLoop()
		return nil
	}
}

func (b *RosbridgeBus) Close(ctx context.Context) error {
	b.mu.Lock()
	conn := b.conn
	b.conn = nil
	if b.closed != nil {
		close(b.closed)
		b.closed = nil
	}
	for id, ch := range b.pending {
		delete(b.pending, id)
		close(ch)
	}
	b.mu.Unlock()
	if conn == nil {
		return nil
	}
	done := make(chan error, 1)
	go func() { done <- conn.Close() }()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-done:
		return err
	}
}

func (b *RosbridgeBus) Publish(ctx context.Context, channel core.Channel, payload []byte) error {
	msgType, err := rosbridgeMessageType(channel)
	if err != nil {
		return err
	}
	if strings.TrimSpace(msgType) == "" {
		return errors.New("ROS2 rosbridge publish requires a ROS message type")
	}
	if err := b.advertise(ctx, channel.Name, msgType); err != nil {
		return err
	}
	body, err := rosbridgeOutboundMessage(channel, payload)
	if err != nil {
		return err
	}
	return b.send(ctx, rosbridgeMessage{
		Op:    "publish",
		Topic: channel.Name,
		Type:  msgType,
		Msg:   body,
	})
}

func (b *RosbridgeBus) Subscribe(ctx context.Context, channel core.Channel, handler core.BytesHandler) error {
	if handler == nil {
		return errors.New("ROS2 rosbridge subscription handler must not be nil")
	}
	msgType, err := rosbridgeMessageType(channel)
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.subscriptions[channel.Name] = rosbridgeSubscription{channel: channel, handler: handler}
	b.mu.Unlock()
	return b.send(ctx, rosbridgeMessage{
		Op:    "subscribe",
		ID:    b.nextID("sub"),
		Topic: channel.Name,
		Type:  msgType,
	})
}

func (b *RosbridgeBus) Request(ctx context.Context, channel core.Channel, payload []byte, timeout time.Duration) ([]byte, error) {
	args, err := rosbridgeOutboundServiceArgs(channel, payload)
	if err != nil {
		return nil, err
	}
	serviceType, err := rosbridgeServiceType(channel)
	if err != nil {
		return nil, err
	}
	requestCtx := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		requestCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	id := b.nextID("call")
	responseCh := make(chan rosbridgeMessage, 1)
	b.mu.Lock()
	b.pending[id] = responseCh
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
	}()
	if err := b.send(requestCtx, rosbridgeMessage{
		Op:      "call_service",
		ID:      id,
		Service: channel.Name,
		Type:    serviceType,
		Args:    args,
	}); err != nil {
		return nil, err
	}
	select {
	case <-requestCtx.Done():
		return nil, requestCtx.Err()
	case response, ok := <-responseCh:
		if !ok {
			return nil, errors.New("ROS2 rosbridge connection closed while waiting for service response")
		}
		if !response.Result {
			return nil, fmt.Errorf("ROS2 rosbridge service %s returned result=false", channel.Name)
		}
		return rosbridgeInboundServiceValues(channel, response.Values)
	}
}

func (b *RosbridgeBus) HandleRequest(ctx context.Context, channel core.Channel, handler core.RequestHandler) error {
	if handler == nil {
		return errors.New("ROS2 rosbridge service handler must not be nil")
	}
	serviceType, err := rosbridgeServiceType(channel)
	if err != nil {
		return err
	}
	if strings.TrimSpace(serviceType) == "" {
		return errors.New("ROS2 rosbridge service handler requires a ROS service type")
	}
	b.mu.Lock()
	b.services[channel.Name] = rosbridgeServiceHandler{channel: channel, handler: handler}
	b.mu.Unlock()
	return b.send(ctx, rosbridgeMessage{
		Op:      "advertise_service",
		Service: channel.Name,
		Type:    serviceType,
	})
}

func (b *RosbridgeBus) advertise(ctx context.Context, topic string, msgType string) error {
	b.mu.Lock()
	if b.advertised[topic] == msgType {
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()
	if err := b.send(ctx, rosbridgeMessage{Op: "advertise", Topic: topic, Type: msgType}); err != nil {
		return err
	}
	b.mu.Lock()
	b.advertised[topic] = msgType
	b.mu.Unlock()
	return nil
}

func (b *RosbridgeBus) send(ctx context.Context, msg rosbridgeMessage) error {
	b.mu.RLock()
	conn := b.conn
	b.mu.RUnlock()
	if conn == nil {
		return errors.New("ROS2 rosbridge backend is not connected")
	}
	done := make(chan error, 1)
	go func() {
		b.writeMu.Lock()
		defer b.writeMu.Unlock()
		done <- websocket.JSON.Send(conn, msg)
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-done:
		return err
	}
}

func (b *RosbridgeBus) readLoop() {
	for {
		var msg rosbridgeMessage
		b.mu.RLock()
		conn := b.conn
		closed := b.closed
		b.mu.RUnlock()
		if conn == nil {
			return
		}
		err := websocket.JSON.Receive(conn, &msg)
		if err != nil {
			b.mu.Lock()
			if b.conn == conn {
				b.conn = nil
			}
			for id, ch := range b.pending {
				delete(b.pending, id)
				close(ch)
			}
			b.mu.Unlock()
			return
		}
		select {
		case <-closed:
			return
		default:
		}
		b.handleMessage(msg)
	}
}

func (b *RosbridgeBus) handleMessage(msg rosbridgeMessage) {
	switch msg.Op {
	case "publish":
		b.mu.RLock()
		subscription := b.subscriptions[msg.Topic]
		b.mu.RUnlock()
		if subscription.handler == nil {
			return
		}
		payload, err := rosbridgeInboundMessage(subscription.channel, msg.Msg)
		if err != nil {
			return
		}
		_ = subscription.handler(context.Background(), payload)
	case "service_response":
		b.mu.RLock()
		ch := b.pending[msg.ID]
		b.mu.RUnlock()
		if ch != nil {
			ch <- msg
		}
	case "call_service":
		b.mu.RLock()
		service := b.services[msg.Service]
		b.mu.RUnlock()
		if service.handler == nil {
			_ = b.send(context.Background(), rosbridgeMessage{
				Op:      "service_response",
				ID:      msg.ID,
				Service: msg.Service,
				Result:  false,
			})
			return
		}
		payload, err := rosbridgeInboundServiceArgs(service.channel, msg.Args)
		if err != nil {
			_ = b.send(context.Background(), rosbridgeMessage{Op: "service_response", ID: msg.ID, Service: msg.Service, Result: false})
			return
		}
		response, err := service.handler(context.Background(), payload)
		if err != nil {
			_ = b.send(context.Background(), rosbridgeMessage{Op: "service_response", ID: msg.ID, Service: msg.Service, Result: false})
			return
		}
		values, err := rosbridgeOutboundServiceValues(service.channel, response)
		if err != nil {
			_ = b.send(context.Background(), rosbridgeMessage{Op: "service_response", ID: msg.ID, Service: msg.Service, Result: false})
			return
		}
		_ = b.send(context.Background(), rosbridgeMessage{
			Op:      "service_response",
			ID:      msg.ID,
			Service: msg.Service,
			Result:  true,
			Values:  values,
		})
	}
}

func (b *RosbridgeBus) nextID(prefix string) string {
	return fmt.Sprintf("pacific_rim_%s_%d", prefix, b.counter.Add(1))
}

func rosbridgeURL(options map[string]any) string {
	url := firstNonEmpty(
		bridgeOption(options, "url"),
		bridgeOption(options, "websocket_url"),
		configOptionString(options, "rosbridge_url"),
		configOptionString(options, "bridge_url"),
		configOptionString(options, "server_url"),
		os.Getenv("PACIFIC_RIM_ROS2_BRIDGE_URL"),
		os.Getenv("PACIFIC_RIM_ROSBRIDGE_URL"),
	)
	if url == "" {
		return defaultRosbridgeURL
	}
	return url
}

func rosbridgeMessageType(channel core.Channel) (string, error) {
	pkgName, ifaceName, err := splitROS2MessageType(graphMessageType(channel))
	if err != nil {
		return "", err
	}
	return pkgName + "/" + ifaceName, nil
}

func rosbridgeServiceType(channel core.Channel) (string, error) {
	pkgName, ifaceName, err := splitROS2ServiceType(graphServiceType(channel))
	if err != nil {
		return "", err
	}
	return pkgName + "/" + ifaceName, nil
}

func rosbridgeOutboundMessage(channel core.Channel, payload []byte) (json.RawMessage, error) {
	if channelUsesProtoEnvelope(channel) {
		return marshalRosbridgeProtoEnvelope(protoEnvelopeForChannel(channel, payload))
	}
	if channelUsesTypedMapper(channel) {
		return encodeRosbridgeTypedMappedPayload(channel, payload)
	}
	return rawJSONPayload(payload)
}

func rosbridgeInboundMessage(channel core.Channel, raw json.RawMessage) ([]byte, error) {
	if channelUsesProtoEnvelope(channel) {
		envelope, err := protoEnvelopeFromJSON(raw)
		if err != nil {
			return nil, err
		}
		return envelope.Payload, nil
	}
	if channelUsesTypedMapper(channel) {
		return decodeRosbridgeTypedMappedPayload(channel, raw)
	}
	return append([]byte(nil), raw...), nil
}

func rosbridgeOutboundServiceArgs(channel core.Channel, payload []byte) (json.RawMessage, error) {
	if channelUsesProtoEnvelope(channel) {
		return marshalRosbridgeProtoEnvelope(protoEnvelopeForChannel(channel, payload))
	}
	if channelUsesTypedMapper(channel) {
		return encodeRosbridgeTypedMappedPayload(channel, payload)
	}
	return rawJSONPayload(payload)
}

func rosbridgeOutboundServiceValues(channel core.Channel, payload []byte) (json.RawMessage, error) {
	if channelUsesProtoEnvelope(channel) {
		return marshalRosbridgeProtoEnvelope(protoEnvelopeForChannel(channel, payload))
	}
	if channelUsesTypedMapper(channel) {
		return encodeRosbridgeTypedMappedPayload(channel, payload)
	}
	return rawJSONPayload(payload)
}

func rosbridgeInboundServiceArgs(channel core.Channel, raw json.RawMessage) ([]byte, error) {
	if channelUsesProtoEnvelope(channel) {
		envelope, err := protoEnvelopeFromJSON(raw)
		if err != nil {
			return nil, err
		}
		return envelope.Payload, nil
	}
	if channelUsesTypedMapper(channel) {
		return decodeRosbridgeTypedMappedPayload(channel, raw)
	}
	return append([]byte(nil), raw...), nil
}

func rosbridgeInboundServiceValues(channel core.Channel, raw json.RawMessage) ([]byte, error) {
	if channelUsesProtoEnvelope(channel) {
		envelope, err := protoEnvelopeFromJSON(raw)
		if err != nil {
			return nil, err
		}
		return envelope.Payload, nil
	}
	if channelUsesTypedMapper(channel) {
		return decodeRosbridgeTypedMappedPayload(channel, raw)
	}
	return append([]byte(nil), raw...), nil
}

func rawJSONPayload(payload []byte) (json.RawMessage, error) {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return json.RawMessage("{}"), nil
	}
	if !json.Valid(payload) {
		return nil, errors.New("ROS2 rosbridge native ROSIDL payload must be JSON encoded")
	}
	return append(json.RawMessage(nil), payload...), nil
}

func protoEnvelopeForChannel(channel core.Channel, payload []byte) protoEnvelope {
	metadata := channel.Metadata
	if metadata == nil {
		metadata = map[string]string{}
	}
	return protoEnvelope{
		SchemaType:      firstNonEmptyString(channel.MessageType, metadata["schema.type"]),
		Codec:           firstNonEmptyString(metadata["codec"], "protobuf"),
		Route:           firstNonEmptyString(metadata["logical_route"], metadata["source_name"], channel.Name),
		TraceID:         metadata["trace_id"],
		Traceparent:     metadata["traceparent"],
		CreatedAtUnixMS: uint64(time.Now().UnixMilli()),
		Payload:         append([]byte(nil), payload...),
	}
}

func protoEnvelopeFromJSON(raw json.RawMessage) (protoEnvelope, error) {
	var value struct {
		SchemaType      string          `json:"schema_type"`
		Codec           string          `json:"codec"`
		Route           string          `json:"route"`
		TraceID         string          `json:"trace_id"`
		Traceparent     string          `json:"traceparent"`
		CreatedAtUnixMS uint64          `json:"created_at_unix_ms"`
		Payload         json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return protoEnvelope{}, err
	}
	payload, err := rosbridgeBytesFromJSON(value.Payload)
	if err != nil {
		return protoEnvelope{}, fmt.Errorf("decode rosbridge proto envelope payload: %w", err)
	}
	return protoEnvelope{
		SchemaType:      value.SchemaType,
		Codec:           value.Codec,
		Route:           value.Route,
		TraceID:         value.TraceID,
		Traceparent:     value.Traceparent,
		CreatedAtUnixMS: value.CreatedAtUnixMS,
		Payload:         payload,
	}, nil
}

func marshalRosbridgeProtoEnvelope(envelope protoEnvelope) (json.RawMessage, error) {
	type alias struct {
		SchemaType      string `json:"schema_type"`
		Codec           string `json:"codec"`
		Route           string `json:"route"`
		TraceID         string `json:"trace_id"`
		Traceparent     string `json:"traceparent"`
		CreatedAtUnixMS uint64 `json:"created_at_unix_ms"`
		Payload         []int  `json:"payload"`
	}
	return json.Marshal(alias{
		SchemaType:      envelope.SchemaType,
		Codec:           envelope.Codec,
		Route:           envelope.Route,
		TraceID:         envelope.TraceID,
		Traceparent:     envelope.Traceparent,
		CreatedAtUnixMS: envelope.CreatedAtUnixMS,
		Payload:         rosbridgeByteArray(envelope.Payload),
	})
}

func rosbridgeByteArray(payload []byte) []int {
	out := make([]int, len(payload))
	for i, value := range payload {
		out[i] = int(value)
	}
	return out
}

func rosbridgeBytesFromJSON(raw json.RawMessage) ([]byte, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err == nil {
		return base64.StdEncoding.DecodeString(encoded)
	}
	var ints []int
	if err := json.Unmarshal(raw, &ints); err == nil {
		out := make([]byte, len(ints))
		for i, value := range ints {
			if value < 0 || value > 255 {
				return nil, fmt.Errorf("byte value %d is outside uint8 range", value)
			}
			out[i] = byte(value)
		}
		return out, nil
	}
	var bytes []byte
	if err := json.Unmarshal(raw, &bytes); err == nil {
		return bytes, nil
	}
	return nil, errors.New("expected base64 string or uint8 array")
}
