import {
  AlwaysOffSampler,
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
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';

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
  if (ctx.request.method === 'GET' && ctx.request.url === '/metrics') {
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
  logger?: {
    error: (msg: string) => void;
    info: (msg: string) => void;
  };
}) => {
  const { logger } = options;
  logger?.info('useHttpStatusTracking: Initializing');

  const labels = ['statusCode'];

  const HTTP_RESPONSE_COUNTER = new promClient.Counter({
    name: 'taql_http_response',
    help: 'http responses by response code',
    labelNames: labels,
  });

  const HTTP_RESPONSE_SUMMARY_COUNTER = new promClient.Counter({
    name: 'taql_http_response_summary',
    help: 'summary of http responses',
    labelNames: labels,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (ctx: ParameterizedContext, next: () => Promise<any>) => {
    logger?.info('useHttpStatusTracking: inside context fn');
    await next();
    if (ctx.status) {
      const status = ctx.status.toString();
      HTTP_RESPONSE_COUNTER.inc({ statusCode: status });

      const statusBucket = status.slice(0, 1);
      HTTP_RESPONSE_SUMMARY_COUNTER.inc({ statusCode: `${statusBucket}xx` });
    } else {
      logger?.error('useHttpStatusTracking: no status on context!');
    }
  };
};

export const tracerProvider = new BasicTracerProvider({
  sampler: new ParentBasedSampler({
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
