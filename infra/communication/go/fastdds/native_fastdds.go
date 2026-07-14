//go:build pacific_rim_fastdds

package fastdds

/*
#cgo CXXFLAGS: -std=c++17 -I${SRCDIR}/../../../.. -I${SRCDIR}/../../cpp/include -I/opt/ros/humble/include -I/opt/ros/humble/include/fastrtps -I/opt/ros/humble/include/fastcdr
#cgo LDFLAGS: -L/opt/ros/humble/lib -Wl,-rpath,/opt/ros/humble/lib -lfastcdr -lfastrtps -lstdc++
#include <stdint.h>
#include <stdlib.h>
#include <stddef.h>

typedef struct pr_go_fastdds_client pr_go_fastdds_client;
typedef void (*pr_go_fastdds_callback)(void*, uint8_t*, size_t);

extern void prGoFastDDSOnData(void*, uint8_t*, size_t);

pr_go_fastdds_client* pr_go_fastdds_create(int domain_id, const char* participant_name, const char* options);
void pr_go_fastdds_destroy(pr_go_fastdds_client* client);
const char* pr_go_fastdds_last_error(pr_go_fastdds_client* client);
int pr_go_fastdds_connect(pr_go_fastdds_client* client);
int pr_go_fastdds_prepare_publish(pr_go_fastdds_client* client, const char* topic_name, const char* type_name, const char* qos);
int pr_go_fastdds_publish(pr_go_fastdds_client* client, const char* topic_name, const char* type_name, const char* qos, const uint8_t* data, size_t len);
int pr_go_fastdds_wait_for_subscribers(pr_go_fastdds_client* client, const char* topic_name, const char* type_name, const char* qos, int timeout_ms);
int pr_go_fastdds_wait_for_publishers(pr_go_fastdds_client* client, const char* topic_name, const char* type_name, const char* qos, int timeout_ms);
int pr_go_fastdds_subscribe(pr_go_fastdds_client* client, const char* topic_name, const char* type_name, const char* qos, pr_go_fastdds_callback callback, void* user_data);
void pr_go_fastdds_unsubscribe(pr_go_fastdds_client* client, int subscription_id);
*/
import "C"

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/dds"
)

type NativeByteClient struct {
	mu            sync.Mutex
	config        dds.CycloneDDSConfig
	handle        *C.pr_go_fastdds_client
	closed        bool
	subscriptions map[int]fastDDSSubscription
}

type fastDDSCallback func([]byte)

type fastDDSSubscription struct {
	callbackID uintptr
	cancel     context.CancelFunc
}

var (
	fastDDSCallbackSeq atomic.Uint64
	fastDDSCallbacksMu sync.Mutex
	fastDDSCallbacks   = map[uintptr]fastDDSCallback{}
)

func NewNativeByteClient(config dds.CycloneDDSConfig) (*NativeByteClient, error) {
	return &NativeByteClient{
		config:        config,
		closed:        true,
		subscriptions: map[int]fastDDSSubscription{},
	}, nil
}

func (c *NativeByteClient) Connect(ctx context.Context, config dds.CycloneDDSConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.handle != nil && !c.closed {
		return nil
	}
	c.config = config
	participant := C.CString(config.ParticipantName)
	options := C.CString(configOptions(config))
	defer C.free(unsafe.Pointer(participant))
	defer C.free(unsafe.Pointer(options))
	handle := C.pr_go_fastdds_create(
		C.int(config.DomainID),
		participant,
		options,
	)
	if handle == nil {
		return fmt.Errorf("create native Fast DDS client failed")
	}
	if rc := C.pr_go_fastdds_connect(handle); rc == 0 {
		err := lastFastDDSError(handle, "connect native Fast DDS client")
		C.pr_go_fastdds_destroy(handle)
		return err
	}
	c.handle = handle
	c.closed = false
	return nil
}

func (c *NativeByteClient) Close(context.Context) error {
	c.mu.Lock()
	handle := c.handle
	c.handle = nil
	c.closed = true
	for _, subscription := range c.subscriptions {
		subscription.cancel()
		deleteFastDDSCallback(subscription.callbackID)
	}
	c.subscriptions = map[int]fastDDSSubscription{}
	if handle != nil {
		C.pr_go_fastdds_destroy(handle)
	}
	c.mu.Unlock()
	return nil
}

func (c *NativeByteClient) PreparePublish(ctx context.Context, topic dds.TopicConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	topicName, typeName, qos := cTopic(topic)
	defer C.free(unsafe.Pointer(topicName))
	defer C.free(unsafe.Pointer(typeName))
	defer C.free(unsafe.Pointer(qos))

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.handle == nil || c.closed {
		return fmt.Errorf("native Fast DDS client is not connected")
	}
	if rc := C.pr_go_fastdds_prepare_publish(c.handle, topicName, typeName, qos); rc == 0 {
		return lastFastDDSError(c.handle, "prepare native Fast DDS publisher")
	}
	return nil
}

func (c *NativeByteClient) Publish(ctx context.Context, topic dds.TopicConfig, payload []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	topicName, typeName, qos := cTopic(topic)
	defer C.free(unsafe.Pointer(topicName))
	defer C.free(unsafe.Pointer(typeName))
	defer C.free(unsafe.Pointer(qos))
	var ptr *C.uint8_t
	if len(payload) > 0 {
		ptr = (*C.uint8_t)(unsafe.Pointer(&payload[0]))
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.handle == nil || c.closed {
		return fmt.Errorf("native Fast DDS client is not connected")
	}
	if rc := C.pr_go_fastdds_publish(
		c.handle,
		topicName,
		typeName,
		qos,
		ptr,
		C.size_t(len(payload)),
	); rc == 0 {
		return lastFastDDSError(c.handle, "publish native Fast DDS payload")
	}
	return nil
}

func (c *NativeByteClient) WaitForSubscribers(ctx context.Context, topic dds.TopicConfig) error {
	return c.waitForMatch(ctx, topic, true)
}

func (c *NativeByteClient) WaitForPublishers(ctx context.Context, topic dds.TopicConfig) error {
	return c.waitForMatch(ctx, topic, false)
}

func (c *NativeByteClient) Subscribe(ctx context.Context, subscription dds.Subscription, handler dds.ByteHandler) error {
	_, err := c.SubscribeManaged(ctx, subscription, handler)
	return err
}

func (c *NativeByteClient) SubscribeManaged(
	ctx context.Context,
	subscription dds.Subscription,
	handler dds.ByteHandler,
) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if handler == nil {
		return nil, fmt.Errorf("native Fast DDS subscribe handler is nil")
	}
	id := uintptr(fastDDSCallbackSeq.Add(1))
	if id == 0 {
		id = uintptr(fastDDSCallbackSeq.Add(1))
	}
	callbackCtx, cancel := context.WithCancel(ctx)
	fastDDSCallbacksMu.Lock()
	fastDDSCallbacks[id] = func(payload []byte) {
		if callbackCtx.Err() != nil {
			return
		}
		_ = handler(callbackCtx, payload)
	}
	fastDDSCallbacksMu.Unlock()

	topicName, typeName, qos := cTopic(subscription.Topic)
	defer C.free(unsafe.Pointer(topicName))
	defer C.free(unsafe.Pointer(typeName))
	defer C.free(unsafe.Pointer(qos))

	c.mu.Lock()
	if c.handle == nil || c.closed {
		c.mu.Unlock()
		cancel()
		deleteFastDDSCallback(id)
		return nil, fmt.Errorf("native Fast DDS client is not connected")
	}
	subscriptionID := C.pr_go_fastdds_subscribe(
		c.handle,
		topicName,
		typeName,
		qos,
		C.pr_go_fastdds_callback(C.prGoFastDDSOnData),
		unsafe.Pointer(id),
	)
	if subscriptionID <= 0 {
		err := lastFastDDSError(c.handle, "subscribe native Fast DDS topic")
		c.mu.Unlock()
		cancel()
		deleteFastDDSCallback(id)
		return nil, err
	}
	c.subscriptions[int(subscriptionID)] = fastDDSSubscription{
		callbackID: id,
		cancel:     cancel,
	}
	c.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			c.unsubscribe(subscriptionID)
		})
	}, nil
}

func (c *NativeByteClient) unsubscribe(subscriptionID C.int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	subscription, ok := c.subscriptions[int(subscriptionID)]
	if !ok {
		return
	}
	delete(c.subscriptions, int(subscriptionID))
	subscription.cancel()
	deleteFastDDSCallback(subscription.callbackID)
	if c.handle != nil && !c.closed {
		C.pr_go_fastdds_unsubscribe(c.handle, subscriptionID)
	}
}

func (c *NativeByteClient) waitForMatch(ctx context.Context, topic dds.TopicConfig, subscribers bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	topicName, typeName, qos := cTopic(topic)
	defer C.free(unsafe.Pointer(topicName))
	defer C.free(unsafe.Pointer(typeName))
	defer C.free(unsafe.Pointer(qos))
	timeout := 500 * time.Millisecond
	if deadline, ok := ctx.Deadline(); ok {
		timeout = time.Until(deadline)
	}
	if timeout < 0 {
		timeout = 0
	}
	timeoutMS := C.int(timeout / time.Millisecond)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.handle == nil || c.closed {
		return fmt.Errorf("native Fast DDS client is not connected")
	}
	var rc C.int
	if subscribers {
		rc = C.pr_go_fastdds_wait_for_subscribers(c.handle, topicName, typeName, qos, timeoutMS)
	} else {
		rc = C.pr_go_fastdds_wait_for_publishers(c.handle, topicName, typeName, qos, timeoutMS)
	}
	if rc != 0 {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return context.DeadlineExceeded
}

func cTopic(topic dds.TopicConfig) (*C.char, *C.char, *C.char) {
	topicName := topic.TopicName
	if topicName == "" {
		topicName = "default"
	}
	typeName := topic.TypeName
	if typeName == "" {
		typeName = "PacificRimMessageEnvelope"
	}
	return C.CString(topicName), C.CString(typeName), C.CString(encodeStringMap(topic.QoS))
}

func configOptions(config dds.CycloneDDSConfig) string {
	options := map[string]string{}
	if config.ReadPeriodSec > 0 {
		options["read_period_sec"] = strconv.FormatFloat(config.ReadPeriodSec, 'f', -1, 64)
	}
	return encodeStringMap(options)
}

func encodeStringMap(values map[string]string) string {
	if len(values) == 0 {
		return ""
	}
	var builder strings.Builder
	for key, value := range values {
		if key == "" {
			continue
		}
		builder.WriteString(strings.ReplaceAll(key, "\n", " "))
		builder.WriteByte('=')
		builder.WriteString(strings.ReplaceAll(value, "\n", " "))
		builder.WriteByte('\n')
	}
	return builder.String()
}

func lastFastDDSError(handle *C.pr_go_fastdds_client, op string) error {
	if handle == nil {
		return fmt.Errorf("%s failed", op)
	}
	message := C.GoString(C.pr_go_fastdds_last_error(handle))
	if message == "" {
		return fmt.Errorf("%s failed", op)
	}
	return fmt.Errorf("%s: %s", op, message)
}

func deleteFastDDSCallback(id uintptr) {
	fastDDSCallbacksMu.Lock()
	delete(fastDDSCallbacks, id)
	fastDDSCallbacksMu.Unlock()
}

//export prGoFastDDSOnData
func prGoFastDDSOnData(user unsafe.Pointer, data *C.uint8_t, size C.size_t) {
	id := uintptr(user)
	fastDDSCallbacksMu.Lock()
	callback := fastDDSCallbacks[id]
	fastDDSCallbacksMu.Unlock()
	if callback == nil {
		return
	}
	payload := C.GoBytes(unsafe.Pointer(data), C.int(size))
	go callback(payload)
}

func RegisterNativeBus() {
	topicRPC := &dds.TopicRPCAdapter{}
	dds.RegisterWithKindAndRPCAdapters(
		communication.TransportFastDDS,
		func(config dds.CycloneDDSConfig) (dds.ByteClient, error) {
			return NewNativeByteClient(config)
		},
		map[string]dds.RPCAdapter{
			"omg_dds_rpc": topicRPC,
		},
	)
}
