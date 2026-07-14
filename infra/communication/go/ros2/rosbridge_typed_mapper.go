package ros2

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

type RosbridgeTypedMapper interface {
	ProtoToROS2JSON(channel core.Channel, payload []byte) (json.RawMessage, error)
	ROS2JSONToProto(channel core.Channel, payload json.RawMessage) ([]byte, error)
}

type RosbridgeTypedMapperFunc struct {
	ProtoToROS2JSONFunc func(core.Channel, []byte) (json.RawMessage, error)
	ROS2JSONToProtoFunc func(core.Channel, json.RawMessage) ([]byte, error)
}

func (m RosbridgeTypedMapperFunc) ProtoToROS2JSON(channel core.Channel, payload []byte) (json.RawMessage, error) {
	if m.ProtoToROS2JSONFunc == nil {
		return nil, fmt.Errorf("ROS2 rosbridge typed mapper has no proto-to-ROS2 JSON mapping for %s", mapperKey(channel))
	}
	return m.ProtoToROS2JSONFunc(channel, payload)
}

func (m RosbridgeTypedMapperFunc) ROS2JSONToProto(channel core.Channel, payload json.RawMessage) ([]byte, error) {
	if m.ROS2JSONToProtoFunc == nil {
		return nil, fmt.Errorf("ROS2 rosbridge typed mapper has no ROS2 JSON-to-proto mapping for %s", mapperKey(channel))
	}
	return m.ROS2JSONToProtoFunc(channel, payload)
}

var rosbridgeTypedMapperRegistry = struct {
	sync.RWMutex
	entries map[string]RosbridgeTypedMapper
}{entries: map[string]RosbridgeTypedMapper{}}

func RegisterRosbridgeTypedMapper(schemaType string, ros2Type string, mapper RosbridgeTypedMapper) {
	key := normalizeMapperKey(schemaType, ros2Type)
	if key == "" || mapper == nil {
		return
	}
	rosbridgeTypedMapperRegistry.Lock()
	defer rosbridgeTypedMapperRegistry.Unlock()
	rosbridgeTypedMapperRegistry.entries[key] = mapper
}

func encodeRosbridgeTypedMappedPayload(channel core.Channel, payload []byte) (json.RawMessage, error) {
	mapper, err := rosbridgeMapperForChannel(channel)
	if err != nil {
		return nil, err
	}
	return mapper.ProtoToROS2JSON(channel, payload)
}

func decodeRosbridgeTypedMappedPayload(channel core.Channel, payload json.RawMessage) ([]byte, error) {
	mapper, err := rosbridgeMapperForChannel(channel)
	if err != nil {
		return nil, err
	}
	return mapper.ROS2JSONToProto(channel, payload)
}

func rosbridgeMapperForChannel(channel core.Channel) (RosbridgeTypedMapper, error) {
	key := mapperKey(channel)
	rosbridgeTypedMapperRegistry.RLock()
	mapper := rosbridgeTypedMapperRegistry.entries[key]
	rosbridgeTypedMapperRegistry.RUnlock()
	if mapper == nil {
		return nil, fmt.Errorf("ROS2 rosbridge typed mapper %s is not registered; register a Proto <-> ROS2 JSON mapper or use adapter: ros2_proto_envelope", key)
	}
	return mapper, nil
}
