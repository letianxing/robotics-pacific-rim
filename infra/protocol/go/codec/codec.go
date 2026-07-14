package codec

import (
	"encoding/json"
	"errors"

	"google.golang.org/protobuf/proto"
)

type Codec[T any] interface {
	ContentType() string
	Encode(T) ([]byte, error)
	Decode([]byte) (T, error)
}

type RawBytesCodec struct{}

func (RawBytesCodec) ContentType() string {
	return "application/octet-stream"
}

func (RawBytesCodec) Encode(value []byte) ([]byte, error) {
	return append([]byte(nil), value...), nil
}

func (RawBytesCodec) Decode(data []byte) ([]byte, error) {
	return append([]byte(nil), data...), nil
}

type JSONCodec[T any] struct{}

func (JSONCodec[T]) ContentType() string {
	return "application/json"
}

func (JSONCodec[T]) Encode(value T) ([]byte, error) {
	return json.Marshal(value)
}

func (JSONCodec[T]) Decode(data []byte) (T, error) {
	var value T
	err := json.Unmarshal(data, &value)
	return value, err
}

type ProtobufCodec[T proto.Message] struct {
	New func() T
}

func (ProtobufCodec[T]) ContentType() string {
	return "application/protobuf"
}

func (ProtobufCodec[T]) Encode(value T) ([]byte, error) {
	return proto.Marshal(value)
}

func (codec ProtobufCodec[T]) Decode(data []byte) (T, error) {
	var zero T
	if codec.New == nil {
		return zero, errors.New("protobuf codec requires New")
	}
	value := codec.New()
	err := proto.Unmarshal(data, value)
	return value, err
}
