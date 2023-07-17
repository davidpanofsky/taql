import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { B3InjectEncoding, B3Propagator } from '@opentelemetry/propagator-b3';
import { PROM_PARAMS, TRACING_PARAMS, WORKER } from '@taql/config';
import promClient, { AggregatorRegistry } from 'prom-client';
import type { ParameterizedContext } from 'koa';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import { performance } from 'perf_hooks';

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

export const useMetricsEndpoint = async (ctx: ParameterizedContext) => {
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
  }
};

export const useHttpStatusTracking = (options: {
  promPrefix?: string;
  logger?: {
    error: (msg: string) => void;
    info: (msg: string) => void;
  };
}) => {
  const { promPrefix = prefix, logger } = options;
  logger?.info('useHttpStatusTracking: Initializing');

  const labelNames = ['statusCode', 'path'];

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

  const HTTP_REQUEST_DURATION_HISTOGRAM = new promClient.Histogram({
    name: `${promPrefix}http_duration_ms`,
    help: 'Time (ms) spent on HTTP connection',
    labelNames,
  });

  return async (ctx: ParameterizedContext, next: () => Promise<void>) => {
    const start = performance.now();
    await next();
    const duration = performance.now() - start;
    const path = ctx.request.path;
    if (ctx.status) {
      const statusCode = ctx.status.toString();
      HTTP_RESPONSE_COUNTER.inc({ statusCode, path });
      HTTP_REQUEST_DURATION_HISTOGRAM.observe({ statusCode, path }, duration);

      const statusBucket = statusCode.slice(0, 1);
      HTTP_RESPONSE_SUMMARY_COUNTER.inc({
        statusCode: `${statusBucket}xx`,
        path,
      });
    } else {
      logger?.error(
        'useHttpStatusTracking: no status on context! Is this middleware applied properly?'
      );
    }
  };
};

export const tracerProvider = new BasicTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'taql',
  }),
  sampler: TRACING_PARAMS.alwaysSample
    ? new AlwaysOnSampler()
    : new ParentBasedSampler({
        root: new AlwaysOffSampler(),
      }),
});

const zipkinExporter = new ZipkinExporter({
  serviceName: 'taql',
  url: TRACING_PARAMS.zipkinUrl,
});
tracerProvider.addSpanProcessor(
  TRACING_PARAMS.useBatchingProcessor
    ? new BatchSpanProcessor(zipkinExporter)
    : new SimpleSpanProcessor(zipkinExporter)
);
// Console exporter for debugging
tracerProvider.addSpanProcessor(
  new SimpleSpanProcessor(new ConsoleSpanExporter())
);
tracerProvider.register({
  propagator: new B3Propagator({
    injectEncoding: B3InjectEncoding.MULTI_HEADER,
  }),
});
