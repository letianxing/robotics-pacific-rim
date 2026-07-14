package ros2

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

const (
	protoEnvelopeMessageType = "common/msg/ProtoEnvelope"
	protoEnvelopeServiceType = "common/srv/ProtoCall"
)

type protoEnvelope struct {
	SchemaType      string
	Codec           string
	Route           string
	TraceID         string
	Traceparent     string
	CreatedAtUnixMS uint64
	Payload         []byte
}

func channelUsesProtoEnvelope(channel core.Channel) bool {
	metadata := channel.Metadata
	if metadata == nil {
		return false
	}
	adapter := normalizeROS2Token(firstNonEmptyString(metadata["adapter"], metadata["ros2.adapter"]))
	return adapter == "ros2_proto_envelope"
}

func graphMessageType(channel core.Channel) string {
	if channelUsesProtoEnvelope(channel) {
		return protoEnvelopeMessageType
	}
	if channelUsesTypedMapper(channel) && channel.Metadata != nil {
		if rosType := firstNonEmptyString(channel.Metadata["ros_message_type"], channel.Metadata["ros2.message_type"]); strings.TrimSpace(rosType) != "" {
			return strings.TrimSpace(rosType)
		}
	}
	if strings.TrimSpace(channel.MessageType) != "" {
		return strings.TrimSpace(channel.MessageType)
	}
	if channel.Metadata == nil {
		return ""
	}
	return strings.TrimSpace(firstNonEmptyString(channel.Metadata["message_type"], channel.Metadata["schema.type"]))
}

func graphServiceType(channel core.Channel) string {
	if channelUsesProtoEnvelope(channel) {
		return protoEnvelopeServiceType
	}
	if channelUsesTypedMapper(channel) && channel.Metadata != nil {
		if rosType := firstNonEmptyString(channel.Metadata["ros_service_type"], channel.Metadata["ros2.service_type"]); strings.TrimSpace(rosType) != "" {
			return strings.TrimSpace(rosType)
		}
	}
	if strings.TrimSpace(channel.MessageType) != "" {
		return strings.TrimSpace(channel.MessageType)
	}
	if channel.Metadata == nil {
		return ""
	}
	return strings.TrimSpace(firstNonEmptyString(channel.Metadata["service_type"], channel.Metadata["schema.type"]))
}

func encodeChannelProtoEnvelope(channel core.Channel, payload []byte) []byte {
	metadata := channel.Metadata
	if metadata == nil {
		metadata = map[string]string{}
	}
	envelope := protoEnvelope{
		SchemaType:      firstNonEmptyString(channel.MessageType, metadata["schema.type"]),
		Codec:           firstNonEmptyString(metadata["codec"], "protobuf"),
		Route:           firstNonEmptyString(metadata["logical_route"], metadata["source_name"], channel.Name),
		TraceID:         metadata["trace_id"],
		Traceparent:     metadata["traceparent"],
		CreatedAtUnixMS: uint64(time.Now().UnixMilli()),
		Payload:         append([]byte(nil), payload...),
	}
	return encodeProtoEnvelopeCDR(envelope)
}

func encodeProtoEnvelopeCDR(envelope protoEnvelope) []byte {
	buf := []byte{0x00, 0x01, 0x00, 0x00}
	writeCDRString(&buf, envelope.SchemaType)
	writeCDRString(&buf, envelope.Codec)
	writeCDRString(&buf, envelope.Route)
	writeCDRString(&buf, envelope.TraceID)
	writeCDRString(&buf, envelope.Traceparent)
	alignCDR(&buf, 8)
	buf = appendLittleEndianUint64(buf, envelope.CreatedAtUnixMS)
	alignCDR(&buf, 4)
	buf = appendLittleEndianUint32(buf, uint32(len(envelope.Payload)))
	buf = append(buf, envelope.Payload...)
	return buf
}

func decodeProtoEnvelopeCDR(data []byte) (protoEnvelope, error) {
	decoder := cdrDecoder{data: data, offset: 0}
	if len(data) < 4 {
		return protoEnvelope{}, errors.New("ROS2 proto envelope CDR payload is shorter than the encapsulation header")
	}
	if data[0] != 0x00 || data[1] != 0x01 {
		return protoEnvelope{}, fmt.Errorf("unsupported ROS2 proto envelope CDR encapsulation %02x %02x", data[0], data[1])
	}
	decoder.offset = 4
	schemaType, err := decoder.readString()
	if err != nil {
		return protoEnvelope{}, fmt.Errorf("decode schema_type: %w", err)
	}
	codec, err := decoder.readString()
	if err != nil {
		return protoEnvelope{}, fmt.Errorf("decode codec: %w", err)
	}
	route, err := decoder.readString()
	if err != nil {
		return protoEnvelope{}, fmt.Errorf("decode route: %w", err)
	}
	traceID, err := decoder.readString()
	if err != nil {
		return protoEnvelope{}, fmt.Errorf("decode trace_id: %w", err)
	}
	traceparent, err := decoder.readString()
	if err != nil {
		return protoEnvelope{}, fmt.Errorf("decode traceparent: %w", err)
	}
	createdAt, err := decoder.readUint64()
	if err != nil {
		return protoEnvelope{}, fmt.Errorf("decode created_at_unix_ms: %w", err)
	}
	payload, err := decoder.readBytes()
	if err != nil {
		return protoEnvelope{}, fmt.Errorf("decode payload: %w", err)
	}
	return protoEnvelope{
		SchemaType:      schemaType,
		Codec:           codec,
		Route:           route,
		TraceID:         traceID,
		Traceparent:     traceparent,
		CreatedAtUnixMS: createdAt,
		Payload:         payload,
	}, nil
}

func writeCDRString(buf *[]byte, value string) {
	alignCDR(buf, 4)
	*buf = appendLittleEndianUint32(*buf, uint32(len(value)+1))
	*buf = append(*buf, value...)
	*buf = append(*buf, 0)
}

func appendLittleEndianUint32(out []byte, value uint32) []byte {
	var encoded [4]byte
	binary.LittleEndian.PutUint32(encoded[:], value)
	return append(out, encoded[:]...)
}

func appendLittleEndianUint64(out []byte, value uint64) []byte {
	var encoded [8]byte
	binary.LittleEndian.PutUint64(encoded[:], value)
	return append(out, encoded[:]...)
}

func alignCDR(buf *[]byte, alignment int) {
	if alignment <= 1 {
		return
	}
	padding := (alignment - (cdrPayloadOffset(len(*buf)) % alignment)) % alignment
	for i := 0; i < padding; i++ {
		*buf = append(*buf, 0)
	}
}

type cdrDecoder struct {
	data   []byte
	offset int
}

func (d *cdrDecoder) align(alignment int) error {
	if alignment <= 1 {
		return nil
	}
	padding := (alignment - (cdrPayloadOffset(d.offset) % alignment)) % alignment
	if d.offset+padding > len(d.data) {
		return errors.New("alignment exceeds payload length")
	}
	d.offset += padding
	return nil
}

func (d *cdrDecoder) readString() (string, error) {
	if err := d.align(4); err != nil {
		return "", err
	}
	length, err := d.readUint32Aligned()
	if err != nil {
		return "", err
	}
	if length == 0 {
		return "", errors.New("CDR string length must include a null terminator")
	}
	end := d.offset + int(length)
	if end > len(d.data) {
		return "", errors.New("CDR string exceeds payload length")
	}
	raw := d.data[d.offset:end]
	d.offset = end
	if raw[len(raw)-1] == 0 {
		raw = raw[:len(raw)-1]
	}
	return string(raw), nil
}

func (d *cdrDecoder) readUint64() (uint64, error) {
	if err := d.align(8); err != nil {
		return 0, err
	}
	if d.offset+8 > len(d.data) {
		return 0, errors.New("uint64 exceeds payload length")
	}
	value := binary.LittleEndian.Uint64(d.data[d.offset : d.offset+8])
	d.offset += 8
	return value, nil
}

func (d *cdrDecoder) readBytes() ([]byte, error) {
	if err := d.align(4); err != nil {
		return nil, err
	}
	length, err := d.readUint32Aligned()
	if err != nil {
		return nil, err
	}
	end := d.offset + int(length)
	if end > len(d.data) {
		return nil, errors.New("byte sequence exceeds payload length")
	}
	out := append([]byte(nil), d.data[d.offset:end]...)
	d.offset = end
	return out, nil
}

func (d *cdrDecoder) readUint32Aligned() (uint32, error) {
	if d.offset+4 > len(d.data) {
		return 0, errors.New("uint32 exceeds payload length")
	}
	value := binary.LittleEndian.Uint32(d.data[d.offset : d.offset+4])
	d.offset += 4
	return value, nil
}

func normalizeROS2Token(value string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "-", "_")
}

func cdrPayloadOffset(offset int) int {
	if offset <= 4 {
		return 0
	}
	return offset - 4
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
