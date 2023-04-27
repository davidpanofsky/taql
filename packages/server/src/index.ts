import { APQStore, useAPQ } from '@graphql-yoga/plugin-apq';
import {
  AUTOMATIC_PERSISTED_QUERY_PARAMS,
  ENABLE_GRAPHIQL,
  SERVER_PARAMS,
} from '@taql/config';
import { Server, createServer as httpServer } from 'http';
import { TaqlContext, plugins as contextPlugins } from '@taql/context';
import { caching, multiCaching } from 'cache-manager';
import { createYoga, useReadinessCheck } from 'graphql-yoga';
import Koa from 'koa';
import { SSL_CONFIG } from '@taql/ssl';
import { SchemaPoller } from '@taql/schema';
import { TaqlPlugins } from '@taql/plugins';
import { plugins as batchingPlugins } from '@taql/batching';
import { createServer as httpsServer } from 'https';
import { ioRedisStore } from '@tirke/node-cache-manager-ioredis';
import { plugins as preregPlugins } from '@taql/prereg';
import { usePrometheus } from '@graphql-yoga/plugin-prometheus';

const FIVE_MINUTES_MILLIS = 1000 * 60 * 5;

export async function main() {
  const { port } = SERVER_PARAMS;

  const yogaOptions = {
    // TODO pick a number that matches the current limit in legacy graphql,
    // and draw it from configuration.
    batching: { limit: 2000 },
    multipart: false,
    graphiql: ENABLE_GRAPHIQL,
  } as const;

  const schemaPoller = new SchemaPoller({
    interval: FIVE_MINUTES_MILLIS,
  });

  const schema = await schemaPoller.schema;
  if (schema == undefined) {
    throw new Error('failed to load initial schema');
  }
  console.log('created initial schema');

  const plugins: TaqlPlugins = new TaqlPlugins(
    schemaPoller.asPlugin(),
    contextPlugins,
    batchingPlugins,
    { envelop: preregPlugins }
  );

  // Two tier store for automatic persisted queries
  const memoryCache = await caching('memory', {
    max: AUTOMATIC_PERSISTED_QUERY_PARAMS.mem_cache_size,
  });

  const redisCache = AUTOMATIC_PERSISTED_QUERY_PARAMS.redis_instance
    ? [
        await caching(ioRedisStore, {
          ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redis_ttl,
          host: AUTOMATIC_PERSISTED_QUERY_PARAMS.redis_instance,
          port: 6379,
        }),
      ]
    : AUTOMATIC_PERSISTED_QUERY_PARAMS.redis_cluster
    ? [
        await caching(ioRedisStore, {
          ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redis_ttl,
          clusterConfig: {
            nodes: [
              {
                host: AUTOMATIC_PERSISTED_QUERY_PARAMS.redis_cluster,
                port: 6379,
              },
            ],
          },
        }),
      ]
    : [];
  const apqStore: APQStore = multiCaching([memoryCache, ...redisCache]);

  const yoga = createYoga<TaqlContext>({
    schema,
    ...yogaOptions,
    plugins: [
      useAPQ({ store: apqStore }),
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
        // eslint-disable-next-line object-shorthand
        check: async () => {
          await apqStore.set('readinessCheck', '1');
        },
      }),
      ...plugins.envelop(),
    ],
  });

  const koa = new Koa();
  plugins.koa().forEach((mw) => koa.use(mw));

  koa.use(async (ctx) => {
    // Second parameter adds Koa's context into GraphQL Context
    const response = await yoga.handleNodeRequest(ctx.req, ctx);

    // Set status code
    ctx.status = response.status;

    // Set headers
    response.headers.forEach((value, key) => {
      ctx.append(key, value);
    });

    // Converts ReadableStream to a NodeJS Stream
    ctx.body = response.body;
  });

  const server: Server =
    SSL_CONFIG == undefined ? httpServer() : httpsServer(SSL_CONFIG);

  server.addListener('request', koa.callback());
  console.log('created server');

  console.log(`launching server on port ${port}`);
  server.listen(port, () => {
    console.info('server running');
  });
}

main();
