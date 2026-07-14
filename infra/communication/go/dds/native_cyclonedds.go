//go:build pacific_rim_cyclonedds

package dds

/*
#cgo pkg-config: CycloneDDS
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>
#include <dds/dds.h>

#ifndef DDS_RETCODE_OK
#define DDS_RETCODE_OK 0
#endif

#ifndef dds_alignof
#define dds_alignof(type) offsetof(struct { char c; type member; }, member)
#endif

typedef struct pr_dds_sequence_octet {
  uint32_t _maximum;
  uint32_t _length;
  uint8_t *_buffer;
  bool _release;
} pr_dds_sequence_octet;

typedef struct pr_dds_envelope {
  pr_dds_sequence_octet payload;
} pr_dds_envelope;

static const uint32_t pr_dds_envelope_ops [] =
{
  DDS_OP_ADR | DDS_OP_TYPE_SEQ | DDS_OP_SUBTYPE_1BY, offsetof (pr_dds_envelope, payload),
  DDS_OP_RTS
};

#define PR_TYPE_INFO_CDR (unsigned char []){ \
  0x60, 0x00, 0x00, 0x00, 0x01, 0x10, 0x00, 0x40, 0x28, 0x00, 0x00, 0x00, 0x24, 0x00, 0x00, 0x00, \
  0x14, 0x00, 0x00, 0x00, 0xf1, 0x53, 0x55, 0x15, 0xd9, 0xc7, 0x9c, 0xa0, 0x0f, 0x11, 0x41, 0x26, \
  0xb2, 0x97, 0x71, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, \
  0x00, 0x00, 0x00, 0x00, 0x02, 0x10, 0x00, 0x40, 0x28, 0x00, 0x00, 0x00, 0x24, 0x00, 0x00, 0x00, \
  0x14, 0x00, 0x00, 0x00, 0xf2, 0x23, 0x20, 0x6d, 0x85, 0xca, 0x89, 0x19, 0xf5, 0x4c, 0xbc, 0xa3, \
  0x30, 0x93, 0x82, 0x00, 0x72, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, \
  0x00, 0x00, 0x00, 0x00\
}

#define PR_TYPE_MAP_CDR (unsigned char []){ \
  0x40, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xf1, 0x53, 0x55, 0x15, 0xd9, 0xc7, 0x9c, 0xa0, \
  0x0f, 0x11, 0x41, 0x26, 0xb2, 0x97, 0x71, 0x00, 0x28, 0x00, 0x00, 0x00, 0xf1, 0x51, 0x01, 0x00, \
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, \
  0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x80, 0xf3, 0x01, 0x00, 0x00, 0x02, \
  0x32, 0x1c, 0x3c, 0xf4, 0x86, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xf2, 0x23, 0x20, 0x6d, \
  0x85, 0xca, 0x89, 0x19, 0xf5, 0x4c, 0xbc, 0xa3, 0x30, 0x93, 0x82, 0x00, 0x6e, 0x00, 0x00, 0x00, \
  0xf2, 0x51, 0x01, 0x00, 0x3e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36, 0x00, 0x00, 0x00, \
  0x70, 0x61, 0x63, 0x69, 0x66, 0x69, 0x63, 0x5f, 0x72, 0x69, 0x6d, 0x3a, 0x3a, 0x63, 0x6f, 0x6d, \
  0x6d, 0x75, 0x6e, 0x69, 0x63, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x3a, 0x3a, 0x50, 0x61, 0x63, 0x69, \
  0x66, 0x69, 0x63, 0x52, 0x69, 0x6d, 0x4d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x45, 0x6e, 0x76, \
  0x65, 0x6c, 0x6f, 0x70, 0x65, 0x00, 0x00, 0x00, 0x22, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, \
  0x1a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x80, 0xf3, 0x01, 0x00, 0x00, 0x02, \
  0x08, 0x00, 0x00, 0x00, 0x70, 0x61, 0x79, 0x6c, 0x6f, 0x61, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, \
  0x22, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xf2, 0x23, 0x20, 0x6d, 0x85, 0xca, 0x89, 0x19, \
  0xf5, 0x4c, 0xbc, 0xa3, 0x30, 0x93, 0x82, 0xf1, 0x53, 0x55, 0x15, 0xd9, 0xc7, 0x9c, 0xa0, 0x0f, \
  0x11, 0x41, 0x26, 0xb2, 0x97, 0x71\
}

static const dds_topic_descriptor_t pr_dds_envelope_desc =
{
  .m_size = sizeof (pr_dds_envelope),
  .m_align = dds_alignof (pr_dds_envelope),
#ifdef DDS_TOPIC_XTYPES_METADATA
  .m_flagset = DDS_TOPIC_XTYPES_METADATA,
#else
  .m_flagset = 0u,
#endif
  .m_nkeys = 0u,
  .m_typename = "pacific_rim::communication::PacificRimMessageEnvelope",
  .m_keys = NULL,
  .m_nops = 2,
  .m_ops = pr_dds_envelope_ops,
  .m_meta = ""
#ifdef DDS_TOPIC_XTYPES_METADATA
  ,
  .type_information = { .data = PR_TYPE_INFO_CDR, .sz = 100u },
  .type_mapping = { .data = PR_TYPE_MAP_CDR, .sz = 246u }
#ifdef DDS_TOPIC_RESTRICT_DATA_REPRESENTATION
  ,
  .restrict_data_representation = 0u
#endif
#endif
};

static const char *pr_dds_error(int rc) {
  if (rc >= 0) {
    return "";
  }
  return dds_strretcode(-rc);
}

static pr_dds_envelope *pr_dds_envelope_new(void *payload, uint32_t length) {
  pr_dds_envelope *sample = (pr_dds_envelope *)dds_alloc(sizeof(pr_dds_envelope));
  memset(sample, 0, sizeof(pr_dds_envelope));
  sample->payload._maximum = length;
  sample->payload._length = length;
  sample->payload._release = true;
  if (length > 0) {
    sample->payload._buffer = (uint8_t *)dds_alloc(length);
    memcpy(sample->payload._buffer, payload, length);
  }
  return sample;
}

static void pr_dds_envelope_free(pr_dds_envelope *sample) {
  dds_sample_free(sample, &pr_dds_envelope_desc, DDS_FREE_ALL);
}

static dds_entity_t pr_dds_create_participant(uint32_t domain) {
  return dds_create_participant(domain, NULL, NULL);
}

static dds_entity_t pr_dds_create_topic(dds_entity_t participant, const char *topic_name) {
  return dds_create_topic(participant, &pr_dds_envelope_desc, topic_name, NULL, NULL);
}

static dds_return_t pr_dds_take_one(dds_entity_t reader, pr_dds_envelope **sample, dds_sample_info_t *info) {
  void *samples[1] = { NULL };
  dds_return_t rc = dds_take(reader, samples, info, 1, 1);
  *sample = (pr_dds_envelope *)samples[0];
  return rc;
}

static dds_return_t pr_dds_return_loan(dds_entity_t reader, pr_dds_envelope *sample) {
  void *samples[1] = { sample };
  return dds_return_loan(reader, samples, 1);
}

static dds_duration_t pr_dds_millis(int64_t ms) {
  return ms * 1000000;
}

*/
import "C"

import (
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"
	"unsafe"
)

type NativeByteClient struct {
	mu          sync.Mutex
	config      CycloneDDSConfig
	participant C.dds_entity_t
	writers     map[string]C.dds_entity_t
	readers     []C.dds_entity_t
	closed      bool
}

func NewNativeByteClient(config CycloneDDSConfig) (*NativeByteClient, error) {
	return &NativeByteClient{
		config:  config,
		writers: map[string]C.dds_entity_t{},
	}, nil
}

func (c *NativeByteClient) Connect(_ context.Context, config CycloneDDSConfig) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.participant > 0 {
		return nil
	}
	c.config = config
	if config.ConfigURI != "" {
		if err := os.Setenv("CYCLONEDDS_URI", config.ConfigURI); err != nil {
			return fmt.Errorf("set CYCLONEDDS_URI: %w", err)
		}
	}
	participant := C.pr_dds_create_participant(C.uint32_t(config.DomainID))
	if participant <= 0 {
		return fmt.Errorf("create cyclonedds participant: %s", cError(participant))
	}
	c.participant = participant
	c.closed = false
	return nil
}

func (c *NativeByteClient) Close(context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.writers = map[string]C.dds_entity_t{}
	c.readers = nil
	if c.participant > 0 {
		rc := C.dds_delete(c.participant)
		c.participant = 0
		if rc != C.DDS_RETCODE_OK {
			return fmt.Errorf("close cyclonedds participant: %s", cError(rc))
		}
	}
	return nil
}

func (c *NativeByteClient) PreparePublish(_ context.Context, topic TopicConfig) error {
	_, err := c.writer(topic)
	return err
}

func (c *NativeByteClient) Publish(ctx context.Context, topic TopicConfig, payload []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	writer, err := c.writer(topic)
	if err != nil {
		return err
	}
	var ptr unsafe.Pointer
	if len(payload) > 0 {
		ptr = unsafe.Pointer(&payload[0])
	}
	sample := C.pr_dds_envelope_new(ptr, C.uint32_t(len(payload)))
	defer C.pr_dds_envelope_free(sample)
	rc := C.dds_write(writer, unsafe.Pointer(sample))
	if rc != C.DDS_RETCODE_OK {
		return fmt.Errorf("cyclonedds write %s: %s", topic.TopicName, cError(rc))
	}
	return nil
}

func (c *NativeByteClient) Subscribe(ctx context.Context, subscription Subscription, handler ByteHandler) error {
	_, err := c.SubscribeManaged(ctx, subscription, handler)
	return err
}

func (c *NativeByteClient) SubscribeManaged(ctx context.Context, subscription Subscription, handler ByteHandler) (func(), error) {
	reader, err := c.reader(subscription.Topic)
	if err != nil {
		return nil, err
	}
	period := time.Duration(c.config.ReadPeriodSec * float64(time.Second))
	if period <= 0 {
		period = 10 * time.Millisecond
	}
	subCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(period)
		defer ticker.Stop()
		for {
			select {
			case <-subCtx.Done():
				return
			case <-ticker.C:
				c.takeAvailable(subCtx, reader, handler)
			}
		}
	}()
	var stopped bool
	var stopMu sync.Mutex
	return func() {
		stopMu.Lock()
		if stopped {
			stopMu.Unlock()
			return
		}
		stopped = true
		stopMu.Unlock()
		cancel()
		<-done
		c.mu.Lock()
		for index, candidate := range c.readers {
			if candidate == reader {
				c.readers = append(c.readers[:index], c.readers[index+1:]...)
				break
			}
		}
		c.mu.Unlock()
		C.dds_delete(reader)
	}, nil
}

func (c *NativeByteClient) writer(topic TopicConfig) (C.dds_entity_t, error) {
	key := topic.TopicName + ":" + topic.TypeName
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.participant <= 0 || c.closed {
		return 0, fmt.Errorf("cyclonedds native Go backend is not connected")
	}
	if writer := c.writers[key]; writer > 0 {
		return writer, nil
	}
	topicName := C.CString(nativeDDSTopicName(topic.TopicName))
	defer C.free(unsafe.Pointer(topicName))
	topicEntity := C.pr_dds_create_topic(c.participant, topicName)
	if topicEntity <= 0 {
		return 0, fmt.Errorf("create cyclonedds topic %s: %s", topic.TopicName, cError(topicEntity))
	}
	qos := cQoS(topic.QoS)
	if qos != nil {
		defer C.dds_delete_qos(qos)
	}
	writer := C.dds_create_writer(c.participant, topicEntity, qos, nil)
	if writer <= 0 {
		return 0, fmt.Errorf("create cyclonedds writer %s: %s", topic.TopicName, cError(writer))
	}
	c.writers[key] = writer
	return writer, nil
}

func (c *NativeByteClient) reader(topic TopicConfig) (C.dds_entity_t, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.participant <= 0 || c.closed {
		return 0, fmt.Errorf("cyclonedds native Go backend is not connected")
	}
	topicName := C.CString(nativeDDSTopicName(topic.TopicName))
	defer C.free(unsafe.Pointer(topicName))
	topicEntity := C.pr_dds_create_topic(c.participant, topicName)
	if topicEntity <= 0 {
		return 0, fmt.Errorf("create cyclonedds topic %s: %s", topic.TopicName, cError(topicEntity))
	}
	qos := cQoS(topic.QoS)
	if qos != nil {
		defer C.dds_delete_qos(qos)
	}
	reader := C.dds_create_reader(c.participant, topicEntity, qos, nil)
	if reader <= 0 {
		return 0, fmt.Errorf("create cyclonedds reader %s: %s", topic.TopicName, cError(reader))
	}
	c.readers = append(c.readers, reader)
	return reader, nil
}

func (c *NativeByteClient) takeAvailable(ctx context.Context, reader C.dds_entity_t, handler ByteHandler) {
	for {
		var info C.dds_sample_info_t
		var sample *C.pr_dds_envelope
		rc := C.pr_dds_take_one(reader, &sample, &info)
		if rc <= 0 {
			return
		}
		if sample == nil || !bool(info.valid_data) {
			if sample != nil {
				C.pr_dds_return_loan(reader, sample)
			}
			continue
		}
		payload := C.GoBytes(unsafe.Pointer(sample.payload._buffer), C.int(sample.payload._length))
		C.pr_dds_return_loan(reader, sample)
		_ = handler(ctx, payload)
	}
}

func nativeDDSTopicName(name string) string {
	return "pr_" + hex.EncodeToString([]byte(name))
}

func cError(rc C.dds_return_t) string {
	msg := C.pr_dds_error(C.int(rc))
	if msg == nil {
		return fmt.Sprintf("dds return code %d", int(rc))
	}
	return C.GoString(msg)
}

func cQoS(raw map[string]string) *C.dds_qos_t {
	if len(raw) == 0 {
		return nil
	}
	qos := C.dds_create_qos()
	reliability := normalizeQoS(raw["reliability"])
	switch reliability {
	case "reliable":
		C.dds_qset_reliability(qos, C.DDS_RELIABILITY_RELIABLE, C.pr_dds_millis(100))
	case "best_effort", "besteffort":
		C.dds_qset_reliability(qos, C.DDS_RELIABILITY_BEST_EFFORT, 0)
	}
	history := normalizeQoS(raw["history"])
	depth := int32(0)
	if value := raw["depth"]; value != "" {
		if parsed, err := strconv.Atoi(value); err == nil && parsed > 0 {
			depth = int32(parsed)
		}
	}
	switch history {
	case "keep_all", "keepall":
		C.dds_qset_history(qos, C.DDS_HISTORY_KEEP_ALL, 0)
	default:
		if depth > 0 {
			C.dds_qset_history(qos, C.DDS_HISTORY_KEEP_LAST, C.int32_t(depth))
		}
	}
	durability := normalizeQoS(raw["durability"])
	switch durability {
	case "transient_local", "transientlocal":
		C.dds_qset_durability(qos, C.DDS_DURABILITY_TRANSIENT_LOCAL)
	case "volatile":
		C.dds_qset_durability(qos, C.DDS_DURABILITY_VOLATILE)
	}
	return qos
}

func normalizeQoS(value string) string {
	out := ""
	for _, ch := range value {
		switch {
		case ch >= 'A' && ch <= 'Z':
			out += string(ch + ('a' - 'A'))
		case ch == '-':
			out += "_"
		default:
			out += string(ch)
		}
	}
	return out
}
