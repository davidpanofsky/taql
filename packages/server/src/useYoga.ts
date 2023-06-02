import { APQStore, useAPQ } from '@graphql-yoga/plugin-apq';
import {
  AUTOMATIC_PERSISTED_QUERY_PARAMS,
  ENABLE_FEATURES,
  PREREGISTERED_QUERY_PARAMS,
  SERVER_PARAMS,
  accessLogger,
  logger,
} from '@taql/config';
import { DocumentNode, GraphQLError, GraphQLSchema } from 'graphql';
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
import type { IncomingHttpHeaders } from 'http';
import { LRUCache } from 'lru-cache';
import { TaqlState } from '@taql/context';
import { httpsAgent } from '@taql/httpAgent';
import { ioRedisStore } from '@tirke/node-cache-manager-ioredis';
import { makeSchema } from '@taql/schema';
import promClient from 'prom-client';
import { readFileSync } from 'fs';
import { tracerProvider } from './observability';
import { useDisableIntrospection } from '@graphql-yoga/plugin-disable-introspection';
import { useOpenTelemetry } from '@envelop/opentelemetry';
import { usePrometheus } from '@graphql-yoga/plugin-prometheus';

export const useYoga = async () => {
  const batchLimit = SERVER_PARAMS.batchLimit;
  const port = SERVER_PARAMS.svcoWorker
    ? SERVER_PARAMS.port - 1
    : SERVER_PARAMS.port;

  const documentCache = new LRUCache<string, DocumentNode>({
    max: 4096,
    maxSize: 1024 ** 3, // 1G in bytes
    // We approximate the size of the cache in bytes, and node strings are utf-16.
    // It's possible that the in-memory footprint will be smaller, but be pessimistic.
    // Keys are the full query string.  We can approximate that the parsed document is _at least_ that heavy, so *2
    sizeCalculation: (value, key) => Buffer.byteLength(key, 'utf16le') * 2,
    ttl: 3_600_000,
  });

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
      documentCache,
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
      documentCacheForWarming: documentCache,
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
      deprecatedFields: true,
      endpoint: '/worker_metrics',
    }),
    useReadinessCheck({
      endpoint: '/NotImplemented',
      async check({ fetchAPI }) {
        try {
          // For now, readiness check is same as healthcheck, but with a different response body.
          // Todo: Add checks for other things like database connection, etc.
          //redisCache[0].store.client.status
          // The trailing newline is important for unblacklisting, apparently.
          return new fetchAPI.Response('<NotImplemented/>\n');
        } catch (err) {
          logger.error(err);
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
          logger.debug(`Fetching and building schema for SVCO: ${key}`);
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
            logger.debug(`Using schema for SVCO: ${context.state.taql.SVCO}`);
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

  return async (ctx: TaqlState) => {
    const accessTimer = accessLogger.startTimer();
    const legacySVCO = ctx.state.taql.SVCO;
    let response: Response | FetchResponse;
    if (
      ENABLE_FEATURES.serviceOverrides &&
      !SERVER_PARAMS.svcoWorker &&
      legacySVCO
    ) {
      logger.debug(
        `SVCO cookie set, but I'm not the SVCO worker... forwarding request. SVCO: ${legacySVCO}`
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
    accessTimer.done({
      method: ctx.request.method,
      url: ctx.request.url,
      query: ctx.request.query,
      http_version: ctx.req.httpVersion,
      remote_addr: ctx.request.ip,
      status: ctx.response.status,
      message: ctx.response.message,
      content_length: ctx.response.length,
      user_agent: ctx.request.headers['user-agent'],
      logger: 'access_log',
    });
  };
};
