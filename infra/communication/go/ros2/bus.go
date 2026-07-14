package ros2

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

type Bus struct {
	mode    string
	options map[string]any
	backend core.MessageBus
}

type NativeBackendFactory func(core.BusConfig) (core.MessageBus, error)

var (
	nativeBackendMu      sync.RWMutex
	nativeBackendFactory NativeBackendFactory
)

func Register() {
	RegisterCompiledNativeBackend()
	core.Register(communication.TransportROS2, NewBus)
}

func RegisterNativeBackend(factory NativeBackendFactory) {
	nativeBackendMu.Lock()
	defer nativeBackendMu.Unlock()
	nativeBackendFactory = factory
}

func NewBus(config core.BusConfig) (core.MessageBus, error) {
	mode := normalizeMode(config.Options["mode"])
	if mode == "" {
		mode = "auto"
	}
	if mode != "auto" && mode != "native" && mode != "bridge" {
		return nil, fmt.Errorf("unsupported ROS2 middleware mode %q", mode)
	}
	bus := &Bus{mode: mode, options: config.Options}
	factory := currentNativeBackendFactory()
	if mode == "native" || mode == "auto" {
		if factory != nil {
			backend, err := newNativeBackend(factory, config)
			if err != nil {
				return nil, err
			}
			bus.backend = backend
			bus.mode = "native"
			return bus, nil
		}
		if mode == "native" {
			return bus, nil
		}
	}
	if mode == "bridge" || bridgeFallbackEnabled(config.Options) {
		bridge, err := NewRosbridgeBus(config)
		if err != nil {
			return nil, err
		}
		bus.backend = bridge
		bus.mode = "bridge"
		return bus, nil
	}
	return bus, nil
}

func (b *Bus) Kind() communication.TransportKind {
	return communication.TransportROS2
}

func (b *Bus) Capabilities() core.Capabilities {
	if b.backend != nil {
		return b.backend.Capabilities()
	}
	return core.Capabilities{PublishSubscribe: true, RequestReply: true}
}

func (b *Bus) Connect(ctx context.Context) error {
	if b.backend != nil {
		return b.backend.Connect(ctx)
	}
	return errors.New("ROS2 native backend is not linked into this Go binary; build with -tags pacific_rim_ros2_rclgo or enable rosbridge fallback with PACIFIC_RIM_ROS2_BRIDGE=true")
}

func (b *Bus) Close(ctx context.Context) error {
	if b.backend != nil {
		return b.backend.Close(ctx)
	}
	return nil
}

func (b *Bus) Publish(ctx context.Context, channel core.Channel, payload []byte) error {
	if b.backend != nil {
		return b.backend.Publish(ctx, channel, payload)
	}
	return b.unavailable()
}

func (b *Bus) Subscribe(ctx context.Context, channel core.Channel, handler core.BytesHandler) error {
	if b.backend != nil {
		return b.backend.Subscribe(ctx, channel, handler)
	}
	return b.unavailable()
}

func (b *Bus) Request(ctx context.Context, channel core.Channel, payload []byte, timeout time.Duration) ([]byte, error) {
	if b.backend != nil {
		return b.backend.Request(ctx, channel, payload, timeout)
	}
	return nil, b.unavailable()
}

func (b *Bus) HandleRequest(ctx context.Context, channel core.Channel, handler core.RequestHandler) error {
	if b.backend != nil {
		return b.backend.HandleRequest(ctx, channel, handler)
	}
	return b.unavailable()
}

func (b *Bus) unavailable() error {
	if b.mode == "bridge" {
		return errors.New("ROS2 rosbridge fallback requires rosbridge_websocket at PACIFIC_RIM_ROS2_BRIDGE_URL or ws://127.0.0.1:9090")
	}
	return errors.New("ROS2 native backend is not linked into this Go binary; build with -tags pacific_rim_ros2_rclgo or enable rosbridge fallback with PACIFIC_RIM_ROS2_BRIDGE=true")
}

func normalizeMode(value any) string {
	if value == nil {
		return ""
	}
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(fmt.Sprint(value))), "-", "_")
}

func currentNativeBackendFactory() NativeBackendFactory {
	nativeBackendMu.RLock()
	defer nativeBackendMu.RUnlock()
	return nativeBackendFactory
}

func newNativeBackend(factory NativeBackendFactory, config core.BusConfig) (core.MessageBus, error) {
	backend, err := factory(config)
	if err != nil {
		return nil, err
	}
	if backend == nil {
		return nil, errors.New("ROS2 native backend factory returned nil")
	}
	return backend, nil
}

func bridgeFallbackEnabled(options map[string]any) bool {
	if configOptionBool(options, "bridge_enabled") ||
		configOptionBool(options, "enable_bridge") ||
		configOptionBool(options, "rosbridge_enabled") ||
		configOptionBool(options, "sidecar_bridge") {
		return true
	}
	if bridgeOption(options, "enabled") == "true" {
		return true
	}
	return envBool("PACIFIC_RIM_ROS2_BRIDGE") ||
		envBool("PACIFIC_RIM_GO_ROS2_BRIDGE") ||
		envBool("PACIFIC_RIM_ROSBRIDGE")
}

func bridgeOption(options map[string]any, key string) string {
	return configOptionString(options, "bridge."+key)
}

func configOptionString(options map[string]any, key string) string {
	if options == nil {
		return ""
	}
	value, ok := options[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func configOptionBool(options map[string]any, key string) bool {
	return boolString(configOptionString(options, key))
}

func envBool(name string) bool {
	return boolString(os.Getenv(name))
}

func boolString(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "y", "on", "enabled":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
