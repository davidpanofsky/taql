import { APQStore, useAPQ } from '@graphql-yoga/plugin-apq';
import {
  AUTOMATIC_PERSISTED_QUERY_PARAMS,
  ENABLE_FEATURES,
  PREREGISTERED_QUERY_PARAMS,
  SERVER_PARAMS,
  TRACING_PARAMS,
  logger,
} from '@taql/config';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { DocumentNode, GraphQLError, GraphQLSchema } from 'graphql';
import { Server, createServer as httpServer } from 'http';
import { caching, multiCaching } from 'cache-manager';
import { createYoga, useReadinessCheck } from 'graphql-yoga';
import fetch, {
  Headers as FetchHeaders,
  Response as FetchResponse,
} from 'node-fetch';
import {
  mutatedFieldsExtensionPlugin,
  usePreregisteredQueries,
} from '@taql/prereg';
import {
  serverHostExtensionPlugin,
  subschemaExtensionsPlugin,
} from '@taql/debug';
import { AggregatorRegistry } from 'prom-client';
import type { IncomingHttpHeaders } from 'http';
import Koa from 'koa';
import { LRUCache } from 'lru-cache';
import { SSL_CONFIG } from '@taql/ssl';
import { TaqlState } from '@taql/context';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import cluster from 'node:cluster';
import { httpsAgent } from '@taql/httpAgent';
import { createServer as httpsServer } from 'https';
import { ioRedisStore } from '@tirke/node-cache-manager-ioredis';
import koaLogger from 'koa-logger';
import { makeSchema } from '@taql/schema';
import process from 'node:process';
import promClient from 'prom-client';
import { readFileSync } from 'fs';
import { useDisableIntrospection } from '@graphql-yoga/plugin-disable-introspection';
import { useOpenTelemetry } from '@envelop/opentelemetry';
import { usePrometheus } from '@graphql-yoga/plugin-prometheus';
import { useTaqlContext } from '@taql/context';

const prometheusRegistry = new AggregatorRegistry();
const workerStartup = async () => {
  // Set up memory monitoring
  const prefix = 'taql_';
  // The defaults includes valuable metrics including heap allocation, available memory.
  // ex:
  // taql_nodejs_heap_space_size_available_bytes{space="..."}
  // taql_nodejs_heap_space_size_used_bytes{space="..."}
  // taql_nodejs_gc_duration_seconds_sum{kind="..."}
  promClient.collectDefaultMetrics({ prefix });
  // end: memory monitoring
  const batchLimit = SERVER_PARAMS.batchLimit;
  const port = SERVER_PARAMS.svcoWorker
    ? SERVER_PARAMS.port - 1
    : SERVER_PARAMS.port;

  const yogaOptions = {
    graphiql: ENABLE_FEATURES.graphiql,
    multipart: false,
    // TODO pick a number that matches the current limit in legacy graphql,
    // and draw it from configuration.
    batching: { limit: batchLimit },

    // The following are graphql-yoga defaults added explicitly here for future stability.
    //logging: true,
    logging: logger,
    maskedErrors: true,
    cors: undefined,
    graphqlEndpoint: '/graphql',
    healthCheckEndpoint: '/health',
    landingPage: true,
    parserCache: {
      documentCache: new LRUCache<string, DocumentNode>({
        max: 1024,
        ttl: 3_600_000,
      }),
      errorCache: new LRUCache<string, Error>({ max: 1024, ttl: 3_600_000 }),
    },
    validationCache: new LRUCache<string, readonly GraphQLError[]>({
      max: 1024,
      ttl: 3_600_000,
    }),

    // Setting this to false as legacy Yoga Server-Sent Events are deprecated:
    // https://github.com/dotansimha/graphql-yoga/blob/b309ca0db1c45264878c3cec0137c3fdbd22fc97/packages/graphql-yoga/src/server.ts#L184
    legacySse: false,
  } as const;

  /*
  // Example use of SchemaPoller, currently not in use due to it binding the CPU too aggressively
  const schemaPoller = new SchemaPoller({
    interval: TEN_MINUTES_MILLIS,
  });

  const schema = await schemaPoller.schema;
  */
  const schema = await makeSchema();

  if (schema == undefined) {
    throw new Error(
      `worker=${cluster.worker?.id} failed to load initial schema`
    );
  }
  logger.info(`worker=${cluster.worker?.id} created initial schema`);

  // Two tier store for automatic persisted queries
  const memoryCache = await caching('memory', {
    max: AUTOMATIC_PERSISTED_QUERY_PARAMS.memCacheSize,
    ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisTTL,
  });

  const redisCache = AUTOMATIC_PERSISTED_QUERY_PARAMS.redisInstance
    ? [
        await caching(ioRedisStore, {
          ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisTTL,
          host: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisInstance,
          port: 6379,
        }),
      ]
    : AUTOMATIC_PERSISTED_QUERY_PARAMS.redisCluster
    ? [
        await caching(ioRedisStore, {
          ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisTTL,
          clusterConfig: {
            nodes: [
              {
                host: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisCluster,
                port: 6379,
              },
            ],
          },
        }),
      ]
    : [];
  const apqStore: APQStore = multiCaching([memoryCache, ...redisCache]);

  const zipkinExporter = new ZipkinExporter({
    serviceName: 'taql',
    url: TRACING_PARAMS.zipkinUrl,
  });

  const tracerProvider = new BasicTracerProvider();
  tracerProvider.addSpanProcessor(
    TRACING_PARAMS.useBatchingProcessor
      ? new BatchSpanProcessor(zipkinExporter)
      : new SimpleSpanProcessor(zipkinExporter)
  );
  tracerProvider.register();
  const yogaPlugins = [
    mutatedFieldsExtensionPlugin,
    useOpenTelemetry(
      {
        resolvers: true, // Tracks resolvers calls, and tracks resolvers thrown errors
        variables: true, // Includes the operation variables values as part of the metadata collected
        result: true, // Includes execution result object as part of the metadata collected
      },
      tracerProvider
    ),
    ...(ENABLE_FEATURES.debugExtensions
      ? [serverHostExtensionPlugin, subschemaExtensionsPlugin]
      : []),
    useAPQ({ store: apqStore }),
    usePreregisteredQueries({
      maxCacheSize: PREREGISTERED_QUERY_PARAMS.maxCacheSize,
      postgresConnectionString: PREREGISTERED_QUERY_PARAMS.databaseUri,
      ssl: PREREGISTERED_QUERY_PARAMS.pgUseSsl
        ? {
            ca: readFileSync(
              PREREGISTERED_QUERY_PARAMS.pgSslCaCertPath
            ).toString(),
            cert: readFileSync(
              PREREGISTERED_QUERY_PARAMS.pgSslCertPath
            ).toString(),
            key: readFileSync(
              PREREGISTERED_QUERY_PARAMS.pgSslKeyPath
            ).toString(),
            rejectUnauthorized:
              PREREGISTERED_QUERY_PARAMS.sslRejectUnauthorized,
          }
        : undefined,
    }),
    usePrometheus({
      // Options specified by @graphql-yoga/plugin-prometheus
      http: true,
      // Options passed on to @envelop/prometheus
      // https://the-guild.dev/graphql/envelop/plugins/use-prometheus
      // all optional, and by default, all set to false
      requestCount: true, // requries `execute` to be true as well
      requestSummary: true, // requries `execute` to be true as well
      parse: true,
      validate: true,
      contextBuilding: true,
      execute: true,
      errors: true,
      resolvers: true, // requires "execute" to be `true` as well
      deprecatedFields: true,
      endpoint: '/worker_metrics',
    }),
    useReadinessCheck({
      endpoint: '/NotImplemented',
      async check({ fetchAPI }) {
        logger.debug(`worker=${cluster.worker?.id} Requested Readiness Check`);
        try {
          // For now, readiness check is same as healthcheck, but with a different response body.
          // Todo: Add checks for other things like database connection, etc.
          //redisCache[0].store.client.status
          logger.debug(
            `worker=${cluster.worker?.id} Responding Readiness Check`
          );
          // The trailing newline is important for unblacklisting, apparently.
          return new fetchAPI.Response('<NotImplemented/>\n');
        } catch (err) {
          logger.error(`worker=${cluster.worker?.id} ${err}`);
          return false;
        }
      },
    }),
    //schemaPoller.asPlugin(),
  ];

  ENABLE_FEATURES.introspection || yogaPlugins.push(useDisableIntrospection());

  const svcoSchemaBuilds = new promClient.Counter({
    name: 'taql_svco_schema_builds',
    help: 'Total number of times the taql instance has needed to build a new schema to serve an SVCO cookie/header',
  });

  const schemaForSVCOCache = ENABLE_FEATURES.serviceOverrides
    ? new LRUCache<string, GraphQLSchema>({
        max: 128,
        ttl: 1000 * 60 * 2,
        async fetchMethod(key): Promise<GraphQLSchema> {
          logger.debug(
            `worker=${cluster.worker?.id} Fetching and building schema for SVCO: ${key}`
          );
          svcoSchemaBuilds.inc(); // We're probably about to hang the event loop, inc before building schema
          return makeSchema(key);
        },
      })
    : null;

  const yoga = createYoga<TaqlState>({
    schema: ENABLE_FEATURES.serviceOverrides
      ? async (context) => {
          if (context.state.taql.SVCO == undefined) {
            return schema;
          } else {
            logger.debug(
              `worker=${cluster.worker?.id} Using schema for SVCO: ${context.state.taql.SVCO}`
            );
            const schemaForSVCO = await schemaForSVCOCache?.fetch(
              context.state.taql.SVCO,
              { allowStale: true }
            );
            return schemaForSVCO == undefined ? schema : schemaForSVCO;
          }
        }
      : schema,
    ...yogaOptions,
    plugins: yogaPlugins,
  });

  const koa = new Koa();
  koa.use(koaLogger());

  koa.use(async (_ctx, next) => {
    koaConcurrency.inc();
    await next();
    koaConcurrency.dec();
  });

  //Initialize taql state.
  koa.use(useTaqlContext);

  koa.use(async (ctx: TaqlState) => {
    logger.debug(
      `worker=${cluster.worker?.id} Koa Request: ${ctx.request.method} ${ctx.request.url}`
    );
    const legacySVCO = ctx.state.taql.SVCO;
    let response: Response | FetchResponse;
    if (
      ENABLE_FEATURES.serviceOverrides &&
      !SERVER_PARAMS.svcoWorker &&
      legacySVCO
    ) {
      logger.debug(
        `worker=${cluster.worker?.id} SVCO cookie set, but I'm not the SVCO worker... forwarding request. SVCO: ${legacySVCO}`
      );
      const requestHeaders: FetchHeaders = new FetchHeaders();
      for (const key in ctx.request.headers) {
        [(<IncomingHttpHeaders>ctx.request.headers)[key]]
          .flat()
          .forEach((val) => {
            val != undefined && requestHeaders.set(key, val);
          });
      }
      response = await fetch(
        `${ctx.request.protocol}://localhost:${port - 1}${ctx.request.url}`,
        {
          method: ctx.request.method,
          headers: requestHeaders,
          body: ctx.req,
          agent: ctx.request.protocol == 'https' ? httpsAgent : undefined,
        }
      );
    } else {
      // Second parameter adds Koa's context into GraphQL Context
      response = await yoga.handleNodeRequest(ctx.req, ctx);
    }

    logger.debug(
      `worker=${cluster.worker?.id} Yoga Response: ${response.status} ${response.statusText}`
    );

    // Set status code
    ctx.status = response.status;

    // Set headers
    response.headers.forEach((value, key) => {
      ctx.append(key, value);
    });

    // If response body is null, koa will change response to a 204. We flush the headers here to prevent this.
    // https://github.com/koajs/koa/blob/master/docs/api/response.md#responsebody-1
    ctx.flushHeaders();

    // Converts ReadableStream to a NodeJS Stream
    ctx.body = response.body;
    logger.debug(
      `worker=${cluster.worker?.id} Koa Response: ${ctx.response.status} ${ctx.response.message} ${ctx.response.length} bytes`
    );
  });

  const koaConcurrency = new promClient.Gauge({
    name: 'taql_koa_concurrency',
    help: 'concurrent requests inside of the koa context',
  });

  /**
   * This is just to prove that aggregation is working.
   * 
   const workerCounter = new promClient.Counter({
     name: 'taql_worker',
     help: 'worker',
     labelNames: ['worker'],
   });

   setInterval(() => {
     workerCounter.inc({ worker: cluster.worker?.id });
   }, 1000);
   */

  new promClient.Gauge({
    name: 'taql_validation_cache_size',
    help: 'validation cache entries',
    async collect() {
      const size = yogaOptions.validationCache.size;
      this.set(size);
    },
  });
  new promClient.Gauge({
    name: 'taql_document_cache_size',
    help: 'document cache entries',
    async collect() {
      const size = yogaOptions.parserCache.documentCache.size;
      this.set(size);
    },
  });
  new promClient.Gauge({
    name: 'taql_error_cache_size',
    help: 'error cache entries',
    async collect() {
      const size = yogaOptions.parserCache.errorCache.size;
      this.set(size);
    },
  });

  const server: Server =
    SSL_CONFIG == undefined ? httpServer() : httpsServer(SSL_CONFIG);

  server.addListener('request', koa.callback());
  logger.info(`worker=${cluster.worker?.id} created server`);

  logger.info(`worker=${cluster.worker?.id} launching server on port ${port}`);
  server.listen(port, () => {
    logger.info(`worker=${cluster.worker?.id} server running`);
  });

  // a long http keepalive timeout should help keep SVCO on same worker.
  //server.keepAliveTimeout = 60_000;

  cluster.worker?.on('disconnect', () => {
    server.removeAllListeners();
    server.closeAllConnections();
  });
};

const primaryStartup = async () => {
  // Set up memory monitoring
  const prefix = 'taql_primary_';
  // The defaults includes valuable metrics including heap allocation, available memory.
  // ex:
  // taql_nodejs_heap_space_size_available_bytes{space="..."}
  // taql_nodejs_heap_space_size_used_bytes{space="..."}
  // taql_nodejs_gc_duration_seconds_sum{kind="..."}
  promClient.collectDefaultMetrics({
    register: prometheusRegistry,
    prefix,
  });
  // end: memory monitoring

  const { port } = SERVER_PARAMS;

  const koa = new Koa();
  koa.use(koaLogger());

  koa.use(async (ctx) => {
    if (ctx.request.method === 'GET' && ctx.request.url === '/metrics') {
      try {
        const primaryMetrics = await prometheusRegistry.metrics();
        const clusterMetrics = await prometheusRegistry.clusterMetrics();
        ctx.set('Content-Type', prometheusRegistry.contentType);
        ctx.body = [primaryMetrics, clusterMetrics].join('\n');
        ctx.status = 200;
      } catch (err) {
        ctx.status = 500;
        ctx.body = err;
      }
    }
  });

  const server: Server =
    SSL_CONFIG == undefined ? httpServer() : httpsServer(SSL_CONFIG);

  server.addListener('request', koa.callback());
  logger.info('worker=0 created server');

  logger.info(`worker=0 launching server on port ${port + 1}`);
  server.listen(port + 1, () => {
    logger.info('worker=0 server running');
  });

  logger.info(`Primary process (${process.pid}) is running`);

  // create one worker for svco on port - 1 if enabled.
  ENABLE_FEATURES.serviceOverrides && cluster.fork({ SVCO_WORKER: true });
  const clusterParallelism = ENABLE_FEATURES.serviceOverrides
    ? Math.max(SERVER_PARAMS.clusterParallelism - 1, 1)
    : SERVER_PARAMS.clusterParallelism;
  for (let i = 0; i < clusterParallelism; i++) {
    cluster.fork({ SVCO_WORKER: false });
    // A small delay between forks seems to help keep external dependencies happy.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  cluster.on('online', (worker) => {
    logger.info(`worker=${worker.id} pid=${worker.process.pid} online`);
  });

  cluster.on('exit', (worker, code, signal) => {
    if (worker.exitedAfterDisconnect === true) {
      logger.info(
        `worker=${worker.id} pid=${worker.process.pid} shutdown gracefully`
      );
    } else {
      if (signal) {
        logger.warn(
          `worker=${worker.id} pid=${worker.process.pid} was killed by signal: ${signal}`
        );
      } else if (code !== 0) {
        logger.warn(
          `worker=${worker.id} pid=${worker.process.pid} exited with error code: ${code}`
        );
      }
      logger.info(`replacing worker ${worker.id}...`);
      cluster.fork();
    }
  });
};

cluster.isPrimary ? primaryStartup() : workerStartup();
