package contracts

type TransportKind string

const (
	TransportInProcess  TransportKind = "in_process"
	TransportROS2       TransportKind = "ros2"
	TransportNATS       TransportKind = "nats"
	TransportCycloneDDS TransportKind = "cyclonedds"
	TransportFastDDS    TransportKind = "fastdds"
	TransportZenoh      TransportKind = "zenoh"
	TransportGRPC       TransportKind = "grpc"
	TransportMQTT       TransportKind = "mqtt"
)

type BridgeDirection string

const (
	BridgeSourceToTarget BridgeDirection = "source_to_target"
	BridgeTargetToSource BridgeDirection = "target_to_source"
	BridgeBidirectional  BridgeDirection = "bidirectional"
)

type MiddlewareConfig struct {
	Transport TransportKind  `json:"transport" yaml:"transport"`
	Name      string         `json:"name,omitempty" yaml:"name,omitempty"`
	Options   map[string]any `json:"options,omitempty" yaml:"options,omitempty"`
}

type Endpoint struct {
	Transport   TransportKind     `json:"transport" yaml:"transport"`
	Address     string            `json:"address" yaml:"address"`
	MessageType string            `json:"message_type,omitempty" yaml:"message_type,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty" yaml:"metadata,omitempty"`
}

type Message struct {
	MessageType string         `json:"message_type" yaml:"message_type"`
	Payload     map[string]any `json:"payload" yaml:"payload"`
	Metadata    map[string]any `json:"metadata,omitempty" yaml:"metadata,omitempty"`
}

type Envelope struct {
	Source            string  `json:"source" yaml:"source"`
	Message           Message `json:"message" yaml:"message"`
	TraceID           string  `json:"trace_id,omitempty" yaml:"trace_id,omitempty"`
	PayloadSHA256     string  `json:"payload_sha256,omitempty" yaml:"payload_sha256,omitempty"`
	PublishedAtUnixMS int64   `json:"published_at_unix_ms,omitempty" yaml:"published_at_unix_ms,omitempty"`
}

type PubSubRoute struct {
	Name       string   `json:"name" yaml:"name"`
	Publisher  Endpoint `json:"publisher" yaml:"publisher"`
	Subscriber Endpoint `json:"subscriber" yaml:"subscriber"`
	QueueSize  int      `json:"queue_size,omitempty" yaml:"queue_size,omitempty"`
	Enabled    bool     `json:"enabled" yaml:"enabled"`
}

type RPCRoute struct {
	Name      string   `json:"name" yaml:"name"`
	Client    Endpoint `json:"client" yaml:"client"`
	Server    Endpoint `json:"server" yaml:"server"`
	TimeoutMS int      `json:"timeout_ms,omitempty" yaml:"timeout_ms,omitempty"`
	Enabled   bool     `json:"enabled" yaml:"enabled"`
}

type BridgeRule struct {
	Name       string          `json:"name" yaml:"name"`
	Source     Endpoint        `json:"source" yaml:"source"`
	Target     Endpoint        `json:"target" yaml:"target"`
	Direction  BridgeDirection `json:"direction" yaml:"direction"`
	QueueSize  int             `json:"queue_size,omitempty" yaml:"queue_size,omitempty"`
	QueueGroup string          `json:"queue_group,omitempty" yaml:"queue_group,omitempty"`
	Enabled    bool            `json:"enabled" yaml:"enabled"`
}
