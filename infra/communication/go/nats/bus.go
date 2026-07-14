package nats

import (
	"context"
	"fmt"
	"strconv"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

type ByteHandler func(context.Context, []byte) error

type ByteClient interface {
	Connect(context.Context) error
	Close(context.Context) error
	Publish(context.Context, string, []byte) error
	Subscribe(context.Context, string, string, ByteHandler) error
	Request(context.Context, string, []byte, time.Duration) ([]byte, error)
	HandleRequest(context.Context, string, string, core.RequestHandler) error
}

type ByteClientFactory func(NATSConfig) (ByteClient, error)

type Bus struct {
	config NATSConfig
	client ByteClient
}

func NewBus(config NATSConfig, client ByteClient) *Bus {
	return &Bus{config: config, client: client}
}

func NewBusFactory(factory ByteClientFactory) core.Factory {
	return func(config core.BusConfig) (core.MessageBus, error) {
		natsConfig, err := ConfigFromOptions(config.Options)
		if err != nil {
			return nil, err
		}
		if config.Name != "" {
			natsConfig.Name = config.Name
		}
		client, err := factory(natsConfig)
		if err != nil {
			return nil, err
		}
		return NewBus(natsConfig, client), nil
	}
}

func Register(factory ByteClientFactory) {
	core.Register(communication.TransportNATS, NewBusFactory(factory))
}

func (b *Bus) Kind() communication.TransportKind {
	return communication.TransportNATS
}

func (b *Bus) Capabilities() core.Capabilities {
	return core.Capabilities{PublishSubscribe: true, RequestReply: true}
}

func (b *Bus) Connect(ctx context.Context) error {
	return b.client.Connect(ctx)
}

func (b *Bus) Close(ctx context.Context) error {
	return b.client.Close(ctx)
}

func (b *Bus) Publish(ctx context.Context, channel core.Channel, payload []byte) error {
	return b.client.Publish(ctx, channel.Name, payload)
}

func (b *Bus) Subscribe(ctx context.Context, channel core.Channel, handler core.BytesHandler) error {
	return b.client.Subscribe(ctx, channel.Name, channel.QueueGroup, ByteHandler(handler))
}

func (b *Bus) Request(
	ctx context.Context,
	channel core.Channel,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	return b.client.Request(ctx, channel.Name, payload, timeout)
}

func (b *Bus) HandleRequest(ctx context.Context, channel core.Channel, handler core.RequestHandler) error {
	return b.client.HandleRequest(ctx, channel.Name, channel.QueueGroup, handler)
}

func ConfigFromOptions(options map[string]any) (NATSConfig, error) {
	config := NATSConfig{
		ServerURL:            "nats://127.0.0.1:4222",
		Name:                 "pacific-rim",
		ConnectTimeoutMS:     2000,
		ReconnectWaitMS:      2000,
		MaxReconnectAttempts: -1,
	}
	for key, value := range options {
		switch key {
		case "server_url", "server", "url":
			config.ServerURL = fmt.Sprint(value)
		case "name":
			config.Name = fmt.Sprint(value)
		case "connect_timeout_ms":
			config.ConnectTimeoutMS = toInt(value, config.ConnectTimeoutMS)
		case "reconnect_wait_ms":
			config.ReconnectWaitMS = toInt(value, config.ReconnectWaitMS)
		case "max_reconnect_attempts":
			config.MaxReconnectAttempts = toInt(value, config.MaxReconnectAttempts)
		}
	}
	return config, nil
}

func toInt(value any, fallback int) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		parsed, err := strconv.Atoi(typed)
		if err == nil {
			return parsed
		}
	}
	return fallback
}
