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
import { SchemaPoller, makeSchema } from '@taql/schema';
import { Server, createServer as httpServer } from 'http';
import { TaqlContext, plugins as contextPlugins } from '@taql/context';
import { caching, multiCaching } from 'cache-manager';
import { createYoga, useReadinessCheck } from 'graphql-yoga';
import {
  mutatedFieldsExtensionPlugin,
  usePreregisteredQueries,
} from '@taql/prereg';
import Koa from 'koa';
import { LRUCache } from 'lru-cache';
import { SSL_CONFIG } from '@taql/ssl';
import { TaqlPlugins } from '@taql/plugins';
import { ZipkinExporter } from '@opentelemetry/exporter-zipkin';
import { plugins as batchingPlugins } from '@taql/batching';
import { createServer as httpsServer } from 'https';
import { ioRedisStore } from '@tirke/node-cache-manager-ioredis';
import promClient from 'prom-client';
import { serverHostExtensionPlugin } from '@taql/debug';
import { useDisableIntrospection } from '@graphql-yoga/plugin-disable-introspection';
import { useOpenTelemetry } from '@envelop/opentelemetry';
import { usePrometheus } from '@graphql-yoga/plugin-prometheus';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const koaLogger = require('koa-logger');

const FIVE_MINUTES_MILLIS = 1000 * 60 * 5;

export async function main() {
  const { port, batchLimit } = SERVER_PARAMS;

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

  const schemaPoller = new SchemaPoller({
    interval: FIVE_MINUTES_MILLIS,
  });

  const schema = await schemaPoller.schema;
  if (schema == undefined) {
    throw new Error('failed to load initial schema');
  }
  logger.info('created initial schema');

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

  const yogaPlugins = [
    useAPQ({ store: apqStore }),
    usePreregisteredQueries({
      maxCacheSize: PREREGISTERED_QUERY_PARAMS.maxCacheSize,
      postgresConnectionString: PREREGISTERED_QUERY_PARAMS.databaseUri,
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
    }),
    useReadinessCheck({
      endpoint: '/NotImplemented',
      async check({ fetchAPI }) {
        logger.debug('Requested Readiness Check');
        try {
          // For now, readiness check is same as healthcheck, but with a different response body.
          // Todo: Add checks for other things like database connection, etc.
          //redisCache[0].store.client.status
          logger.debug('Responding Readiness Check');
          return new fetchAPI.Response('<NotImplemented/>');
        } catch (err) {
          logger.error(err);
          return false;
        }
      },
    }),
  ];

  ENABLE_FEATURES.introspection || yogaPlugins.push(useDisableIntrospection());

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

  const envelopPlugins = [
    mutatedFieldsExtensionPlugin,
    useOpenTelemetry(
      {
        resolvers: true, // Tracks resolvers calls, and tracks resolvers thrown errors
        variables: true, // Includes the operation variables values as part of the metadata collected
        result: true, // Includes execution result object as part of the metadata collected
      },
      tracerProvider
    ),
    ...(ENABLE_FEATURES.debugExtensions ? [serverHostExtensionPlugin] : []),
  ];

  const plugins: TaqlPlugins = new TaqlPlugins(
    schemaPoller.asPlugin(),
    contextPlugins,
    batchingPlugins,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { envelop: <any>envelopPlugins },
    { yoga: yogaPlugins }
  );

  const schemaForContextCache = ENABLE_FEATURES.serviceOverrides
    ? new LRUCache<string, GraphQLSchema>({ max: 32, ttl: 1000 * 60 * 2 })
    : null;
  async function getSchemaForContext(
    context: TaqlContext
  ): Promise<GraphQLSchema | undefined> {
    const legacySVCO = context.state.legacyContext.SVCO;
    let schemaForContext: GraphQLSchema | undefined;
    if (legacySVCO) {
      if (schemaForContextCache?.has(legacySVCO)) {
        logger.debug('Using cached schema for SVCO: ', legacySVCO);
        schemaForContext = schemaForContextCache.get(legacySVCO);
      } else {
        logger.debug('Fetching schema for SVCO: ', legacySVCO);
        schemaForContext = await makeSchema(legacySVCO);
        schemaForContext != undefined &&
          schemaForContextCache?.set(legacySVCO, schemaForContext);
      }
    }
    return schemaForContext;
  }
  const yoga = createYoga<TaqlContext>({
    schema: ENABLE_FEATURES.serviceOverrides
      ? async (context) => (await getSchemaForContext(context)) ?? schema
      : schema,
    ...yogaOptions,
    plugins: [...plugins.yoga(), ...plugins.envelop()],
  });

  const koa = new Koa();
  koa.use(koaLogger());
  plugins.koa().forEach((mw) => koa.use(mw));

  koa.use(async (ctx) => {
    logger.debug(`Koa Request: ${ctx.request.method} ${ctx.request.url}`);
    // Second parameter adds Koa's context into GraphQL Context
    const response = await yoga.handleNodeRequest(ctx.req, ctx);
    logger.debug(`Yoga Response: ${response.status} ${response.statusText}`);

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
      `Koa Response: ${ctx.response.status} ${ctx.response.message} ${ctx.response.length} bytes`
    );
  });

  const koaConcurrency = new promClient.Gauge({
    name: 'taql_koa_concurrency',
    help: 'concurrent requests inside of the koa context',
  });

  koa.use(async (ctx, next) => {
    koaConcurrency.inc();
    await next();
    koaConcurrency.dec();
  });

  const server: Server =
    SSL_CONFIG == undefined ? httpServer() : httpsServer(SSL_CONFIG);

  server.addListener('request', koa.callback());
  logger.info('created server');

  logger.info(`launching server on port ${port}`);
  server.listen(port, () => {
    logger.info('server running');
  });
}

main();
