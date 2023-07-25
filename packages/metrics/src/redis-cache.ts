import { Cache, caching } from 'cache-manager';
import { RedisCache, ioRedisStore } from '@tirke/node-cache-manager-ioredis';
import { logger, WORKER as worker } from '@taql/config';
import promClient from 'prom-client';

const REDIS_CLIENT_ERROR_COUNTER = new promClient.Counter({
  name: 'taql_redis_client_errors',
  help: 'outcomes of operations on caches',
  labelNames: ['name', 'worker', 'errorName'] as const,
});

export const isCache = <T extends Cache>(obj: T | undefined | void): obj is T =>
  !!obj && !!obj.store;

/**
 * Tries to connect to redis and returns cache object if successful.
 * If it fails it just logs the error and doesn't return anything.
 */
export async function getRedisCache(
  cacheName: string,
  ioRedisConfig: Parameters<typeof ioRedisStore>[0],
  timeoutMs = 2000
): Promise<RedisCache | void> {
  const store = ioRedisStore({
    ...ioRedisConfig,
    // if we fail, don't retry - we should instead fall back to other caches or recompute the value
    maxRetriesPerRequest: 1,
  });

  store.client.on('error', (err) => {
    // No point in logging this since it's too noisy and not particularly useful
    REDIS_CLIENT_ERROR_COUNTER.inc({
      name: cacheName,
      worker,
      errorName: err?.name || 'Error', // https://github.com/redis/ioredis/tree/main/lib/errors
    });
  });

  let waitTime = timeoutMs;
  while (store.client.status !== 'ready' && waitTime > 0) {
    waitTime -= 100;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (store.client.status === 'ready') {
    return caching(store).catch((err) => {
      logger.error(`Unable to create ${cacheName} redis cache.`, err);
    });
  } else {
    await store.client.quit();
    logger.error(
      `Timed out while trying to connect to redis after ${timeoutMs}ms. Redis config: ${JSON.stringify(
        ioRedisConfig
      )}`
    );
  }
}
