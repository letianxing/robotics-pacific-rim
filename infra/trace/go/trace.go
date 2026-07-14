package infratrace

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

func StartSpan(ctx context.Context, name string) (context.Context, trace.Span) {
	return otel.Tracer("pacific-rim").Start(ctx, name)
}

func ActiveTraceIDs(span trace.Span) map[string]string {
	spanContext := span.SpanContext()
	if !spanContext.IsValid() {
		return map[string]string{}
	}
	return map[string]string{
		"traceId": spanContext.TraceID().String(),
		"spanId":  spanContext.SpanID().String(),
	}
}
