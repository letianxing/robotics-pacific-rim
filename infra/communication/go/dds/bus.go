package dds

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

type ByteHandler func(context.Context, []byte) error

type ByteClient interface {
	Connect(context.Context, CycloneDDSConfig) error
	Close(context.Context) error
	PreparePublish(context.Context, TopicConfig) error
	Publish(context.Context, TopicConfig, []byte) error
	Subscribe(context.Context, Subscription, ByteHandler) error
}

type ByteClientFactory func(CycloneDDSConfig) (ByteClient, error)

type Bus struct {
	config         CycloneDDSConfig
	typeName       string
	qos            map[string]string
	client         ByteClient
	adapters       map[string]RPCAdapter
	kind           communication.TransportKind
	publishReadyMu sync.Mutex
	publishReady   map[string]bool
}

func NewBus(config CycloneDDSConfig, typeName string, qos map[string]string, client ByteClient) *Bus {
	return NewBusWithRPCAdapters(config, typeName, qos, client, nil)
}

func NewBusWithRPCAdapters(
	config CycloneDDSConfig,
	typeName string,
	qos map[string]string,
	client ByteClient,
	adapters map[string]RPCAdapter,
) *Bus {
	return NewBusWithKindAndRPCAdapters(communication.TransportCycloneDDS, config, typeName, qos, client, adapters)
}

func NewBusWithKindAndRPCAdapters(
	kind communication.TransportKind,
	config CycloneDDSConfig,
	typeName string,
	qos map[string]string,
	client ByteClient,
	adapters map[string]RPCAdapter,
) *Bus {
	return &Bus{
		config:       config,
		typeName:     typeName,
		qos:          qos,
		client:       client,
		adapters:     normalizeAdapters(adapters),
		kind:         kind,
		publishReady: map[string]bool{},
	}
}

func NewBusFactory(factory ByteClientFactory) core.Factory {
	return NewBusFactoryWithRPCAdapters(factory, nil)
}

func NewBusFactoryWithRPCAdapters(factory ByteClientFactory, adapters map[string]RPCAdapter) core.Factory {
	return NewBusFactoryWithKindAndRPCAdapters(communication.TransportCycloneDDS, factory, adapters)
}

func NewBusFactoryWithKindAndRPCAdapters(
	kind communication.TransportKind,
	factory ByteClientFactory,
	adapters map[string]RPCAdapter,
) core.Factory {
	return func(config core.BusConfig) (core.MessageBus, error) {
		ddsConfig, typeName, qos, err := ConfigFromOptions(config.Options)
		if err != nil {
			return nil, err
		}
		if config.Name != "" {
			ddsConfig.ParticipantName = config.Name
		}
		client, err := factory(ddsConfig)
		if err != nil {
			return nil, err
		}
		return NewBusWithKindAndRPCAdapters(kind, ddsConfig, typeName, qos, client, adapters), nil
	}
}

func Register(factory ByteClientFactory) {
	core.Register(communication.TransportCycloneDDS, NewBusFactory(factory))
}

func RegisterWithRPCAdapters(factory ByteClientFactory, adapters map[string]RPCAdapter) {
	core.Register(communication.TransportCycloneDDS, NewBusFactoryWithRPCAdapters(factory, adapters))
}

func RegisterWithKindAndRPCAdapters(kind communication.TransportKind, factory ByteClientFactory, adapters map[string]RPCAdapter) {
	core.Register(kind, NewBusFactoryWithKindAndRPCAdapters(kind, factory, adapters))
}

func (b *Bus) Kind() communication.TransportKind {
	if b.kind == "" {
		return communication.TransportCycloneDDS
	}
	return b.kind
}

func (b *Bus) Capabilities() core.Capabilities {
	return core.Capabilities{PublishSubscribe: true, RequestReply: true}
}

func (b *Bus) Connect(ctx context.Context) error {
	return b.client.Connect(ctx, b.config)
}

func (b *Bus) Close(ctx context.Context) error {
	for _, adapter := range b.adapters {
		if closer, ok := adapter.(interface {
			CloseClient(ByteClient)
		}); ok {
			closer.CloseClient(b.client)
		}
	}
	return b.client.Close(ctx)
}

func (b *Bus) Publish(ctx context.Context, channel core.Channel, payload []byte) error {
	topic := b.topic(channel)
	if err := b.ensurePublishReady(ctx, topic); err != nil {
		return err
	}
	return b.client.Publish(ctx, topic, payload)
}

func (b *Bus) Subscribe(ctx context.Context, channel core.Channel, handler core.BytesHandler) error {
	return b.client.Subscribe(ctx, Subscription{Topic: b.topic(channel)}, ByteHandler(handler))
}

func (b *Bus) Request(
	ctx context.Context,
	channel core.Channel,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	binding := b.rpcBinding(channel)
	adapter := b.adapters[binding.Standard]
	if adapter == nil {
		return nil, fmt.Errorf(
			"cyclonedds request/reply requires infra DDS RPC adapter for %s",
			binding.Standard,
		)
	}
	if clientAdapter, ok := adapter.(ClientRPCAdapter); ok {
		return clientAdapter.RequestWithClient(ctx, b.client, binding, payload, timeout)
	}
	return adapter.Request(ctx, binding, payload, timeout)
}

func (b *Bus) HandleRequest(ctx context.Context, channel core.Channel, handler core.RequestHandler) error {
	binding := b.rpcBinding(channel)
	adapter := b.adapters[binding.Standard]
	if adapter == nil {
		return fmt.Errorf(
			"cyclonedds request/reply requires infra DDS RPC adapter for %s",
			binding.Standard,
		)
	}
	if clientAdapter, ok := adapter.(ClientRPCAdapter); ok {
		return clientAdapter.HandleRequestWithClient(ctx, b.client, binding, handler)
	}
	return adapter.HandleRequest(ctx, binding, handler)
}

func (b *Bus) topic(channel core.Channel) TopicConfig {
	typeName := b.typeName
	if typed := typedDDSType(channel); typed != "" {
		if supporter, ok := b.client.(interface {
			SupportsTypedDDS(string) bool
		}); ok && supporter.SupportsTypedDDS(typed) {
			typeName = typed
		}
	}
	return TopicConfig{
		TopicName: channel.Name,
		TypeName:  typeName,
		QoS:       mergeQoS(b.qos, channel.Metadata),
	}
}

func (b *Bus) ensurePublishReady(ctx context.Context, topic TopicConfig) error {
	if b.kind != communication.TransportFastDDS {
		return nil
	}
	key := topicRPCTopicKey(topic)
	b.publishReadyMu.Lock()
	if b.publishReady[key] {
		b.publishReadyMu.Unlock()
		return nil
	}
	b.publishReadyMu.Unlock()

	if err := b.client.PreparePublish(ctx, topic); err != nil {
		return err
	}
	timeout := fastDDSPublishMatchTimeout()
	matched := true
	if timeout > 0 {
		waitCtx, cancel := context.WithTimeout(ctx, timeout)
		err := waitForSubscribers(waitCtx, b.client, topic)
		cancel()
		matched = err == nil
	}
	if matched {
		b.publishReadyMu.Lock()
		b.publishReady[key] = true
		b.publishReadyMu.Unlock()
	}
	return nil
}

func fastDDSPublishMatchTimeout() time.Duration {
	for _, key := range []string{"PR_FASTDDS_MATCH_TIMEOUT_SEC", "PR_MATRIX_DISCOVERY_WAIT_SEC"} {
		value := os.Getenv(key)
		if value == "" {
			continue
		}
		seconds, err := strconv.ParseFloat(value, 64)
		if err != nil {
			continue
		}
		if seconds <= 0 {
			return 0
		}
		return time.Duration(seconds * float64(time.Second))
	}
	return 500 * time.Millisecond
}

func (b *Bus) rpcBinding(channel core.Channel) RPCBinding {
	standard := normalizeStandard(channel.Metadata["rpc.standard"])
	requestName := channel.Metadata["rpc.request_channel"]
	if requestName == "" {
		requestName = channel.Name
	}
	responseName := channel.Metadata["rpc.response_channel"]
	if responseName == "" {
		responseName = requestName + ".reply"
	}
	qos := mergeQoS(b.qos, channel.Metadata)
	typeName := b.topic(channel).TypeName
	return RPCBinding{
		Standard: standard,
		RequestChannel: TopicConfig{
			TopicName: requestName,
			TypeName:  typeName,
			QoS:       qos,
		},
		ResponseChannel: TopicConfig{
			TopicName: responseName,
			TypeName:  typeName,
			QoS:       qos,
		},
	}
}

func typedDDSType(channel core.Channel) string {
	mode := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(channel.Metadata["dds.mode"])), "-", "_")
	if mode != "typed" && mode != "typed_preferred" && strings.TrimSpace(channel.Metadata["schema.language"]) != "omg_idl" {
		return ""
	}
	if typ := strings.TrimSpace(channel.Metadata["dds.type"]); typ != "" {
		return typ
	}
	return strings.TrimSpace(channel.Metadata["schema.type"])
}

func normalizeAdapters(adapters map[string]RPCAdapter) map[string]RPCAdapter {
	out := map[string]RPCAdapter{}
	for key, adapter := range adapters {
		if adapter != nil {
			out[normalizeStandard(key)] = adapter
		}
	}
	return out
}

func normalizeStandard(value string) string {
	normalized := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
	switch normalized {
	case "", "omg", "dds_rpc", "omg_dds_rpc":
		return "omg_dds_rpc"
	case "rmw", "rmw_cyclonedds", "rmw_cyclonedds_cpp", "ros2_rmw":
		return "rmw_cyclonedds"
	default:
		return normalized
	}
}

func ConfigFromOptions(options map[string]any) (CycloneDDSConfig, string, map[string]string, error) {
	config := DefaultConfig()
	config.DomainID = nativeDDSDomainID(options)
	typeName := "PacificRimMessageEnvelope"
	qos := map[string]string{}
	for key, value := range options {
		switch key {
		case "domain_id", "ros_domain_id", "native_domain_id", "native_domain_offset":
		case "participant_name", "name":
			config.ParticipantName = fmt.Sprint(value)
		case "config_uri":
			config.ConfigURI = fmt.Sprint(value)
		case "read_period_sec":
			config.ReadPeriodSec = toFloat(value, config.ReadPeriodSec)
		case "type_name":
			typeName = fmt.Sprint(value)
		case "qos":
			qos["profile"] = fmt.Sprint(value)
		default:
			if len(key) > 4 && key[:4] == "qos." {
				qos[key[4:]] = fmt.Sprint(value)
			}
		}
	}
	return config, typeName, qos, nil
}

func nativeDDSDomainID(options map[string]any) int {
	for _, key := range []string{"native_domain_id", "domain_id"} {
		if value, ok := options[key]; ok {
			return toInt(value, 0)
		}
	}
	if value := strings.TrimSpace(os.Getenv("PACIFIC_RIM_NATIVE_DDS_DOMAIN_ID")); value != "" {
		return toInt(value, 0)
	}
	base := 0
	if value, ok := options["ros_domain_id"]; ok {
		base = toInt(value, 0)
	} else if envDomainID := strings.TrimSpace(os.Getenv("ROS_DOMAIN_ID")); envDomainID != "" {
		base = toInt(envDomainID, 0)
	}
	return base + nativeDDSDomainOffset(options)
}

func nativeDDSDomainOffset(options map[string]any) int {
	if value, ok := options["native_domain_offset"]; ok {
		return toInt(value, 100)
	}
	if value := strings.TrimSpace(os.Getenv("PACIFIC_RIM_NATIVE_DDS_DOMAIN_OFFSET")); value != "" {
		return toInt(value, 100)
	}
	return 100
}

func mergeQoS(base map[string]string, metadata map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range base {
		out[key] = value
	}
	for key, value := range metadata {
		if key == "qos" {
			out["profile"] = value
		} else if len(key) > 4 && key[:4] == "qos." {
			out[key[4:]] = value
		}
	}
	return out
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

func toFloat(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case string:
		parsed, err := strconv.ParseFloat(typed, 64)
		if err == nil {
			return parsed
		}
	}
	return fallback
}
