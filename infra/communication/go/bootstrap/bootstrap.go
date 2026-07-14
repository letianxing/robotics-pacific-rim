package bootstrap

import (
	"context"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/defaults"
)

func BootstrapCommunication(
	ctx context.Context,
	configPath string,
	serviceName string,
) (*core.CommunicationRuntime, error) {
	defaults.RegisterDefaultBackends()
	return core.BootstrapCommunication(ctx, configPath, serviceName)
}

func NewFabric(
	busConfigs map[string]core.BusConfig,
	pubsubRoutes []communication.PubSubRoute,
	rpcRoutes []communication.RPCRoute,
) (*core.Fabric, error) {
	defaults.RegisterDefaultBackends()
	return core.NewFabric(busConfigs, pubsubRoutes, rpcRoutes)
}

type NATSBusOptions struct {
	ServerURL            string
	Name                 string
	ConnectTimeout       time.Duration
	ReconnectWait        time.Duration
	MaxReconnectAttempts int
}

func NewNATSBus(ctx context.Context, options NATSBusOptions) (core.MessageBus, error) {
	defaults.RegisterDefaultBackends()
	busOptions := map[string]any{
		"server_url": options.ServerURL,
	}
	if options.ConnectTimeout > 0 {
		busOptions["connect_timeout_ms"] = int(options.ConnectTimeout / time.Millisecond)
	}
	if options.ReconnectWait > 0 {
		busOptions["reconnect_wait_ms"] = int(options.ReconnectWait / time.Millisecond)
	}
	if options.MaxReconnectAttempts != 0 {
		busOptions["max_reconnect_attempts"] = options.MaxReconnectAttempts
	}

	bus, err := core.NewBus(core.BusConfig{
		Transport: communication.TransportNATS,
		Name:      options.Name,
		Options:   busOptions,
	})
	if err != nil {
		return nil, err
	}
	if err := bus.Connect(ctx); err != nil {
		return nil, err
	}
	return bus, nil
}
