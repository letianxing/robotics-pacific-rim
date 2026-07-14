package core

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

type Channel struct {
	Name        string            `json:"name" yaml:"name"`
	QueueGroup  string            `json:"queue_group,omitempty" yaml:"queue_group,omitempty"`
	MessageType string            `json:"message_type,omitempty" yaml:"message_type,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty" yaml:"metadata,omitempty"`
}

type Capabilities struct {
	PublishSubscribe bool `json:"publish_subscribe" yaml:"publish_subscribe"`
	RequestReply     bool `json:"request_reply" yaml:"request_reply"`
}

type BusConfig = communication.MiddlewareConfig

type BytesHandler func(context.Context, []byte) error
type RequestHandler func(context.Context, []byte) ([]byte, error)

type MessageBus interface {
	Kind() communication.TransportKind
	Capabilities() Capabilities
	Connect(context.Context) error
	Close(context.Context) error
	Publish(context.Context, Channel, []byte) error
	Subscribe(context.Context, Channel, BytesHandler) error
	Request(context.Context, Channel, []byte, time.Duration) ([]byte, error)
	HandleRequest(context.Context, Channel, RequestHandler) error
}

type Factory func(BusConfig) (MessageBus, error)

var (
	registryMu sync.RWMutex
	registry   = map[communication.TransportKind]Factory{}
)

func Register(kind communication.TransportKind, factory Factory) {
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[kind] = factory
}

func IsRegistered(kind communication.TransportKind) bool {
	registryMu.RLock()
	defer registryMu.RUnlock()
	return registry[kind] != nil
}

func NewBus(config BusConfig) (MessageBus, error) {
	kind := config.Transport
	registryMu.RLock()
	factory := registry[kind]
	registryMu.RUnlock()
	if factory == nil {
		return nil, fmt.Errorf("communication middleware %q is not registered", kind)
	}
	return factory(config)
}

func NewBusByKind(kind communication.TransportKind, options map[string]any) (MessageBus, error) {
	return NewBus(BusConfig{Transport: kind, Options: options})
}

func NormalizeKind(value string) (communication.TransportKind, error) {
	normalized := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
	switch normalized {
	case "in_process":
		return communication.TransportInProcess, nil
	case "ros2":
		return communication.TransportROS2, nil
	case "fastdds", "fast_dds", "fastrtps", "fast_rtps", "fastdds_topic", "fastdds_rpc":
		return communication.TransportFastDDS, nil
	case "nats":
		return communication.TransportNATS, nil
	case "dds", "cyclone_dds", "cyclonedds":
		return communication.TransportCycloneDDS, nil
	case "zenoh":
		return communication.TransportZenoh, nil
	case "grpc":
		return communication.TransportGRPC, nil
	case "mqtt":
		return communication.TransportMQTT, nil
	default:
		return "", fmt.Errorf("unsupported communication middleware %q", value)
	}
}

func ChannelFromEndpoint(endpoint communication.Endpoint) Channel {
	queueGroup := ""
	if endpoint.Metadata != nil {
		queueGroup = endpoint.Metadata["queue_group"]
	}
	return Channel{
		Name:        endpoint.Address,
		QueueGroup:  queueGroup,
		MessageType: endpoint.MessageType,
		Metadata:    endpoint.Metadata,
	}
}

func RequestChannelFromRoute(route communication.RPCRoute) Channel {
	return ChannelFromEndpoint(route.Server)
}
