import {
  ENABLE_FEATURES,
  PREREGISTERED_QUERY_PARAMS,
  SERVER_PARAMS,
  accessLogger,
  logger,
} from '@taql/config';
import { Plugin, createYoga, useReadinessCheck } from 'graphql-yoga';
import {
  Supergraph,
  TASchema,
  loadSupergraph,
  makeSchema,
  overrideSupergraphWithSvco,
} from '@taql/schema';
import fetch, {
  Headers as FetchHeaders,
  Response as FetchResponse,
} from 'node-fetch';
import { httpAgent, legacyHttpsAgent } from '@taql/httpAgent';
import {
  instrumentedStore,
  memoryStore,
  useUnifiedCaching,
} from '@taql/caching';
import {
  mutatedFieldsExtensionPlugin,
  usePreregisteredQueries,
} from '@taql/prereg';
import {
  serverHostExtensionPlugin,
  subschemaExtensionsPlugin,
} from '@taql/debug';
import {
  tracerProvider,
  useOpenTelemetry,
  usePrometheus,
} from '@taql/observability';
import { GraphQLSchema } from 'graphql';
import type { IncomingHttpHeaders } from 'http';
import { TaqlAPQ } from './apq';
import { TaqlState } from '@taql/context';
import { addClusterReadinessStage } from '@taql/readiness';
import promClient from 'prom-client';
import { readFileSync } from 'fs';
import { useDisableIntrospection } from '@graphql-yoga/plugin-disable-introspection';
import { useErrorLogging } from './logging';
import { useTaqlSecurity } from '@taql/security';

export const makePlugins = async (
  defaultSchema: GraphQLSchema
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Plugin<any>[]> => {
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
        variables: true, // Includes the operation variables values as part of the metadata collected
        // The following are disabled due to their negative performance impact
        resolvers: false, // Tracks resolvers calls, and tracks resolvers thrown errors
        result: false, // Includes execution result object as part of the metadata collected
      },
      tracerProvider
    ),
    ...(ENABLE_FEATURES.debugExtensions
      ? [serverHostExtensionPlugin, subschemaExtensionsPlugin]
      : []),
    await apq.makePlugin(),
    unifiedCachingPlugin,
    preregPlugin,
    usePrometheus(),
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
          logger.error(`not ready yet: ${err}`);
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
  defaultSupergraph: Supergraph,
  defaultSchema: TASchema
):
  | GraphQLSchema
  | ((context?: Partial<TaqlState>) => Promise<GraphQLSchema>) => {
  if (!SERVER_PARAMS.svcoWorker) {
    return defaultSchema.schema;
  }

  const schemaForSVCOCache = instrumentedStore({
    name: 'svco_schemas',
    store: memoryStore<GraphQLSchema>({
      max: 128,
      ttl: SERVER_PARAMS.svcoSchemaTtl,
      async fetchMethod(legacySVCO): Promise<GraphQLSchema> {
        logger.debug(`Fetching and building schema for SVCO: ${legacySVCO}`);
        SVCO_SCHEMA_BUILD_COUNTER.inc(); // We're probably about to hang the event loop, inc before building schema
        return overrideSupergraphWithSvco(defaultSupergraph, legacySVCO).then(
          (stitchResult) =>
            stitchResult == undefined || 'error' in stitchResult
              ? defaultSchema.schema
              : 'partial' in stitchResult
              ? stitchResult.partial.schema
              : stitchResult.success.schema
        );
      },
    }),
  });

  return async (context) => {
    if (defaultSchema.isOverriddenBy(context?.state?.taql.SVCO)) {
      logger.debug(`Using schema for SVCO: ${context?.state?.taql.SVCO}`);
      const schemaForSVCO = await schemaForSVCOCache?.lruCache.fetch(
        context?.state?.taql.SVCO ?? 'no_svco',
        { allowStale: true }
      );
      return schemaForSVCO == undefined ? defaultSchema.schema : schemaForSVCO;
    } else {
      return defaultSchema.schema;
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

const yogaPrewarmed = addClusterReadinessStage('yogaPrewarmed');

export async function useYoga() {
  yogaPrewarmed.unready();
  const batchLimit = SERVER_PARAMS.batchLimit;
  const port = SERVER_PARAMS.svcoWorker
    ? SERVER_PARAMS.port - 1
    : SERVER_PARAMS.port;

  const yogaOptions = {
    graphiql: ENABLE_FEATURES.graphiql,
    multipart: false,
    batching: { limit: batchLimit },
    // Disable @whatwg-node/server's `useCors`, which is not very spec
    // compliant. It comes into play when browser requests are being sent
    // straight to taql.
    cors: false,

    // The following are graphql-yoga defaults added explicitly here for future stability.
    //logging: true,
    logging: logger,
    maskedErrors: true,
    graphqlEndpoint: '/graphql',
    healthCheckEndpoint: '/health',
    landingPage: ENABLE_FEATURES.graphiql,
    // Setting this to false as legacy Yoga Server-Sent Events are deprecated:
    // https://github.com/dotansimha/graphql-yoga/blob/b309ca0db1c45264878c3cec0137c3fdbd22fc97/packages/graphql-yoga/src/server.ts#L184
    legacySse: false,
  } as const;

  const supergraph = await loadSupergraph();
  const stitchResult = await makeSchema(supergraph);
  const schema =
    'success' in stitchResult
      ? stitchResult.success
      : 'partial' in stitchResult
      ? stitchResult.partial
      : undefined;
  if (schema == undefined) {
    throw new Error('failed to load initial schema');
  }
  logger.info('created initial schema');

  const yoga = createYoga<TaqlState>({
    schema: makeSchemaProvider(supergraph, schema),
    ...yogaOptions,
    plugins: await makePlugins(schema.schema),
  });
  logger.info('Created yoga server');

  await yoga.fetch(yoga.graphqlEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-taql-trust-client': 'true',
    },
    body: JSON.stringify({
      query: 'query prewarm { __typename }',
    }),
  });
  logger.info('Prewarmed yoga server');
  yogaPrewarmed.ready();

  return async function yogaHandler(ctx: TaqlState) {
    const accessTimer = accessLogger.startTimer();
    const svco = ctx.state.taql.SVCO;
    let response: Response | FetchResponse;
    if (
      ENABLE_FEATURES.serviceOverrides &&
      !SERVER_PARAMS.svcoWorker &&
      schema.isOverriddenBy(svco)
    ) {
      logger.debug(
        `SVCO cookie set, but I'm not the SVCO worker... forwarding request. SVCO: ${svco}`
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
          agent: ctx.request.protocol == 'https' ? legacyHttpsAgent : httpAgent,
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
}
