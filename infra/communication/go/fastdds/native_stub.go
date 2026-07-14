//go:build !pacific_rim_fastdds

package fastdds

import (
	"context"
	"fmt"

	communication "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	"github.com/pacific-rim/pacific-rim/infra/communication/go/dds"
)

type NativeByteClient struct{}

func NewNativeByteClient(dds.CycloneDDSConfig) (*NativeByteClient, error) {
	return &NativeByteClient{}, nil
}

func (c *NativeByteClient) Connect(context.Context, dds.CycloneDDSConfig) error {
	return fmt.Errorf("native Fast DDS Go backend is not linked; build with -tags pacific_rim_fastdds for proto/native Fast DDS routes")
}

func (c *NativeByteClient) Close(context.Context) error { return nil }

func (c *NativeByteClient) PreparePublish(context.Context, dds.TopicConfig) error {
	return fmt.Errorf("native Fast DDS Go backend is not linked; build with -tags pacific_rim_fastdds for proto/native Fast DDS routes")
}

func (c *NativeByteClient) Publish(context.Context, dds.TopicConfig, []byte) error {
	return fmt.Errorf("native Fast DDS Go backend is not linked; build with -tags pacific_rim_fastdds for proto/native Fast DDS routes")
}

func (c *NativeByteClient) Subscribe(context.Context, dds.Subscription, dds.ByteHandler) error {
	return fmt.Errorf("native Fast DDS Go backend is not linked; build with -tags pacific_rim_fastdds for proto/native Fast DDS routes")
}

func (c *NativeByteClient) SubscribeManaged(context.Context, dds.Subscription, dds.ByteHandler) (func(), error) {
	return nil, fmt.Errorf("native Fast DDS Go backend is not linked; build with -tags pacific_rim_fastdds for proto/native Fast DDS routes")
}

func RegisterNativeBus() {
	topicRPC := &dds.TopicRPCAdapter{}
	dds.RegisterWithKindAndRPCAdapters(
		communication.TransportFastDDS,
		func(config dds.CycloneDDSConfig) (dds.ByteClient, error) {
			return NewNativeByteClient(config)
		},
		map[string]dds.RPCAdapter{
			"omg_dds_rpc": topicRPC,
		},
	)
}
