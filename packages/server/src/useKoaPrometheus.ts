import Koa from 'koa';
import promClient from 'prom-client';
import { performance } from 'perf_hooks';

export function useKoaPrometheus() {
  const httpRequestDuration = new promClient.Histogram({
    name: 'taql_http_duration_ms',
    help: 'Time (ms) spent on HTTP connection',
    labelNames: ['statusCode', 'endpoint'],
  });

  const koaConcurrency = new promClient.Gauge({
    name: 'taql_koa_concurrency',
    help: 'concurrent requests inside of the koa context',
  });

  return async function koaPrometheusMiddleware(
    ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext, any>,
    next: Koa.Next
  ) {
    const start = performance.now();
    koaConcurrency.inc();
    await next();
    koaConcurrency.dec();
    const duration = performance.now() - start;
    const labels = {
      statusCode: ctx.status || 0,
      endpoint: ctx.path,
    };
    httpRequestDuration.observe(labels, duration);
  };
}
