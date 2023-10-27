import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  ParentBasedSampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { B3InjectEncoding, B3Propagator } from '@opentelemetry/propagator-b3';
import { PROM_PARAMS, TRACING_PARAMS, WORKER } from '@taql/config';
import promClient, { AggregatorRegistry } from 'prom-client';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { DataloaderInstrumentation } from '@opentelemetry/instrumentation-dataloader';
import { DnsInstrumentation } from '@opentelemetry/instrumentation-dns';
import { FsInstrumentation } from '@opentelemetry/instrumentation-fs';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { KoaInstrumentation } from '@opentelemetry/instrumentation-koa';
import { NetInstrumentation } from '@opentelemetry/instrumentation-net';
import type { ParameterizedContext } from 'koa';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { WinstonInstrumentation } from '@opentelemetry/instrumentation-winston';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import { performance } from 'perf_hooks';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

export { useOpenTelemetry } from './useOpenTelemetry';
export { usePreconfiguredPrometheus as usePrometheus } from './usePrometheus';

const prometheusRegistry = new AggregatorRegistry();
const { prefix } = PROM_PARAMS;
const labels = { worker: WORKER };
// Set up memory monitoring
// The defaults includes valuable metrics including heap allocation, available memory.
// ex:
// taql_nodejs_heap_space_size_available_bytes{space="..."}
// taql_nodejs_heap_space_size_used_bytes{space="..."}
// taql_nodejs_gc_duration_seconds_sum{kind="..."}
promClient.collectDefaultMetrics({ prefix, labels });
// end: memory monitoring

export const useMetricsEndpoint = async (
  ctx: ParameterizedContext,
  next: () => Promise<unknown>
) => {
  if (ctx.request.method === 'GET' && ctx.request.path === '/metrics') {
    try {
      const primaryMetrics = await promClient.register.metrics();
      const clusterMetrics = await prometheusRegistry.clusterMetrics();
      ctx.set('Content-Type', prometheusRegistry.contentType);
      ctx.body = [primaryMetrics, clusterMetrics].join('\n');
      ctx.status = 200;
    } catch (err) {
      ctx.status = 500;
      ctx.body = err;
    }
  } else {
    await next();
  }
};

export const createHttpTrackingMiddleware = (options: {
  promPrefix?: string;
  logger?: {
    error: (msg: string) => void;
    info: (msg: string) => void;
  };
}) => {
  const { promPrefix = prefix, logger } = options;

  const labelNames = ['statusCode', 'path', 'client'];

  const HTTP_RESPONSE_COUNTER = new promClient.Counter({
    name: `${promPrefix}http_response`,
    help: 'http responses by response code',
    labelNames,
  });

  const HTTP_RESPONSE_SUMMARY_COUNTER = new promClient.Counter({
    name: `${promPrefix}http_response_summary`,
    help: 'summary of http responses',
    labelNames,
  });

  // Request duration is recorded in ms, so default buckets are unsuitable.
  // The default buckets are [.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, +Inf]
  const durationBucketsMs = [10, 25, 50, 75, 100, 150, 200, 500, 1000, 2000];

  const HTTP_REQUEST_DURATION_HISTOGRAM = new promClient.Histogram({
    name: `${promPrefix}http_duration_ms`,
    help: 'Time (ms) spent on HTTP connection',
    labelNames,
    buckets: durationBucketsMs,
  });

  // Buckets for request/response sizes
  const defaultSizeBytesBuckets = promClient.exponentialBuckets(25, 5, 7);
  const payloadSizeLabels = ['method', 'path', 'statusCode'];

  const requestSizeMetric = new promClient.Histogram({
    name: `${promPrefix}request_size_bytes`,
    help: 'Size of HTTP requests in bytes',
    labelNames: payloadSizeLabels,
    buckets: defaultSizeBytesBuckets,
  });

  const responseSizeMetric = new promClient.Histogram({
    name: `${promPrefix}response_size_bytes`,
    help: 'Size of HTTP responses in bytes',
    labelNames: payloadSizeLabels,
    buckets: defaultSizeBytesBuckets,
  });

  return async function useHttpTracking(
    ctx: ParameterizedContext,
    next: () => Promise<void>
  ) {
    const start = performance.now();
    await next();
    const duration = performance.now() - start;
    const path = ctx.request.path;
    const client =
      (ctx.request.header['x-app-name'] as string) ||
      ctx.request.header['user-agent'] ||
      'unknown';
    if (ctx.status) {
      const statusCode = ctx.status.toString();
      HTTP_RESPONSE_COUNTER.inc({ statusCode, path, client });
      HTTP_REQUEST_DURATION_HISTOGRAM.observe(
        { statusCode, path, client },
        duration
      );

      const statusBucket = statusCode.slice(0, 1);
      HTTP_RESPONSE_SUMMARY_COUNTER.inc({
        statusCode: `${statusBucket}xx`,
        client,
        path,
      });

      // Capture metrics for request and response sizes.
      const labels = {
        method: ctx.request.method,
        path: ctx.request.path,
        statusCode: ctx.status,
      };
      requestSizeMetric.observe(labels, ctx.request.length || 0);
      responseSizeMetric.observe(labels, ctx.response.length || 0);
    } else {
      logger?.error(
        'useHttpStatusTracking: no status on context! Is this middleware applied properly?'
      );
    }
  };
};

export const tracerProvider = new NodeTracerProvider({
  resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: 'taql' }),
  sampler: new ParentBasedSampler({
    root: TRACING_PARAMS.alwaysSample
      ? new AlwaysOnSampler()
      : new AlwaysOffSampler(),
  }),
});

tracerProvider.register({
  propagator: new B3Propagator({
    injectEncoding: B3InjectEncoding.MULTI_HEADER,
  }),
});

if (TRACING_PARAMS.zipkinUrl) {
  const zipkinExporter = new ZipkinExporter({
    serviceName: 'taql',
    url: TRACING_PARAMS.zipkinUrl,
  });
  tracerProvider.addSpanProcessor(
    TRACING_PARAMS.useBatchingProcessor
      ? new BatchSpanProcessor(zipkinExporter)
      : new SimpleSpanProcessor(zipkinExporter)
  );
} else {
  tracerProvider.addSpanProcessor(
    new SimpleSpanProcessor(new ConsoleSpanExporter())
  );
}

registerInstrumentations({
  instrumentations: [
    new AwsInstrumentation(),
    new DataloaderInstrumentation({ requireParentSpan: true }),
    new DnsInstrumentation(),
    new FsInstrumentation({ requireParentSpan: true }),
    new HttpInstrumentation({
      requireParentforIncomingSpans: true,
      requireParentforOutgoingSpans: true,
    }),
    new IORedisInstrumentation({ requireParentSpan: true }),
    new KoaInstrumentation(),
    new NetInstrumentation(),
    new PgInstrumentation({ requireParentSpan: true }),
    new WinstonInstrumentation(),
  ],
  tracerProvider,
});
