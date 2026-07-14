package main

import (
	"context"
	"fmt"
	"os"
	"time"

	contracts "github.com/pacific-rim/pacific-rim/infra/communication/go/contracts"
	core "github.com/pacific-rim/pacific-rim/infra/communication/go/core"
	natsbus "github.com/pacific-rim/pacific-rim/infra/communication/go/nats"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	serverURL := os.Getenv("PR_NATS_URL")
	if serverURL == "" {
		serverURL = "nats://127.0.0.1:4222"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	natsbus.RegisterNativeBus()
	config := core.BusConfig{
		Transport: contracts.TransportNATS,
		Options:   map[string]any{"server_url": serverURL},
	}
	pub, err := core.NewBus(config)
	must(err)
	sub, err := core.NewBus(config)
	must(err)
	must(pub.Connect(ctx))
	defer pub.Close(context.Background())
	must(sub.Connect(ctx))
	defer sub.Close(context.Background())

	topic := core.Channel{Name: "pr.smoke.nats.topic"}
	received := make(chan string, 1)
	must(sub.Subscribe(ctx, topic, func(_ context.Context, payload []byte) error {
		received <- string(payload)
		return nil
	}))
	for i := 0; i < 20; i++ {
		must(pub.Publish(ctx, topic, []byte("ping")))
		select {
		case got := <-received:
			fmt.Println("PASS nats go pubsub:", got)
			goto rpc
		case <-time.After(100 * time.Millisecond):
		}
	}
	panic("nats go pubsub timeout")

rpc:
	service := core.Channel{Name: "pr.smoke.nats.rpc"}
	must(sub.HandleRequest(ctx, service, func(_ context.Context, payload []byte) ([]byte, error) {
		return []byte("go:" + string(payload)), nil
	}))
	time.Sleep(200 * time.Millisecond)
	response, err := pub.Request(ctx, service, []byte("ping"), 3*time.Second)
	must(err)
	fmt.Println("PASS nats go rpc:", string(response))
}
