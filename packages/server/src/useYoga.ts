import {
  ENABLE_FEATURES,
  PREREGISTERED_QUERY_PARAMS,
  SERVER_PARAMS,
  accessLogger,
  logger,
} from '@taql/config';
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
import { GraphQLSchema } from 'graphql';
import type { IncomingHttpHeaders } from 'http';
import { InstrumentedCache } from '@taql/metrics';
import { TaqlAPQ } from './apq';
import { TaqlState } from '@taql/context';
import { httpsAgent } from '@taql/httpAgent';
import { makeSchema } from '@taql/schema';
import { preconfiguredUsePrometheus } from './usePrometheus';
import promClient from 'prom-client';
import { readFileSync } from 'fs';
import { tracerProvider } from './observability';
import { useDisableIntrospection } from '@graphql-yoga/plugin-disable-introspection';
import { useErrorLogging } from './logging';
import { useOpenTelemetry } from '@envelop/opentelemetry';
import { useTaqlSecurity } from '@taql/security';
import { useUnifiedCaching } from '@taql/unifiedCaching';

const makePlugins = async (defaultSchema: GraphQLSchema) => {
  const apq = new TaqlAPQ();

  const preregPlugin = usePreregisteredQueries({
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
          key: readFileSync(PREREGISTERED_QUERY_PARAMS.pgSslKeyPath).toString(),
          rejectUnauthorized: PREREGISTERED_QUERY_PARAMS.sslRejectUnauthorized,
        }
      : undefined,
  });

  const unifiedCachingPlugin = await useUnifiedCaching({
    maxCacheSize: 2048,
    useJit: ENABLE_FEATURES.graphqlJIT && {
      jitOptions: {
        // Use fast-json-stringify instead of standard json stringification.
        customJSONSerializer: true,
        // Don't verify enum or scalar inputs - if a client wants to stuff a
        // string into an int, or pass an invalid enum value, that's their
        // problem; moreover, if a subgraph wants to misbehave when bad data is
        // passed, that's their problem. We're in the transport, muxing &
        // demuxing business, not the security business.
        disableLeafSerialization: true,
      },
    },
    prewarm: {
      schema: defaultSchema,
      preregistered: await preregPlugin.loadCurrentQueries(),
      persisted: await apq.loadPersistedQueries(),
    },
  });

  const securityPlugin = useTaqlSecurity();

  const yogaPlugins = [
    ...((securityPlugin && [securityPlugin]) || []),
    useErrorLogging,
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
    await apq.makePlugin(),
    unifiedCachingPlugin,
    preregPlugin,
    preconfiguredUsePrometheus,
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
  ];

  ENABLE_FEATURES.introspection || yogaPlugins.push(useDisableIntrospection());
  return yogaPlugins;
};

const SVCO_SCHEMA_BUILD_COUNTER = new promClient.Counter({
  name: 'taql_svco_schema_builds',
  help: 'Total number of times the taql instance has needed to build a new schema to serve an SVCO cookie/header',
});

const makeSchemaProvider = (
  defaultSchema: GraphQLSchema
): GraphQLSchema | ((context: TaqlState) => Promise<GraphQLSchema>) => {
  if (!SERVER_PARAMS.svcoWorker) {
    return defaultSchema;
  }

  const schemaForSVCOCache = new InstrumentedCache<string, GraphQLSchema>(
    'svco_schemas',
    {
      max: 128,
      ttl: 1000 * 60 * 2,
      async fetchMethod(key): Promise<GraphQLSchema> {
        logger.debug(`Fetching and building schema for SVCO: ${key}`);
        SVCO_SCHEMA_BUILD_COUNTER.inc(); // We're probably about to hang the event loop, inc before building schema
        return makeSchema(key);
      },
    }
  );
  return async (context) => {
    if (context.state?.taql.SVCO?.hasStitchedRoles) {
      logger.debug(`Using schema for SVCO: ${context.state.taql.SVCO}`);
      const schemaForSVCO = await schemaForSVCOCache?.fetch(
        context.state.taql.SVCO.value,
        { allowStale: true }
      );
      return schemaForSVCO == undefined ? defaultSchema : schemaForSVCO;
    } else {
      return defaultSchema;
    }
  };
};

// Buckets for request/response sizes
const defaultSizeBytesBuckets = promClient.exponentialBuckets(25, 5, 7);
const metricLabels = ['method', 'path', 'statusCode'];

const requestSizeMetric = new promClient.Histogram({
  name: 'taql_request_size_bytes',
  help: 'Size of HTTP requests in bytes',
  labelNames: metricLabels,
  buckets: defaultSizeBytesBuckets,
});

const responseSizeMetric = new promClient.Histogram({
  name: 'taql_response_size_bytes',
  help: 'Size of HTTP responses in bytes',
  labelNames: metricLabels,
  buckets: defaultSizeBytesBuckets,
});

export const useYoga = async () => {
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
    landingPage: ENABLE_FEATURES.graphiql,
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

  const yoga = createYoga<TaqlState>({
    schema: makeSchemaProvider(schema),
    ...yogaOptions,
    plugins: await makePlugins(schema),
  });
  logger.info('Created yoga server');

  await yoga.fetch(yoga.graphqlEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: 'query prewarm { __typename }',
    }),
  });
  logger.info('Prewarmed yoga server');

  return async (ctx: TaqlState) => {
    const accessTimer = accessLogger.startTimer();
    const svco = ctx.state.taql.SVCO;
    let response: Response | FetchResponse;
    if (
      ENABLE_FEATURES.serviceOverrides &&
      !SERVER_PARAMS.svcoWorker &&
      svco?.hasStitchedRoles
    ) {
      logger.debug(
        `SVCO cookie set, but I'm not the SVCO worker... forwarding request. SVCO: ${svco.value}`
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
          body:
            ctx.request.method != 'GET' && ctx.requestMethod != 'FETCH'
              ? ctx.req
              : undefined,
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

    // Capture metrics for request and response sizes.
    const labels = {
      method: ctx.request.method,
      path: ctx.request.path,
      statusCode: ctx.status,
    };
    requestSizeMetric.observe(labels, ctx.request.length || 0);
    responseSizeMetric.observe(labels, ctx.response.length || 0);

    accessTimer.done({
      method: ctx.request.method,
      path: ctx.request.path,
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
