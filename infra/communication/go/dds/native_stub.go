//go:build !pacific_rim_cyclonedds

package dds

import (
	"context"
	"fmt"
)

type NativeByteClient struct {
	config CycloneDDSConfig
}

func NewNativeByteClient(config CycloneDDSConfig) (*NativeByteClient, error) {
	return &NativeByteClient{config: config}, nil
}

func (c *NativeByteClient) Connect(context.Context, CycloneDDSConfig) error {
	return fmt.Errorf(
		"cyclonedds native Go backend is not enabled; rebuild with CGO_ENABLED=1 -tags pacific_rim_cyclonedds and install the CycloneDDS C runtime/development package",
	)
}

func (c *NativeByteClient) Close(context.Context) error {
	return nil
}

func (c *NativeByteClient) PreparePublish(context.Context, TopicConfig) error {
	return fmt.Errorf("cyclonedds native Go backend is not connected")
}

func (c *NativeByteClient) Publish(context.Context, TopicConfig, []byte) error {
	return fmt.Errorf("cyclonedds native Go backend is not connected")
}

func (c *NativeByteClient) Subscribe(context.Context, Subscription, ByteHandler) error {
	return fmt.Errorf("cyclonedds native Go backend is not connected")
}

func (c *NativeByteClient) SubscribeManaged(context.Context, Subscription, ByteHandler) (func(), error) {
	return nil, fmt.Errorf("cyclonedds native Go backend is not connected")
}
