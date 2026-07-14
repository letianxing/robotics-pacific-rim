package nats

import pkg "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"

type NATSConfig struct {
	ServerURL            string `json:"server_url" yaml:"server_url"`
	Name                 string `json:"name" yaml:"name"`
	ConnectTimeoutMS     int    `json:"connect_timeout_ms" yaml:"connect_timeout_ms"`
	ReconnectWaitMS      int    `json:"reconnect_wait_ms" yaml:"reconnect_wait_ms"`
	MaxReconnectAttempts int    `json:"max_reconnect_attempts" yaml:"max_reconnect_attempts"`
}

type NATSClient interface {
	Connect() error
	Close() error
	Publish(subject string, message pkg.Message) error
	Subscribe(subject string, queueGroup string, handler func(pkg.Message) error) error
	Request(subject string, message pkg.Message, timeoutMS int) (pkg.Message, error)
}
