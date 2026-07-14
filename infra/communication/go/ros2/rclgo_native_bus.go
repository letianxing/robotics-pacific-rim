//go:build pacific_rim_ros2_rclgo

package ros2

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
	"github.com/tiiuae/rclgo/pkg/rclgo"
	"github.com/tiiuae/rclgo/pkg/rclgo/typemap"
	"github.com/tiiuae/rclgo/pkg/rclgo/types"
)

type RclgoNativeBus struct {
	config core.BusConfig

	mu          sync.Mutex
	rclContext  *rclgo.Context
	node        *rclgo.Node
	publishers  map[string]*rclgo.Publisher
	clients     map[string]*rclgo.Client
	subscribers []*rclgoSubscription
	clientSpins []*rclgoClientSpin
	services    []*rclgoService
	typeSupport map[string]types.MessageTypeSupport
}

type rclgoSubscription struct {
	cancel context.CancelFunc
	done   chan error
}

type rclgoClientSpin struct {
	cancel context.CancelFunc
	done   chan error
}

type rclgoService struct {
	cancel context.CancelFunc
	done   chan error
}

func NewRclgoNativeBus(config core.BusConfig) (core.MessageBus, error) {
	return &RclgoNativeBus{
		config:      config,
		publishers:  map[string]*rclgo.Publisher{},
		clients:     map[string]*rclgo.Client{},
		typeSupport: map[string]types.MessageTypeSupport{},
	}, nil
}

func (b *RclgoNativeBus) Kind() communication.TransportKind {
	return communication.TransportROS2
}

func (b *RclgoNativeBus) Capabilities() core.Capabilities {
	return core.Capabilities{PublishSubscribe: true, RequestReply: true}
}

func (b *RclgoNativeBus) Connect(ctx context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.rclContext != nil {
		return nil
	}
	applyROS2EnvironmentOptions(b.config.Options)
	args, _, err := rclgo.ParseArgs(nil)
	if err != nil {
		return err
	}
	opts := rclgo.NewDefaultContextOptions()
	if domainID, ok := optionUintAny(b.config.Options, "domain_id", "ros_domain_id"); ok {
		opts.DomainID = domainID
	}
	rclContext, err := rclgo.NewContextWithOpts(args, opts)
	if err != nil {
		return err
	}
	nodeName := optionString(b.config.Options, "node_name", "participant_name", "name")
	if nodeName == "" {
		nodeName = b.config.Name
	}
	if nodeName == "" {
		nodeName = "pacific_rim_go_ros2"
	}
	namespace := optionString(b.config.Options, "namespace")
	node, err := rclContext.NewNode(sanitizeNodeName(nodeName), sanitizeNamespace(namespace))
	if err != nil {
		_ = rclContext.Close()
		return err
	}
	b.rclContext = rclContext
	b.node = node
	return nil
}

func (b *RclgoNativeBus) Close(ctx context.Context) error {
	b.mu.Lock()
	subscribers := append([]*rclgoSubscription(nil), b.subscribers...)
	for _, subscriber := range subscribers {
		subscriber.cancel()
	}
	clientSpins := append([]*rclgoClientSpin(nil), b.clientSpins...)
	for _, clientSpin := range clientSpins {
		clientSpin.cancel()
	}
	services := append([]*rclgoService(nil), b.services...)
	for _, service := range services {
		service.cancel()
	}
	rclContext := b.rclContext
	b.rclContext = nil
	b.node = nil
	b.publishers = map[string]*rclgo.Publisher{}
	b.clients = map[string]*rclgo.Client{}
	b.subscribers = nil
	b.clientSpins = nil
	b.services = nil
	b.typeSupport = map[string]types.MessageTypeSupport{}
	b.mu.Unlock()

	var err error
	for _, subscriber := range subscribers {
		select {
		case spinErr := <-subscriber.done:
			if !errors.Is(spinErr, context.Canceled) {
				err = errors.Join(err, spinErr)
			}
		case <-ctx.Done():
			err = errors.Join(err, ctx.Err())
		}
	}
	for _, clientSpin := range clientSpins {
		select {
		case spinErr := <-clientSpin.done:
			if !errors.Is(spinErr, context.Canceled) {
				err = errors.Join(err, spinErr)
			}
		case <-ctx.Done():
			err = errors.Join(err, ctx.Err())
		}
	}
	for _, service := range services {
		select {
		case spinErr := <-service.done:
			if !errors.Is(spinErr, context.Canceled) {
				err = errors.Join(err, spinErr)
			}
		case <-ctx.Done():
			err = errors.Join(err, ctx.Err())
		}
	}
	if rclContext != nil {
		err = errors.Join(err, rclContext.Close())
	}
	return err
}

func (b *RclgoNativeBus) Publish(ctx context.Context, channel core.Channel, payload []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if channelUsesProtoEnvelope(channel) {
		payload = encodeChannelProtoEnvelope(channel, payload)
	} else if channelUsesTypedMapper(channel) {
		mapped, err := encodeTypedMappedPayload(channel, payload)
		if err != nil {
			return err
		}
		payload = mapped
	}
	publisher, err := b.publisher(channel)
	if err != nil {
		return err
	}
	return publisher.PublishSerialized(payload)
}

func (b *RclgoNativeBus) Subscribe(ctx context.Context, channel core.Channel, handler core.BytesHandler) error {
	if handler == nil {
		return errors.New("ROS2 native subscription handler must not be nil")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.node == nil {
		return errors.New("ROS2 native backend is not connected")
	}
	typeSupport, err := b.messageTypeSupportLocked(channel)
	if err != nil {
		return err
	}
	subscription, err := b.node.NewSubscription(channel.Name, typeSupport, nil, func(subscription *rclgo.Subscription) {
		payload, _, err := subscription.TakeSerializedMessage()
		if err != nil {
			return
		}
		if channelUsesProtoEnvelope(channel) {
			envelope, err := decodeProtoEnvelopeCDR(payload)
			if err != nil {
				return
			}
			payload = envelope.Payload
		} else if channelUsesTypedMapper(channel) {
			mapped, err := decodeTypedMappedPayload(channel, payload)
			if err != nil {
				return
			}
			payload = mapped
		}
		_ = handler(ctx, payload)
	})
	if err != nil {
		return err
	}
	waitSet, err := b.rclContext.NewWaitSet()
	if err != nil {
		return err
	}
	waitSet.AddSubscriptions(subscription)
	subCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	b.subscribers = append(b.subscribers, &rclgoSubscription{cancel: cancel, done: done})
	go func() {
		err := waitSet.Run(subCtx)
		if errors.Is(err, context.Canceled) {
			err = nil
		}
		err = errors.Join(err, waitSet.Close())
		done <- err
	}()
	return err
}

func (b *RclgoNativeBus) Request(ctx context.Context, channel core.Channel, payload []byte, timeout time.Duration) ([]byte, error) {
	client, typeSupport, err := b.client(channel)
	if err != nil {
		return nil, err
	}
	if channelUsesProtoEnvelope(channel) {
		payload = encodeChannelProtoEnvelope(channel, payload)
	} else if channelUsesTypedMapper(channel) {
		mapped, err := encodeTypedMappedPayload(channel, payload)
		if err != nil {
			return nil, err
		}
		payload = mapped
	}
	request, err := deserializeTypedMessage(payload, typeSupport.Request())
	if err != nil {
		return nil, err
	}
	requestCtx := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		requestCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	response, _, err := client.Send(requestCtx, request)
	if err != nil {
		return nil, err
	}
	serialized, err := serializeTypedMessage(response)
	if err != nil {
		return nil, err
	}
	if channelUsesProtoEnvelope(channel) {
		envelope, err := decodeProtoEnvelopeCDR(serialized)
		if err != nil {
			return nil, err
		}
		return envelope.Payload, nil
	}
	if channelUsesTypedMapper(channel) {
		return decodeTypedMappedPayload(channel, serialized)
	}
	return serialized, nil
}

func (b *RclgoNativeBus) HandleRequest(ctx context.Context, channel core.Channel, handler core.RequestHandler) error {
	if handler == nil {
		return errors.New("ROS2 native service handler must not be nil")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.node == nil {
		return errors.New("ROS2 native backend is not connected")
	}
	typeSupport, err := b.serviceTypeSupport(channel)
	if err != nil {
		return err
	}
	service, err := b.node.NewService(channel.Name, typeSupport, nil, func(info *rclgo.ServiceInfo, request types.Message, sender rclgo.ServiceResponseSender) {
		_ = info
		requestBytes, err := serializeTypedMessage(request)
		if err != nil {
			return
		}
		if channelUsesProtoEnvelope(channel) {
			envelope, err := decodeProtoEnvelopeCDR(requestBytes)
			if err != nil {
				return
			}
			requestBytes = envelope.Payload
		} else if channelUsesTypedMapper(channel) {
			mapped, err := decodeTypedMappedPayload(channel, requestBytes)
			if err != nil {
				return
			}
			requestBytes = mapped
		}
		responseBytes, err := handler(ctx, requestBytes)
		if err != nil {
			return
		}
		if channelUsesProtoEnvelope(channel) {
			responseBytes = encodeChannelProtoEnvelope(channel, responseBytes)
		} else if channelUsesTypedMapper(channel) {
			mapped, err := encodeTypedMappedPayload(channel, responseBytes)
			if err != nil {
				return
			}
			responseBytes = mapped
		}
		response, err := deserializeTypedMessage(responseBytes, typeSupport.Response())
		if err != nil {
			return
		}
		_ = sender.SendResponse(response)
	})
	if err != nil {
		return err
	}
	waitSet, err := b.rclContext.NewWaitSet()
	if err != nil {
		return err
	}
	waitSet.AddServices(service)
	serviceCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	b.services = append(b.services, &rclgoService{cancel: cancel, done: done})
	go func() {
		err := waitSet.Run(serviceCtx)
		if errors.Is(err, context.Canceled) {
			err = nil
		}
		err = errors.Join(err, waitSet.Close())
		done <- err
	}()
	return nil
}

func (b *RclgoNativeBus) publisher(channel core.Channel) (*rclgo.Publisher, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.node == nil {
		return nil, errors.New("ROS2 native backend is not connected")
	}
	key := channel.Name + "\x00" + channel.MessageType
	if publisher := b.publishers[key]; publisher != nil {
		return publisher, nil
	}
	typeSupport, err := b.messageTypeSupportLocked(channel)
	if err != nil {
		return nil, err
	}
	publisher, err := b.node.NewPublisher(channel.Name, typeSupport, nil)
	if err != nil {
		return nil, err
	}
	b.publishers[key] = publisher
	return publisher, nil
}

func (b *RclgoNativeBus) client(channel core.Channel) (*rclgo.Client, types.ServiceTypeSupport, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.node == nil {
		return nil, nil, errors.New("ROS2 native backend is not connected")
	}
	typeSupport, err := b.serviceTypeSupport(channel)
	if err != nil {
		return nil, nil, err
	}
	key := channel.Name + "\x00" + graphServiceType(channel)
	if client := b.clients[key]; client != nil {
		return client, typeSupport, nil
	}
	client, err := b.node.NewClient(channel.Name, typeSupport, nil)
	if err != nil {
		return nil, nil, err
	}
	waitSet, err := b.rclContext.NewWaitSet()
	if err != nil {
		_ = client.Close()
		return nil, nil, err
	}
	waitSet.AddClients(client)
	clientCtx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	b.clientSpins = append(b.clientSpins, &rclgoClientSpin{cancel: cancel, done: done})
	go func() {
		err := waitSet.Run(clientCtx)
		if errors.Is(err, context.Canceled) {
			err = nil
		}
		err = errors.Join(err, waitSet.Close())
		done <- err
	}()
	b.clients[key] = client
	return client, typeSupport, nil
}

func (b *RclgoNativeBus) messageTypeSupportLocked(channel core.Channel) (types.MessageTypeSupport, error) {
	msgType := graphMessageType(channel)
	pkgName, ifaceName, err := splitROS2MessageType(msgType)
	if err != nil {
		return nil, err
	}
	key := pkgName + "/msg/" + ifaceName
	if typeSupport := b.typeSupport[key]; typeSupport != nil {
		return typeSupport, nil
	}
	typeSupport, err := rclgo.LoadDynamicMessageTypeSupport(pkgName, ifaceName)
	if err != nil {
		return nil, fmt.Errorf("load ROS2 message type support %s: %w", key, err)
	}
	b.typeSupport[key] = typeSupport
	return typeSupport, nil
}

func (b *RclgoNativeBus) serviceTypeSupport(channel core.Channel) (types.ServiceTypeSupport, error) {
	serviceType := graphServiceType(channel)
	pkgName, ifaceName, err := splitROS2ServiceType(serviceType)
	if err != nil {
		return nil, err
	}
	key := pkgName + "/srv/" + ifaceName
	typeSupport, ok := typemap.GetService(key)
	if ok {
		return typeSupport, nil
	}
	shortKey := pkgName + "/" + ifaceName
	if typeSupport, ok = typemap.GetService(shortKey); ok {
		return typeSupport, nil
	}
	return nil, fmt.Errorf("ROS2 native service type %s is not registered; run tools/generate-ros2-bindings.sh through the ROS-GO template build, or use mode: bridge", key)
}

func optionString(options map[string]any, keys ...string) string {
	if options == nil {
		return ""
	}
	for _, key := range keys {
		if value := strings.TrimSpace(fmt.Sprint(options[key])); value != "" && value != "<nil>" {
			return value
		}
	}
	return ""
}

func applyROS2EnvironmentOptions(options map[string]any) {
	if rmw := optionString(options, "rmw_implementation"); rmw != "" {
		_ = os.Setenv("RMW_IMPLEMENTATION", rmw)
	}
	if domainID, ok := optionUintAny(options, "domain_id", "ros_domain_id"); ok {
		_ = os.Setenv("ROS_DOMAIN_ID", strconv.FormatUint(uint64(domainID), 10))
	}
	if uri := optionString(options, "config_uri", "cyclonedds_uri"); uri != "" {
		_ = os.Setenv("CYCLONEDDS_URI", uri)
	}
}

func optionUintAny(options map[string]any, keys ...string) (uint, bool) {
	for _, key := range keys {
		if value, ok := optionUint(options, key); ok {
			return value, true
		}
	}
	return 0, false
}

func optionUint(options map[string]any, key string) (uint, bool) {
	if options == nil {
		return 0, false
	}
	value, ok := options[key]
	if !ok || value == nil {
		return 0, false
	}
	switch typed := value.(type) {
	case uint:
		return typed, true
	case int:
		return uint(typed), typed >= 0
	case int64:
		return uint(typed), typed >= 0
	case float64:
		return uint(typed), typed >= 0
	case string:
		parsed, err := strconv.ParseUint(strings.TrimSpace(typed), 10, 64)
		return uint(parsed), err == nil
	default:
		parsed, err := strconv.ParseUint(strings.TrimSpace(fmt.Sprint(value)), 10, 64)
		return uint(parsed), err == nil
	}
}

func sanitizeNodeName(value string) string {
	return sanitizeROSName(value, "pacific_rim_go_ros2")
}

func sanitizeNamespace(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "/" {
		return ""
	}
	parts := strings.Split(strings.Trim(value, "/"), "/")
	for index, part := range parts {
		parts[index] = sanitizeROSName(part, "ns")
	}
	return "/" + strings.Join(parts, "/")
}

func sanitizeROSName(value string, fallback string) string {
	var out strings.Builder
	for _, r := range strings.TrimSpace(value) {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' {
			out.WriteRune(r)
		} else {
			out.WriteByte('_')
		}
	}
	result := strings.Trim(out.String(), "_")
	if result == "" {
		return fallback
	}
	if result[0] >= '0' && result[0] <= '9' {
		return fallback + "_" + result
	}
	return result
}
