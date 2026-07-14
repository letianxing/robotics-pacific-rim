package nats

import (
	"context"
	"fmt"
	"time"

	gonats "github.com/nats-io/nats.go"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/core"
)

type NativeByteClient struct {
	config NATSConfig
	conn   *gonats.Conn
}

func NewNativeByteClient(config NATSConfig) (*NativeByteClient, error) {
	return &NativeByteClient{config: config}, nil
}

func RegisterNativeBus() {
	Register(func(config NATSConfig) (ByteClient, error) {
		return NewNativeByteClient(config)
	})
}

func (c *NativeByteClient) Connect(context.Context) error {
	timeout := time.Duration(c.config.ConnectTimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	options := []gonats.Option{
		gonats.Name(c.config.Name),
		gonats.Timeout(timeout),
		gonats.MaxReconnects(c.config.MaxReconnectAttempts),
	}
	reconnectWait := time.Duration(c.config.ReconnectWaitMS) * time.Millisecond
	if reconnectWait > 0 {
		options = append(options, gonats.ReconnectWait(reconnectWait))
	}
	conn, err := gonats.Connect(c.config.ServerURL, options...)
	if err != nil {
		return err
	}
	c.conn = conn
	return nil
}

func (c *NativeByteClient) Close(context.Context) error {
	if c == nil || c.conn == nil {
		return nil
	}
	c.conn.Drain()
	c.conn.Close()
	return nil
}

func (c *NativeByteClient) Publish(ctx context.Context, subject string, payload []byte) error {
	if c == nil || c.conn == nil {
		return fmt.Errorf("nats byte client is not connected")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return c.conn.Publish(subject, payload)
}

func (c *NativeByteClient) Subscribe(
	ctx context.Context,
	subject string,
	queueGroup string,
	handler ByteHandler,
) error {
	if c == nil || c.conn == nil {
		return fmt.Errorf("nats byte client is not connected")
	}
	callback := func(msg *gonats.Msg) {
		_ = handler(ctx, msg.Data)
	}
	if queueGroup != "" {
		_, err := c.conn.QueueSubscribe(subject, queueGroup, callback)
		return err
	}
	_, err := c.conn.Subscribe(subject, callback)
	return err
}

func (c *NativeByteClient) HandleRequest(
	ctx context.Context,
	subject string,
	queueGroup string,
	handler core.RequestHandler,
) error {
	if c == nil || c.conn == nil {
		return fmt.Errorf("nats byte client is not connected")
	}
	callback := func(msg *gonats.Msg) {
		response, err := handler(ctx, msg.Data)
		if err != nil || msg.Reply == "" {
			return
		}
		_ = c.conn.Publish(msg.Reply, response)
	}
	if queueGroup != "" {
		_, err := c.conn.QueueSubscribe(subject, queueGroup, callback)
		return err
	}
	_, err := c.conn.Subscribe(subject, callback)
	return err
}

func (c *NativeByteClient) Request(
	ctx context.Context,
	subject string,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	if c == nil || c.conn == nil {
		return nil, fmt.Errorf("nats byte client is not connected")
	}
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	msg, err := c.conn.RequestWithContext(reqCtx, subject, payload)
	if err != nil {
		return nil, err
	}
	return msg.Data, nil
}
