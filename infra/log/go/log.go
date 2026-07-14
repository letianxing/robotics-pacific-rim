package infralog

import (
	"context"
	"log/slog"
	"time"

	otellog "go.opentelemetry.io/otel/log"
	logglobal "go.opentelemetry.io/otel/log/global"
)

func Info(ctx context.Context, message string, attributes map[string]string) {
	Emit(ctx, otellog.SeverityInfo, "INFO", message, attributes)
}

func Warn(ctx context.Context, message string, attributes map[string]string) {
	Emit(ctx, otellog.SeverityWarn, "WARN", message, attributes)
}

func Error(ctx context.Context, message string, attributes map[string]string) {
	Emit(ctx, otellog.SeverityError, "ERROR", message, attributes)
}

func Emit(ctx context.Context, severity otellog.Severity, severityText string, message string, attributes map[string]string) {
	args := make([]any, 0, len(attributes)*2)
	for key, value := range attributes {
		args = append(args, key, value)
	}

	switch {
	case severity >= otellog.SeverityError:
		slog.ErrorContext(ctx, message, args...)
	case severity >= otellog.SeverityWarn:
		slog.WarnContext(ctx, message, args...)
	default:
		slog.InfoContext(ctx, message, args...)
	}

	now := time.Now()
	var record otellog.Record
	record.SetTimestamp(now)
	record.SetObservedTimestamp(now)
	record.SetSeverity(severity)
	record.SetSeverityText(severityText)
	record.SetBody(otellog.StringValue(message))
	for key, value := range attributes {
		record.AddAttributes(otellog.String(key, value))
	}
	logglobal.Logger("pacific-rim").Emit(ctx, record)
}
