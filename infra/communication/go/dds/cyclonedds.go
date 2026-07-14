package dds

import (
	"context"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

type CycloneDDSConfig struct {
	DomainID        int     `json:"domain_id" yaml:"domain_id"`
	ParticipantName string  `json:"participant_name" yaml:"participant_name"`
	ConfigURI       string  `json:"config_uri,omitempty" yaml:"config_uri,omitempty"`
	ReadPeriodSec   float64 `json:"read_period_sec,omitempty" yaml:"read_period_sec,omitempty"`
}

type TopicConfig struct {
	TopicName string            `json:"topic_name" yaml:"topic_name"`
	TypeName  string            `json:"type_name,omitempty" yaml:"type_name,omitempty"`
	QoS       map[string]string `json:"qos,omitempty" yaml:"qos,omitempty"`
}

type Subscription struct {
	Topic TopicConfig `json:"topic" yaml:"topic"`
}

type RPCBinding struct {
	Standard        string      `json:"standard" yaml:"standard"`
	RequestChannel  TopicConfig `json:"request_channel" yaml:"request_channel"`
	ResponseChannel TopicConfig `json:"response_channel" yaml:"response_channel"`
}

type RPCAdapter interface {
	Request(ctx context.Context, binding RPCBinding, payload []byte, timeout time.Duration) ([]byte, error)
	HandleRequest(ctx context.Context, binding RPCBinding, handler func(context.Context, []byte) ([]byte, error)) error
}

type ClientRPCAdapter interface {
	RPCAdapter
	RequestWithClient(ctx context.Context, client ByteClient, binding RPCBinding, payload []byte, timeout time.Duration) ([]byte, error)
	HandleRequestWithClient(ctx context.Context, client ByteClient, binding RPCBinding, handler func(context.Context, []byte) ([]byte, error)) error
}

type MessageHandler func(communication.Message)

type CycloneDDSClient interface {
	Connect(config CycloneDDSConfig) error
	Close() error
	Publish(topic TopicConfig, message communication.Message) error
	Subscribe(subscription Subscription, handler MessageHandler) error
}

func DefaultConfig() CycloneDDSConfig {
	return CycloneDDSConfig{
		DomainID:        0,
		ParticipantName: "pacific-rim",
	}
}

func DefaultTopic(topicName string) TopicConfig {
	return TopicConfig{
		TopicName: topicName,
		TypeName:  "PacificRimMessageEnvelope",
	}
}
