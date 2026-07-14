package core

import (
	"context"
	"fmt"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

type BoundEndpoint struct {
	BusName string
	Bus     MessageBus
	Channel Channel
}

type Fabric struct {
	buses        map[string]MessageBus
	busConfigs   map[string]BusConfig
	pubsubRoutes map[string]communication.PubSubRoute
	rpcRoutes    map[string]communication.RPCRoute
	security     *SecurityRuntime
}

func NewFabric(
	busConfigs map[string]BusConfig,
	pubsubRoutes []communication.PubSubRoute,
	rpcRoutes []communication.RPCRoute,
) (*Fabric, error) {
	return NewFabricWithSecurity(busConfigs, pubsubRoutes, rpcRoutes, nil)
}

func NewFabricWithSecurity(
	busConfigs map[string]BusConfig,
	pubsubRoutes []communication.PubSubRoute,
	rpcRoutes []communication.RPCRoute,
	security *SecurityRuntime,
) (*Fabric, error) {
	buses := make(map[string]MessageBus, len(busConfigs))
	for name, config := range busConfigs {
		bus, err := NewBus(config)
		if err != nil {
			return nil, err
		}
		buses[name] = bus
	}

	fabric := &Fabric{
		buses:        buses,
		busConfigs:   busConfigs,
		pubsubRoutes: map[string]communication.PubSubRoute{},
		rpcRoutes:    map[string]communication.RPCRoute{},
		security:     security,
	}
	for _, route := range pubsubRoutes {
		if route.Enabled {
			fabric.pubsubRoutes[route.Name] = route
		}
	}
	for _, route := range rpcRoutes {
		if route.Enabled {
			fabric.rpcRoutes[route.Name] = route
		}
	}
	return fabric, nil
}

func (f *Fabric) ConnectAll(ctx context.Context) error {
	for _, bus := range f.buses {
		if err := bus.Connect(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (f *Fabric) CloseAll(ctx context.Context) error {
	for _, bus := range f.buses {
		if err := bus.Close(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (f *Fabric) Bus(name string) (MessageBus, bool) {
	if f == nil {
		return nil, false
	}
	bus, ok := f.buses[name]
	return bus, ok
}

func (f *Fabric) FirstBusForTransport(kind communication.TransportKind) (string, MessageBus, bool) {
	if f == nil {
		return "", nil, false
	}
	for name, config := range f.busConfigs {
		if config.Transport == kind {
			bus, ok := f.buses[name]
			if ok {
				return name, bus, true
			}
		}
	}
	return "", nil, false
}

func (f *Fabric) Publisher(routeName string) (BoundEndpoint, error) {
	route, ok := f.pubsubRoutes[routeName]
	if !ok {
		return BoundEndpoint{}, fmt.Errorf("pubsub route %q is not configured", routeName)
	}
	return f.bindEndpoint(route.Publisher)
}

func (f *Fabric) Subscriber(routeName string) (BoundEndpoint, error) {
	route, ok := f.pubsubRoutes[routeName]
	if !ok {
		return BoundEndpoint{}, fmt.Errorf("pubsub route %q is not configured", routeName)
	}
	return f.bindEndpoint(route.Subscriber)
}

func (f *Fabric) RPCClient(routeName string) (BoundEndpoint, error) {
	route, ok := f.rpcRoutes[routeName]
	if !ok {
		return BoundEndpoint{}, fmt.Errorf("rpc route %q is not configured", routeName)
	}
	busName, bus, err := f.busForEndpoint(route.Client)
	if err != nil {
		return BoundEndpoint{}, err
	}
	bus, err = f.secureBusForEndpoint(busName, bus, route.Server)
	if err != nil {
		return BoundEndpoint{}, err
	}
	return BoundEndpoint{
		BusName: busName,
		Bus:     bus,
		Channel: ChannelFromEndpoint(route.Server),
	}, nil
}

func (f *Fabric) RPCServer(routeName string) (BoundEndpoint, error) {
	route, ok := f.rpcRoutes[routeName]
	if !ok {
		return BoundEndpoint{}, fmt.Errorf("rpc route %q is not configured", routeName)
	}
	return f.bindEndpoint(route.Server)
}

func (f *Fabric) bindEndpoint(endpoint communication.Endpoint) (BoundEndpoint, error) {
	busName, bus, err := f.busForEndpoint(endpoint)
	if err != nil {
		return BoundEndpoint{}, err
	}
	bus, err = f.secureBusForEndpoint(busName, bus, endpoint)
	if err != nil {
		return BoundEndpoint{}, err
	}
	return BoundEndpoint{
		BusName: busName,
		Bus:     bus,
		Channel: ChannelFromEndpoint(endpoint),
	}, nil
}

func (f *Fabric) secureBusForEndpoint(busName string, bus MessageBus, endpoint communication.Endpoint) (MessageBus, error) {
	if f == nil || f.security == nil {
		return bus, nil
	}
	config, ok := f.busConfigs[busName]
	if !ok {
		return bus, nil
	}
	binding, err := f.security.ResolveBinding(busName, config, endpoint)
	if err != nil {
		return nil, err
	}
	if binding == nil {
		return bus, nil
	}
	return NewSecureMessageBus(bus, *binding)
}

func (f *Fabric) busForEndpoint(endpoint communication.Endpoint) (string, MessageBus, error) {
	if endpoint.Metadata != nil {
		if name := firstEndpointMetadata(endpoint.Metadata, "middleware.runtime", "middleware_name", "middleware"); name != "" {
			bus, ok := f.buses[name]
			if !ok {
				return "", nil, fmt.Errorf("middleware %q is not configured", name)
			}
			return name, bus, nil
		}
	}

	for name, config := range f.busConfigs {
		if config.Transport == endpoint.Transport {
			return name, f.buses[name], nil
		}
	}
	return "", nil, fmt.Errorf("no middleware configured for transport %q", endpoint.Transport)
}

func firstEndpointMetadata(metadata map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := metadata[key]; value != "" {
			return value
		}
	}
	return ""
}

func CanonicalRouteName(value string) string {
	return routeName(value)
}
