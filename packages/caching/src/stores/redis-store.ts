/**
 * Mostly taken from https://github.com/node-cache-manager/node-cache-manager-ioredis-yet/blob/894cc872a507cd7f2a00a17429aa932df1d49cd0/src/index.ts
 * Changes include:
 *  - updated the types so that we can specify return type when creating the store
 *  - changed default redis options
 */

import type { Cache, Config, Store } from 'cache-manager';
import Redis, {
  Cluster,
  ClusterNode,
  ClusterOptions,
  RedisOptions,
} from 'ioredis';

// @ts-expect-error we've redefined Store type to allow non-Promises and Cache type isn't happy about that
export type RedisCache<T = unknown> = Cache<RedisStore<T>>;

type StoreConfig = Config & {
  waitTimeMs?: number;
};

export interface RedisStore<T = unknown> extends Store<T> {
  readonly isCacheable: (value: T) => boolean;
  get client(): Redis | Cluster;
  ready(timeoutMs?: number): Promise<void>;
}

const getVal = (value: unknown) => JSON.stringify(value) || '"undefined"';

export function isRedisStore<T = unknown>(
  store: Store<T>
): store is RedisStore<T> {
  return (
    'client' in store &&
    (store.client instanceof Redis || store.client instanceof Cluster)
  );
}

export class NoCacheableError implements Error {
  name = 'NoCacheableError';
  constructor(public message: string) {}
}

export const avoidNoCacheable = async <T>(p: Promise<T | void>) => {
  try {
    return await p;
  } catch (e) {
    if (!(e instanceof NoCacheableError)) {
      throw e;
    }
  }
};

function builder<T>(
  redisCache: Redis | Cluster,
  reset: () => Promise<void>,
  keys: (pattern: string) => Promise<string[]>,
  options?: StoreConfig
): RedisStore<T> {
  const isCacheable =
    options?.isCacheable || ((value) => value !== undefined && value !== null);

  return {
    async get(key: string) {
      const val = await redisCache.get(key);
      if (val === undefined || val === null) {
        return undefined;
      } else {
        return JSON.parse(val) as T;
      }
    },
    async set(key, value, ttl) {
      if (!isCacheable(value)) {
        throw new NoCacheableError(`"${value}" is not a cacheable value`);
      }
      const t = ttl === undefined ? options?.ttl : ttl;
      if (t !== undefined && t !== 0) {
        await redisCache.set(key, getVal(value), 'PX', t);
      } else {
        await redisCache.set(key, getVal(value));
      }
    },
    async mset(args, ttl) {
      const t = ttl === undefined ? options?.ttl : ttl;
      if (t !== undefined && t !== 0) {
        const multi = redisCache.multi();
        for (const [key, value] of args) {
          if (!isCacheable(value)) {
            throw new NoCacheableError(
              `"${getVal(value)}" is not a cacheable value`
            );
          }
          multi.set(key, getVal(value), 'PX', t);
        }
        await multi.exec();
      } else {
        await redisCache.mset(
          args.flatMap(([key, value]) => {
            if (!isCacheable(value)) {
              throw new Error(`"${getVal(value)}" is not a cacheable value`);
            }
            return [key, getVal(value)] as [string, string];
          })
        );
      }
    },
    mget: (...args) =>
      redisCache
        .mget(args)
        .then((x) =>
          x.map((x) =>
            x === null || x === undefined
              ? undefined
              : (JSON.parse(x) as unknown)
          )
        ),
    async mdel(...args) {
      await redisCache.del(args);
    },
    async del(key) {
      await redisCache.del(key);
    },
    ttl: async (key) => redisCache.pttl(key),
    keys: (pattern = '*') => keys(pattern),
    reset,
    isCacheable,
    get client() {
      return redisCache;
    },
    async ready(timeoutMs = options?.waitTimeMs || 2000) {
      let waitTime = timeoutMs;
      while (redisCache.status !== 'ready' && waitTime > 0) {
        waitTime -= 100;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (redisCache.status !== 'ready') {
        throw new Error(
          `Timed out while waiting for redis connection. Status: ${redisCache.status}`
        );
      }
    },
  };
}

export interface RedisClusterConfig {
  nodes: ClusterNode[];
  options?: ClusterOptions;
}

export function redisStore<T>(
  options: (RedisOptions | { clusterConfig: RedisClusterConfig }) &
    Config & {
      waitTimeMs?: number;
    }
) {
  const baseRedisOptions: RedisOptions = {
    // This defaults to 20, but we don't want to retry - we should instead fall back to other caches or recompute the value
    maxRetriesPerRequest: 1,
    // By default ioredis will resend stuff that queued up / failed while redis was offline.
    // We everything to fail instead, and not wait indefinitely (or longer than it takes to recompute the value).
    autoResendUnfulfilledCommands: false,
    enableOfflineQueue: false,
    // The default retry strategy is Math.min(times * 50, 2000)
    retryStrategy(times) {
      const delay = Math.min(times * 100, options.waitTimeMs || 2000);
      return delay;
    },
  };

  const redisCache =
    'clusterConfig' in options
      ? new Redis.Cluster(options.clusterConfig.nodes, {
          ...baseRedisOptions,
          ...options.clusterConfig.options,
        })
      : new Redis({
          ...baseRedisOptions,
          ...options,
        });

  return redisInsStore<T>(redisCache, options);
}

export function redisInsStore<T>(
  redisCache: Redis | Cluster,
  options?: Config
) {
  const reset = async () => {
    await redisCache.flushdb();
  };
  const keys = (pattern: string) => redisCache.keys(pattern);

  return builder<T>(redisCache, reset, keys, options);
}
