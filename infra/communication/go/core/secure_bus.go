package core

import (
	"context"
	"time"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
)

type SecureMessageBus struct {
	inner MessageBus
	codec *SecurityCodec
}

func NewSecureMessageBus(inner MessageBus, binding SecurityBinding) (*SecureMessageBus, error) {
	codec, err := NewSecurityCodec(binding)
	if err != nil {
		return nil, err
	}
	return &SecureMessageBus{inner: inner, codec: codec}, nil
}

func (b *SecureMessageBus) Kind() communication.TransportKind {
	return b.inner.Kind()
}

func (b *SecureMessageBus) Capabilities() Capabilities {
	return b.inner.Capabilities()
}

func (b *SecureMessageBus) Connect(ctx context.Context) error {
	return b.inner.Connect(ctx)
}

func (b *SecureMessageBus) Close(ctx context.Context) error {
	return b.inner.Close(ctx)
}

func (b *SecureMessageBus) Publish(ctx context.Context, channel Channel, payload []byte) error {
	encrypted, err := b.codec.Encrypt(payload, "publish")
	if err != nil {
		return err
	}
	return b.inner.Publish(ctx, channel, encrypted)
}

func (b *SecureMessageBus) Subscribe(ctx context.Context, channel Channel, handler BytesHandler) error {
	return b.inner.Subscribe(ctx, channel, func(ctx context.Context, payload []byte) error {
		plaintext, err := b.codec.Decrypt(payload, "publish")
		if err != nil {
			return err
		}
		return handler(ctx, plaintext)
	})
}

func (b *SecureMessageBus) Request(
	ctx context.Context,
	channel Channel,
	payload []byte,
	timeout time.Duration,
) ([]byte, error) {
	encryptedRequest, err := b.codec.Encrypt(payload, "rpc_request")
	if err != nil {
		return nil, err
	}
	encryptedResponse, err := b.inner.Request(ctx, channel, encryptedRequest, timeout)
	if err != nil {
		return nil, err
	}
	return b.codec.Decrypt(encryptedResponse, "rpc_response")
}

func (b *SecureMessageBus) HandleRequest(ctx context.Context, channel Channel, handler RequestHandler) error {
	return b.inner.HandleRequest(ctx, channel, func(ctx context.Context, encryptedRequest []byte) ([]byte, error) {
		request, err := b.codec.Decrypt(encryptedRequest, "rpc_request")
		if err != nil {
			return nil, err
		}
		response, err := handler(ctx, request)
		if err != nil {
			return nil, err
		}
		return b.codec.Encrypt(response, "rpc_response")
	})
}
