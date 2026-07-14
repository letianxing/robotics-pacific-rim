package otelsetup

import (
	"context"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	logglobal "go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.37.0"
)

type Handle struct {
	LoggerProvider *log.LoggerProvider
	MeterProvider  *metric.MeterProvider
	TracerProvider *sdktrace.TracerProvider
}

func Init(ctx context.Context, serviceName string) (*Handle, error) {
	endpoint, insecure := exporterEndpoint(defaultEndpoint())
	res, err := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName(serviceName)),
	)
	if err != nil {
		return nil, err
	}

	traceOptions := []otlptracehttp.Option{otlptracehttp.WithEndpoint(endpoint)}
	if insecure {
		traceOptions = append(traceOptions, otlptracehttp.WithInsecure())
	}
	traceExporter, err := otlptracehttp.New(ctx, traceOptions...)
	if err != nil {
		return nil, err
	}
	tracerProvider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tracerProvider)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	metricOptions := []otlpmetrichttp.Option{otlpmetrichttp.WithEndpoint(endpoint)}
	if insecure {
		metricOptions = append(metricOptions, otlpmetrichttp.WithInsecure())
	}
	metricExporter, err := otlpmetrichttp.New(ctx, metricOptions...)
	if err != nil {
		return nil, err
	}
	meterProvider := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(metricExporter, metric.WithInterval(time.Second))),
		metric.WithResource(res),
	)
	otel.SetMeterProvider(meterProvider)

	logOptions := []otlploghttp.Option{otlploghttp.WithEndpoint(endpoint)}
	if insecure {
		logOptions = append(logOptions, otlploghttp.WithInsecure())
	}
	logExporter, err := otlploghttp.New(ctx, logOptions...)
	if err != nil {
		return nil, err
	}
	loggerProvider := log.NewLoggerProvider(
		log.WithProcessor(log.NewBatchProcessor(logExporter)),
		log.WithResource(res),
	)
	logglobal.SetLoggerProvider(loggerProvider)

	return &Handle{
		LoggerProvider: loggerProvider,
		MeterProvider:  meterProvider,
		TracerProvider: tracerProvider,
	}, nil
}

func (h *Handle) Shutdown(ctx context.Context) error {
	if err := h.TracerProvider.Shutdown(ctx); err != nil {
		return err
	}
	if err := h.MeterProvider.Shutdown(ctx); err != nil {
		return err
	}
	return h.LoggerProvider.Shutdown(ctx)
}

func defaultEndpoint() string {
	if value := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"); value != "" {
		return value
	}
	return "http://otel-collector:4318"
}

func exporterEndpoint(endpoint string) (string, bool) {
	if strings.HasPrefix(endpoint, "https://") {
		return strings.TrimPrefix(endpoint, "https://"), false
	}
	if strings.HasPrefix(endpoint, "http://") {
		return strings.TrimPrefix(endpoint, "http://"), true
	}
	return endpoint, true
}
