package dds

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RegisterNativeBus wires the default Go CycloneDDS backend into the shared
// communication registry. The byte client is supplied by the selected build:
// the default build returns a clear dependency error, while the
// pacific_rim_cyclonedds build tag links the native libddsc client.
func RegisterNativeBus() {
	topicRPC := &TopicRPCAdapter{}
	RegisterWithRPCAdapters(
		func(config CycloneDDSConfig) (ByteClient, error) {
			return NewNativeByteClient(config)
		},
		map[string]RPCAdapter{
			"omg_dds_rpc":    topicRPC,
			"rmw_cyclonedds": topicRPC,
		},
	)
}

type TopicRPCAdapter struct {
	readyPeriod time.Duration
	readyWait   time.Duration
	mu          sync.Mutex
	sessions    map[string]*topicRPCClientSession
}

const (
	topicRPCReadyPeriod = 5 * time.Millisecond
	topicRPCReadyWait   = 1500 * time.Millisecond
	topicRPCProbeWait   = 1500 * time.Millisecond
)

var (
	topicRPCProbePrefix = []byte("\x00PRPC_READY_V1\x00probe:")
	topicRPCAckPrefix   = []byte("\x00PRPC_READY_V1\x00ack:")
)

func (a *TopicRPCAdapter) Request(
	ctx context.Context,
	binding RPCBinding,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	return nil, fmt.Errorf("cyclonedds topic rpc adapter requires a connected byte client")
}

func (a *TopicRPCAdapter) RequestWithClient(
	ctx context.Context,
	client ByteClient,
	binding RPCBinding,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	if client == nil {
		return nil, fmt.Errorf("cyclonedds rpc adapter has no connected byte client")
	}
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	if _, ok := client.(managedByteSubscriber); ok {
		return a.requestWithSession(ctx, client, binding, payload, timeout)
	}
	return a.requestWithEphemeral(ctx, client, binding, payload, timeout)
}

func (a *TopicRPCAdapter) requestWithEphemeral(
	ctx context.Context,
	client ByteClient,
	binding RPCBinding,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	responseCh := make(chan []byte, 1)
	handshakeCh := make(chan struct{}, 1)
	probeFrame := newTopicRPCProbeFrame()
	ackFrame := topicRPCAckFrameForProbe(probeFrame)
	unsubscribeResponse, err := subscribeManaged(reqCtx, client, Subscription{Topic: binding.ResponseChannel}, func(_ context.Context, data []byte) error {
		select {
		case responseCh <- append([]byte(nil), data...):
		default:
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	defer unsubscribeResponse()
	unsubscribeAck, err := subscribeManaged(reqCtx, client, Subscription{Topic: rpcProbeAckChannel(binding)}, func(_ context.Context, data []byte) error {
		if !bytes.Equal(data, ackFrame) {
			return nil
		}
		select {
		case handshakeCh <- struct{}{}:
		default:
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	defer unsubscribeAck()
	if err := client.PreparePublish(reqCtx, binding.RequestChannel); err != nil {
		return nil, err
	}
	if err := client.PreparePublish(reqCtx, rpcProbeChannel(binding)); err != nil {
		return nil, err
	}
	if ready, err := a.waitForReady(reqCtx, client, binding); err != nil {
		return nil, err
	} else if ready {
		if err := a.probePairing(reqCtx, client, binding, probeFrame, handshakeCh); err != nil {
			return nil, err
		}
	}
	if err := client.Publish(reqCtx, binding.RequestChannel, payload); err != nil {
		return nil, err
	}

	select {
	case response := <-responseCh:
		return response, nil
	case <-reqCtx.Done():
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("cyclonedds rpc request timed out on %s", binding.RequestChannel.TopicName)
	}
}

func (a *TopicRPCAdapter) requestWithSession(
	ctx context.Context,
	client ByteClient,
	binding RPCBinding,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	session, err := a.sessionFor(ctx, client, binding)
	if err != nil {
		return nil, err
	}
	session.requestMu.Lock()
	defer session.requestMu.Unlock()

	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := session.ensureReady(reqCtx, a, client, binding); err != nil {
		return nil, err
	}
	drainBytes(session.responseCh)
	if err := client.Publish(reqCtx, binding.RequestChannel, payload); err != nil {
		return nil, err
	}
	select {
	case response := <-session.responseCh:
		return response, nil
	case <-reqCtx.Done():
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("cyclonedds rpc request timed out on %s", binding.RequestChannel.TopicName)
	}
}

func (a *TopicRPCAdapter) sessionFor(
	ctx context.Context,
	client ByteClient,
	binding RPCBinding,
) (*topicRPCClientSession, error) {
	key := topicRPCSessionKey(client, binding)
	a.mu.Lock()
	if a.sessions != nil {
		if session := a.sessions[key]; session != nil {
			a.mu.Unlock()
			return session, nil
		}
	}
	a.mu.Unlock()

	manager, ok := client.(managedByteSubscriber)
	if !ok {
		return nil, fmt.Errorf("cyclonedds rpc adapter requires managed byte subscriptions")
	}
	sessionCtx, cancel := context.WithCancel(context.Background())
	session := &topicRPCClientSession{
		clientID:    topicRPCClientID(client),
		cancel:      cancel,
		responseCh:  make(chan []byte, 8),
		handshakeCh: make(chan []byte, 8),
	}
	unsubscribeResponse, err := manager.SubscribeManaged(
		sessionCtx,
		Subscription{Topic: binding.ResponseChannel},
		func(_ context.Context, data []byte) error {
			select {
			case session.responseCh <- append([]byte(nil), data...):
			default:
			}
			return nil
		},
	)
	if err != nil {
		cancel()
		return nil, err
	}
	session.unsubscribeResponse = unsubscribeResponse
	unsubscribeAck, err := manager.SubscribeManaged(
		sessionCtx,
		Subscription{Topic: rpcProbeAckChannel(binding)},
		func(_ context.Context, data []byte) error {
			select {
			case session.handshakeCh <- append([]byte(nil), data...):
			default:
			}
			return nil
		},
	)
	if err != nil {
		unsubscribeResponse()
		cancel()
		return nil, err
	}
	session.unsubscribeAck = unsubscribeAck
	if err := client.PreparePublish(ctx, binding.RequestChannel); err != nil {
		session.close()
		return nil, err
	}
	if err := client.PreparePublish(ctx, rpcProbeChannel(binding)); err != nil {
		session.close()
		return nil, err
	}

	a.mu.Lock()
	if a.sessions == nil {
		a.sessions = map[string]*topicRPCClientSession{}
	}
	if existing := a.sessions[key]; existing != nil {
		a.mu.Unlock()
		session.close()
		return existing, nil
	}
	a.sessions[key] = session
	a.mu.Unlock()
	return session, nil
}

func (a *TopicRPCAdapter) CloseClient(client ByteClient) {
	clientID := topicRPCClientID(client)
	prefix := clientID + "\x00"
	var sessions []*topicRPCClientSession
	a.mu.Lock()
	for key, session := range a.sessions {
		if session != nil && strings.HasPrefix(key, prefix) {
			delete(a.sessions, key)
			sessions = append(sessions, session)
		}
	}
	a.mu.Unlock()
	for _, session := range sessions {
		session.close()
	}
}

func (a *TopicRPCAdapter) HandleRequest(
	ctx context.Context,
	binding RPCBinding,
	handler func(context.Context, []byte) ([]byte, error),
) error {
	return fmt.Errorf("cyclonedds topic rpc adapter requires a connected byte client")
}

func (a TopicRPCAdapter) HandleRequestWithClient(
	ctx context.Context,
	client ByteClient,
	binding RPCBinding,
	handler func(context.Context, []byte) ([]byte, error),
) error {
	if client == nil {
		return fmt.Errorf("cyclonedds rpc adapter has no connected byte client")
	}
	if err := client.PreparePublish(ctx, binding.ResponseChannel); err != nil {
		return err
	}
	if err := client.PreparePublish(ctx, rpcProbeAckChannel(binding)); err != nil {
		return err
	}
	if err := client.Subscribe(ctx, Subscription{Topic: binding.RequestChannel}, func(reqCtx context.Context, data []byte) error {
		response, err := handler(reqCtx, data)
		if err != nil {
			return err
		}
		return client.Publish(reqCtx, binding.ResponseChannel, response)
	}); err != nil {
		return err
	}
	if err := client.Subscribe(ctx, Subscription{Topic: rpcProbeChannel(binding)}, func(reqCtx context.Context, data []byte) error {
		if !bytes.HasPrefix(data, topicRPCProbePrefix) {
			return nil
		}
		return client.Publish(reqCtx, rpcProbeAckChannel(binding), topicRPCAckFrameForProbe(data))
	}); err != nil {
		return err
	}
	return a.publishReady(ctx, client, binding)
}

func (a TopicRPCAdapter) waitForReady(ctx context.Context, client ByteClient, binding RPCBinding) (bool, error) {
	readyWait := a.readyWait
	if readyWait <= 0 {
		readyWait = topicRPCReadyWait
	}
	readyCtx, cancel := context.WithTimeout(ctx, readyWait)
	defer cancel()
	readyCh := make(chan struct{}, 1)
	unsubscribe, err := subscribeManaged(readyCtx, client, Subscription{Topic: rpcReadyChannel(binding)}, func(context.Context, []byte) error {
		select {
		case readyCh <- struct{}{}:
		default:
		}
		return nil
	})
	if err != nil {
		return false, err
	}
	defer unsubscribe()
	select {
	case <-readyCh:
		return true, nil
	case <-readyCtx.Done():
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return false, nil
	}
}

func (a TopicRPCAdapter) probePairing(
	ctx context.Context,
	client ByteClient,
	binding RPCBinding,
	probeFrame []byte,
	handshakeCh <-chan struct{},
) error {
	probeWait := topicRPCProbeWait
	if a.readyWait > 0 {
		probeWait = a.readyWait
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeWait)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := client.Publish(probeCtx, rpcProbeChannel(binding), probeFrame); err != nil {
			return err
		}
		select {
		case <-handshakeCh:
			return nil
		case <-probeCtx.Done():
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("cyclonedds rpc endpoint pairing timed out on %s", binding.RequestChannel.TopicName)
		case <-ticker.C:
		}
	}
}

func (a TopicRPCAdapter) publishReady(ctx context.Context, client ByteClient, binding RPCBinding) error {
	readyTopic := rpcReadyChannel(binding)
	if err := client.PreparePublish(ctx, readyTopic); err != nil {
		return err
	}
	readyPeriod := a.readyPeriod
	if readyPeriod <= 0 {
		readyPeriod = topicRPCReadyPeriod
	}
	go func() {
		ticker := time.NewTicker(readyPeriod)
		defer ticker.Stop()
		payload := []byte("ready")
		for {
			if err := client.Publish(ctx, readyTopic, payload); err != nil && ctx.Err() != nil {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return nil
}

func rpcReadyChannel(binding RPCBinding) TopicConfig {
	topic := binding.RequestChannel
	topic.TopicName += ".__pr_ready"
	return topic
}

func rpcProbeChannel(binding RPCBinding) TopicConfig {
	topic := binding.RequestChannel
	topic.TopicName += ".__pr_probe"
	return topic
}

func rpcProbeAckChannel(binding RPCBinding) TopicConfig {
	topic := binding.ResponseChannel
	topic.TopicName += ".__pr_probe_ack"
	return topic
}

func newTopicRPCProbeFrame() []byte {
	nonce := strconv.FormatInt(time.Now().UnixNano(), 10)
	frame := append([]byte(nil), topicRPCProbePrefix...)
	frame = append(frame, nonce...)
	return frame
}

func topicRPCAckFrameForProbe(probe []byte) []byte {
	frame := append([]byte(nil), topicRPCAckPrefix...)
	if len(probe) > len(topicRPCProbePrefix) {
		frame = append(frame, probe[len(topicRPCProbePrefix):]...)
	}
	return frame
}

func waitForSubscribers(ctx context.Context, client ByteClient, topic TopicConfig) error {
	waiter, ok := client.(interface {
		WaitForSubscribers(context.Context, TopicConfig) error
	})
	if !ok {
		return nil
	}
	return waiter.WaitForSubscribers(ctx, topic)
}

type managedByteSubscriber interface {
	SubscribeManaged(context.Context, Subscription, ByteHandler) (func(), error)
}

type topicRPCClientSession struct {
	clientID            string
	cancel              context.CancelFunc
	unsubscribeResponse func()
	unsubscribeAck      func()
	responseCh          chan []byte
	handshakeCh         chan []byte
	requestMu           sync.Mutex
	readyMu             sync.Mutex
	readyChecked        bool
	readySucceeded      bool
	closedMu            sync.Mutex
	closed              bool
}

func (s *topicRPCClientSession) ensureReady(
	ctx context.Context,
	adapter *TopicRPCAdapter,
	client ByteClient,
	binding RPCBinding,
) error {
	s.readyMu.Lock()
	defer s.readyMu.Unlock()
	if s.readySucceeded || s.readyChecked {
		return nil
	}
	if err := client.PreparePublish(ctx, binding.RequestChannel); err != nil {
		return err
	}
	if err := client.PreparePublish(ctx, rpcProbeChannel(binding)); err != nil {
		return err
	}
	ready, err := adapter.waitForReady(ctx, client, binding)
	if err != nil {
		return err
	}
	if ready {
		if err := adapter.probePairingWithFrames(ctx, client, binding, s.handshakeCh); err != nil {
			return err
		}
		s.readySucceeded = true
	} else {
		s.readyChecked = true
	}
	return nil
}

func (s *topicRPCClientSession) close() {
	s.closedMu.Lock()
	if s.closed {
		s.closedMu.Unlock()
		return
	}
	s.closed = true
	s.closedMu.Unlock()
	if s.unsubscribeResponse != nil {
		s.unsubscribeResponse()
	}
	if s.unsubscribeAck != nil {
		s.unsubscribeAck()
	}
	if s.cancel != nil {
		s.cancel()
	}
}

func subscribeManaged(
	ctx context.Context,
	client ByteClient,
	subscription Subscription,
	handler ByteHandler,
) (func(), error) {
	if manager, ok := client.(interface {
		SubscribeManaged(context.Context, Subscription, ByteHandler) (func(), error)
	}); ok {
		return manager.SubscribeManaged(ctx, subscription, handler)
	}
	if err := client.Subscribe(ctx, subscription, handler); err != nil {
		return nil, err
	}
	return func() {}, nil
}

func (a TopicRPCAdapter) probePairingWithFrames(
	ctx context.Context,
	client ByteClient,
	binding RPCBinding,
	handshakeCh <-chan []byte,
) error {
	probeFrame := newTopicRPCProbeFrame()
	ackFrame := topicRPCAckFrameForProbe(probeFrame)
	drainBytes(handshakeCh)
	probeWait := topicRPCProbeWait
	if a.readyWait > 0 {
		probeWait = a.readyWait
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeWait)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := client.Publish(probeCtx, rpcProbeChannel(binding), probeFrame); err != nil {
			return err
		}
		select {
		case frame := <-handshakeCh:
			if bytes.Equal(frame, ackFrame) {
				return nil
			}
		case <-probeCtx.Done():
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("cyclonedds rpc endpoint pairing timed out on %s", binding.RequestChannel.TopicName)
		case <-ticker.C:
		}
	}
}

func drainBytes(ch <-chan []byte) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

func topicRPCSessionKey(client ByteClient, binding RPCBinding) string {
	return strings.Join([]string{
		topicRPCClientID(client),
		binding.Standard,
		topicRPCTopicKey(binding.RequestChannel),
		topicRPCTopicKey(binding.ResponseChannel),
	}, "\x00")
}

func topicRPCClientID(client ByteClient) string {
	return fmt.Sprintf("%T:%p", client, client)
}

func topicRPCTopicKey(topic TopicConfig) string {
	parts := []string{topic.TopicName, topic.TypeName}
	keys := make([]string, 0, len(topic.QoS))
	for key := range topic.QoS {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		parts = append(parts, key+"="+topic.QoS[key])
	}
	return strings.Join(parts, "\x1f")
}

func waitForPublishers(ctx context.Context, client ByteClient, topic TopicConfig) error {
	waiter, ok := client.(interface {
		WaitForPublishers(context.Context, TopicConfig) error
	})
	if !ok {
		return nil
	}
	return waiter.WaitForPublishers(ctx, topic)
}

type unsupportedRPCAdapter struct {
	standard string
}

func UnsupportedRPCAdapter(standard string) RPCAdapter {
	return unsupportedRPCAdapter{standard: normalizeStandard(standard)}
}

func (a unsupportedRPCAdapter) Request(context.Context, RPCBinding, []byte, time.Duration) ([]byte, error) {
	return nil, fmt.Errorf("%s is not implemented for Go native CycloneDDS yet; use standard: omg_dds_rpc or add a real rmw_cyclonedds wire adapter", a.standard)
}

func (a unsupportedRPCAdapter) HandleRequest(context.Context, RPCBinding, func(context.Context, []byte) ([]byte, error)) error {
	return fmt.Errorf("%s is not implemented for Go native CycloneDDS yet; use standard: omg_dds_rpc or add a real rmw_cyclonedds wire adapter", a.standard)
}
