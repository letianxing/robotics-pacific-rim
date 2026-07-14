import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";

const defaultTracerName = "pacific-rim";

export type TraceOptions = SpanOptions & {
  tracerName?: string;
  tracerVersion?: string;
};

export type ActiveTraceIds = {
  spanId?: string;
  traceFlags?: number;
  traceId?: string;
};

export function getTracer(name = defaultTracerName, version?: string): Tracer {
  return trace.getTracer(name, version);
}

export function startSpan(
  name: string,
  options: TraceOptions = {},
  ctx: Context = context.active(),
): Span {
  return getTracer(options.tracerName, options.tracerVersion).startSpan(name, options, ctx);
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => T | Promise<T>,
  options: TraceOptions = {},
): Promise<T> {
  const tracer = getTracer(options.tracerName, options.tracerVersion);

  return tracer.startActiveSpan(name, options, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function injectTraceContext<TCarrier extends Record<string, unknown>>(carrier: TCarrier): TCarrier {
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function extractTraceContext<TCarrier extends Record<string, unknown>>(carrier: TCarrier): Context {
  return propagation.extract(context.active(), carrier);
}

export function getActiveTraceIds(): ActiveTraceIds {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();

  if (!spanContext) {
    return {};
  }

  return {
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    traceId: spanContext.traceId,
  };
}

export { SpanStatusCode, context, propagation, trace };
