package core

import (
	"context"
	"fmt"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

type FanoutBus struct {
	buses        []MessageBus
	primaryIndex int
}

func NewFanoutBus(primaryIndex int, buses ...MessageBus) (*FanoutBus, error) {
	if len(buses) == 0 {
		return nil, fmt.Errorf("fanout bus requires at least one bus")
	}
	if primaryIndex < 0 || primaryIndex >= len(buses) {
		return nil, fmt.Errorf("fanout bus primary index %d is out of range", primaryIndex)
	}
	return &FanoutBus{buses: append([]MessageBus(nil), buses...), primaryIndex: primaryIndex}, nil
}

func (b *FanoutBus) Kind() communication.TransportKind {
	return communication.TransportInProcess
}

func (b *FanoutBus) Capabilities() Capabilities {
	capabilities := Capabilities{}
	for _, bus := range b.buses {
		busCapabilities := bus.Capabilities()
		capabilities.PublishSubscribe = capabilities.PublishSubscribe || busCapabilities.PublishSubscribe
	}
	capabilities.RequestReply = b.buses[b.primaryIndex].Capabilities().RequestReply
	return capabilities
}

func (b *FanoutBus) Connect(ctx context.Context) error {
	for _, bus := range b.buses {
		if err := bus.Connect(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (b *FanoutBus) Close(ctx context.Context) error {
	var firstErr error
	for _, bus := range b.buses {
		if err := bus.Close(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (b *FanoutBus) Publish(ctx context.Context, channel Channel, payload []byte) error {
	for _, bus := range b.buses {
		if err := bus.Publish(ctx, channel, payload); err != nil {
			return err
		}
	}
	return nil
}

func (b *FanoutBus) Subscribe(ctx context.Context, channel Channel, handler BytesHandler) error {
	for _, bus := range b.buses {
		if err := bus.Subscribe(ctx, channel, handler); err != nil {
			return err
		}
	}
	return nil
}

func (b *FanoutBus) Request(
	ctx context.Context,
	channel Channel,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	return b.buses[b.primaryIndex].Request(ctx, channel, payload, timeout)
}

func (b *FanoutBus) HandleRequest(ctx context.Context, channel Channel, handler RequestHandler) error {
	return b.buses[b.primaryIndex].HandleRequest(ctx, channel, handler)
}
