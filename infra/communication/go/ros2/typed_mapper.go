package ros2

import (
	"fmt"
	"strings"
	"sync"

	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

type TypedMapper interface {
	ProtoToROS2CDR(channel core.Channel, payload []byte) ([]byte, error)
	ROS2CDRToProto(channel core.Channel, payload []byte) ([]byte, error)
}

type TypedMapperFunc struct {
	ProtoToROS2CDRFunc func(core.Channel, []byte) ([]byte, error)
	ROS2CDRToProtoFunc func(core.Channel, []byte) ([]byte, error)
}

func (m TypedMapperFunc) ProtoToROS2CDR(channel core.Channel, payload []byte) ([]byte, error) {
	if m.ProtoToROS2CDRFunc == nil {
		return nil, fmt.Errorf("ROS2 typed mapper has no proto-to-ROS2 mapping for %s", mapperKey(channel))
	}
	return m.ProtoToROS2CDRFunc(channel, payload)
}

func (m TypedMapperFunc) ROS2CDRToProto(channel core.Channel, payload []byte) ([]byte, error) {
	if m.ROS2CDRToProtoFunc == nil {
		return nil, fmt.Errorf("ROS2 typed mapper has no ROS2-to-proto mapping for %s", mapperKey(channel))
	}
	return m.ROS2CDRToProtoFunc(channel, payload)
}

var typedMapperRegistry = struct {
	sync.RWMutex
	entries map[string]TypedMapper
}{entries: map[string]TypedMapper{}}

func RegisterTypedMapper(schemaType string, ros2Type string, mapper TypedMapper) {
	key := normalizeMapperKey(schemaType, ros2Type)
	if key == "" || mapper == nil {
		return
	}
	typedMapperRegistry.Lock()
	defer typedMapperRegistry.Unlock()
	typedMapperRegistry.entries[key] = mapper
}

func channelUsesTypedMapper(channel core.Channel) bool {
	metadata := channel.Metadata
	if metadata == nil {
		return false
	}
	adapter := normalizeROS2Token(firstNonEmptyString(metadata["adapter"], metadata["ros2.adapter"]))
	return adapter == "ros2_typed_mapper"
}

func encodeTypedMappedPayload(channel core.Channel, payload []byte) ([]byte, error) {
	mapper, err := mapperForChannel(channel)
	if err != nil {
		return nil, err
	}
	return mapper.ProtoToROS2CDR(channel, payload)
}

func decodeTypedMappedPayload(channel core.Channel, payload []byte) ([]byte, error) {
	mapper, err := mapperForChannel(channel)
	if err != nil {
		return nil, err
	}
	return mapper.ROS2CDRToProto(channel, payload)
}

func mapperForChannel(channel core.Channel) (TypedMapper, error) {
	key := mapperKey(channel)
	typedMapperRegistry.RLock()
	mapper := typedMapperRegistry.entries[key]
	typedMapperRegistry.RUnlock()
	if mapper == nil {
		return nil, fmt.Errorf("ROS2 typed mapper %s is not registered; register a mapper for schema.type + ros_message_type/ros_service_type or use adapter: ros2_proto_envelope", key)
	}
	return mapper, nil
}

func mapperKey(channel core.Channel) string {
	if channel.Metadata == nil {
		return normalizeMapperKey("", channel.MessageType)
	}
	schemaType := firstNonEmptyString(channel.Metadata["schema.type"], channel.Metadata["protobuf.type"], channel.MessageType)
	ros2Type := firstNonEmptyString(
		channel.Metadata["ros_message_type"],
		channel.Metadata["ros_service_type"],
		channel.Metadata["ros2.message_type"],
		channel.Metadata["ros2.service_type"],
		channel.MessageType,
	)
	return normalizeMapperKey(schemaType, ros2Type)
}

func normalizeMapperKey(schemaType string, ros2Type string) string {
	schemaType = strings.TrimSpace(schemaType)
	ros2Type = strings.TrimSpace(ros2Type)
	if schemaType == "" && ros2Type == "" {
		return ""
	}
	return schemaType + "=>" + ros2Type
}
