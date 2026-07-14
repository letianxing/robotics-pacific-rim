package inframetric

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

const (
	ModuleHealth   = "pacific_rim.module.health"
	ModuleRestarts = "pacific_rim.module.restarts"
	MessageLatency = "pacific_rim.message.latency"
	MessageCount   = "pacific_rim.message.count"
)

func Counter(name string) (metric.Int64Counter, error) {
	return otel.Meter("pacific-rim").Int64Counter(name)
}

func Add(ctx context.Context, counter metric.Int64Counter, value int64) {
	counter.Add(ctx, value)
}
