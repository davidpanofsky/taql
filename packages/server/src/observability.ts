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
import { PROM_PARAMS, TRACING_PARAMS } from '@taql/config';
import promClient, { AggregatorRegistry } from 'prom-client';
import type { ParameterizedContext } from 'koa';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';

const prometheusRegistry = new AggregatorRegistry();
const { prefix } = PROM_PARAMS;
// Set up memory monitoring
// The defaults includes valuable metrics including heap allocation, available memory.
// ex:
// taql_nodejs_heap_space_size_available_bytes{space="..."}
// taql_nodejs_heap_space_size_used_bytes{space="..."}
// taql_nodejs_gc_duration_seconds_sum{kind="..."}
promClient.collectDefaultMetrics({ prefix });
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
