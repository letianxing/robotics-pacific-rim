package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"

	commbootstrap "github.com/pacific-rim/pacific-rim/infra/communication/go/bootstrap"
	generatedapi "github.com/pacific-rim/pacific-rim/module/service/middleware_pub_test_service/internal/api/generated"
	"github.com/pacific-rim/pacific-rim/module/service/middleware_pub_test_service/internal/service"
)

func main() {
	configPath := flag.String("config", envOrDefault("PACIFIC_RIM_CONFIG", "config/config.yaml"), "service config path")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	runtime, err := commbootstrap.BootstrapCommunication(ctx, *configPath, "middleware_pub_test_service")
	if err != nil {
		log.Fatalf("start communication: %v", err)
	}
	defer func() {
		if err := runtime.Close(context.Background()); err != nil {
			log.Printf("close communication: %v", err)
		}
	}()

	if err := generatedapi.RegisterGeneratedInterfaces(ctx, runtime); err != nil {
		log.Fatalf("register generated interfaces: %v", err)
	}

	app := service.New(runtime)
	if err := app.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatalf("run middleware_pub_test: %v", err)
	}
}

func envOrDefault(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
