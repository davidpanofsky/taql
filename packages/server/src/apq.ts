import { APQStore, useAPQ } from '@graphql-yoga/plugin-apq';
import { AUTOMATIC_PERSISTED_QUERY_PARAMS, logger } from '@taql/config';
import { caching, multiCaching } from 'cache-manager';
import {
  instrumentedStore,
  isCache,
  memoryStore,
  redisStore,
} from '@taql/caching';
import type { Redis } from 'ioredis';
import { Plugin as YogaPlugin } from 'graphql-yoga';
import { promisify } from 'util';

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
        waitTimeMS: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisWaitTimeMs,
        host: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisInstance,
        port: 6379,
      }
    : AUTOMATIC_PERSISTED_QUERY_PARAMS.redisCluster
    ? {
        ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisTTL,
        waitTimeMS: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisWaitTimeMs,
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

  private redisStore =
    this.redisParams &&
    instrumentedStore({
      name: 'apq',
      store: redisStore(this.redisParams),
    });

  async loadPersistedQueries(): Promise<{ id: string; query: string }[]> {
    const redisClient = this.redisStore?.client;
    const persistedQueries: { id: string; query: string }[] = [];

    const connected = await this.redisStore
      ?.ready()
      .then(() => true)
      .catch(() => false);

    if (redisClient && connected) {
      const redises =
        'nodes' in redisClient ? redisClient.nodes() : [redisClient];
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
      instrumentedStore({
        name: 'apq',
        store: memoryStore({
          max: AUTOMATIC_PERSISTED_QUERY_PARAMS.memCacheSize,
          ttl: AUTOMATIC_PERSISTED_QUERY_PARAMS.redisTTL,
        }),
      })
    );

    // Try to establish connection to redis before we start handling traffic
    await this.redisStore?.ready().catch((err) => {
      logger.error(
        `Failed to connect to apq redis store: ${err?.message || err}`
      );
    });

    const redisCache = this.redisStore && (await caching(this.redisStore));

    const apqStore: APQStore = multiCaching(
      [memoryCache, redisCache].filter(isCache)
    );

    return useAPQ({ store: apqStore });
  }
}
