import { APQStore, useAPQ } from '@graphql-yoga/plugin-apq';
import { InstrumentedCache, wrappedLRUStore } from '@taql/metrics';
import { caching, multiCaching } from 'cache-manager';
import { AUTOMATIC_PERSISTED_QUERY_PARAMS, logger } from '@taql/config';
import type { Redis } from 'ioredis';
import { Plugin as YogaPlugin } from 'graphql-yoga';
import { ioRedisStore } from '@tirke/node-cache-manager-ioredis';
import { promisify } from 'util';

const isDefined = <T>(obj: T | undefined | void): obj is T => !!obj;

async function* nodePersistedQueries(redis: Redis): AsyncGenerator<{
  id: string;
  query: string;
}> {
  //start cursor at 0
  let result: undefined | [cursor: string, keys: string[]] = ['0', []];
  const scan: (cursor: string) => Promise<undefined | [string, string[]]> =
    promisify(redis.scan.bind(redis));
  do {
    result = await scan(result[0]);
    if (result) {
      const keys = result[1];
      const vals = <string[]>await redis.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        // the wrapped cache-manager-ioredis json serializes writes, so we must
        // json deserialize gets
        const query = JSON.parse(vals[i]);
        if (query != undefined) {
          yield { id: keys[i], query };
        }
      }
    }
    //when the cursor wraps back around to '0', exit.
  } while (result?.[0] != undefined && result?.[0] !== '0');
}

export class TaqlAPQ {
  private readonly redisParams = AUTOMATIC_PERSISTED_QUERY_PARAMS.redisInstance
    ? {
        ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisTTL,
        host: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisInstance,
        port: 6379,
      }
    : AUTOMATIC_PERSISTED_QUERY_PARAMS.redisCluster
    ? {
        ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisTTL,
        clusterConfig: {
          nodes: [
            {
              host: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisCluster,
              port: 6379,
            },
          ],
        },
      }
    : undefined;

  private readonly wrappedClient: undefined | ReturnType<typeof ioRedisStore>;

  constructor() {
    this.wrappedClient = this.redisParams && ioRedisStore(this.redisParams);
  }

  async loadPersistedQueries(): Promise<{ id: string; query: string }[]> {
    const redisOrCluster = this.wrappedClient?.client;
    const persistedQueries: { id: string; query: string }[] = [];
    if (redisOrCluster) {
      const redises =
        'nodes' in redisOrCluster ? redisOrCluster.nodes() : [redisOrCluster];
      await Promise.allSettled(
        redises.map(async (redis) => {
          for await (const pq of nodePersistedQueries(redis)) {
            persistedQueries.push(pq);
          }
        })
      );
    }
    return persistedQueries;
  }

  async makePlugin(): Promise<YogaPlugin> {
    // Two tier store for automatic persisted queries
    const memoryCache = await caching(
      wrappedLRUStore({
        cache: new InstrumentedCache<string, string>('apq', {
          max: AUTOMATIC_PERSISTED_QUERY_PARAMS.memCacheSize,
          ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisTTL,
        }),
      })
    );

    const apqStore: APQStore = multiCaching(
      [
        memoryCache,
        this.wrappedClient &&
          (await caching(this.wrappedClient).catch(() => {
            logger.error('Unable to initialize APQ redis cache');
          })),
      ].filter(isDefined)
    );

    return useAPQ({ store: apqStore });
  }
}
