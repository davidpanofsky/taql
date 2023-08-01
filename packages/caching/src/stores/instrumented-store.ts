import { type MemoryStore, isMemoryStore } from './memory-store';
import { type RedisStore, isRedisStore } from './redis-store';
import promClient, { Gauge } from 'prom-client';
import type { Store } from 'cache-manager';
import { logger } from '@taql/config';
import { WORKER as worker } from '@taql/config';

export enum StoreType {
  MEMORY = 'memory',
  REDIS = 'redis',
  UNKNOWN = 'unknown',
}

export function getStoreType(store: Store): StoreType {
  if (isMemoryStore(store)) {
    return StoreType.MEMORY;
  } else if (isRedisStore(store)) {
    return StoreType.REDIS;
  } else {
    return StoreType.UNKNOWN;
  }
}

export type InstrumentedStore<T extends Store> = {
  name: string;
} & T;

const caches: Map<
  string,
  WeakRef<InstrumentedStore<MemoryStore | RedisStore | Store>>
> = new Map();

const OPERATION_COUNTER = new promClient.Counter({
  name: 'taql_cache_operations',
  help: 'outcomes of operations on caches',
  labelNames: ['name', 'type', 'worker', 'operation', 'status'] as const,
});

const ERROR_COUNTER = new promClient.Counter({
  name: 'taql_cache_errors',
  help: 'cache errors (e.g. failures when connecting to remote)',
  labelNames: ['name', 'type', 'worker', 'errorName'] as const,
});

const cacheGauge = (
  /**
   * A gauge accepting a name label, intended to be the name of a cache, and a
   * worker label, intended to identify the current worker
   */
  gauge: Gauge<'name' | 'type' | 'worker'>,
  /**
   * Compute the value of the gauge given a cache. If the val is undefined,
   * the gauge will be deleted.
   */
  val: (
    store: InstrumentedStore<MemoryStore | RedisStore | Store>,
    gauge: Gauge<'name' | 'type' | 'worker'>
  ) => number | undefined | Promise<number | undefined>
) => {
  caches.forEach(async (cacheRef, key) => {
    const cache = cacheRef.deref();
    if (cache == undefined) {
      caches.delete(key);
      return;
    }
    const computedVal = await val(cache, gauge);
    const labels = {
      name: cache.name,
      type: getStoreType(cache),
      worker,
    };
    if (computedVal != undefined) {
      gauge.set(labels, computedVal);
    } else {
      gauge.remove(labels);
    }
  });
};

new promClient.Gauge({
  name: 'taql_cache_size',
  help: 'Sizes (as in cardinality) of caches',
  labelNames: ['name', 'type', 'worker'],
  collect() {
    cacheGauge(this, (cache) => {
      if (isMemoryStore(cache)) {
        return cache.lruCache.size;
      }
      return undefined;
    });
  },
});

new promClient.Gauge({
  name: 'taql_cache_calculated_size',
  help: 'Sizes (as in weights) of caches.',
  labelNames: ['name', 'type', 'worker'],
  collect() {
    cacheGauge(this, (cache) => {
      if (isMemoryStore(cache)) {
        return cache.lruCache.sizeCalculation && cache.lruCache.calculatedSize;
      }
      return undefined;
    });
  },
});

new promClient.Gauge({
  name: 'taql_cache_max_size',
  help: 'Maximum sizes (as in cardinality) of caches',
  labelNames: ['name', 'type', 'worker'],
  collect() {
    cacheGauge(this, (cache) => {
      if (isMemoryStore(cache)) {
        return cache.lruCache.max;
      }
      return undefined;
    });
  },
});

new promClient.Gauge({
  name: 'taql_cache_max_calculated_size',
  help: 'Maximum sizes (as in weights) of caches',
  labelNames: ['name', 'type', 'worker'],
  collect() {
    cacheGauge(this, (cache) => {
      if (isMemoryStore(cache)) {
        return cache.lruCache.maxSize;
      }
      return undefined;
    });
  },
});

new promClient.Gauge({
  name: 'taql_cache_ttl',
  help: 'TTL for cache entries',
  labelNames: ['name', 'type', 'worker'],
  collect() {
    cacheGauge(this, (cache) => {
      if (isMemoryStore(cache)) {
        return cache.lruCache.ttl;
      }
      return undefined;
    });
  },
});

export function instrumentedStore<T, S extends Store<T>>({
  store,
  name,
  emptyOnError = true,
}: {
  store: S;
  name: string;
  emptyOnError?: boolean;
}): InstrumentedStore<S> {
  const type = getStoreType(store);

  if (isRedisStore(store)) {
    store.client.on('error', (err) => {
      // No point in logging this since it's too noisy and not particularly useful
      ERROR_COUNTER.inc({
        name,
        type,
        worker,
        errorName: err?.name || 'Error', // https://github.com/redis/ioredis/tree/main/lib/errors
      });
    });
  }

  const record = (operation: keyof Store, status = 'success', value = 1) => {
    OPERATION_COUNTER.inc(
      {
        name,
        type,
        worker,
        operation,
        status,
      },
      value
    );
  };

  const handleOperation = <T>(
    promiseOrResult: T | Promise<T>,
    recordFn: (result: T) => void,
    recordErrorFn?: (error: Error) => void
  ) => {
    if (promiseOrResult instanceof Promise) {
      return promiseOrResult
        .then((result) => {
          recordFn(result);
          return result;
        })
        .catch((err) => {
          recordErrorFn?.(err);
          return emptyOnError ? undefined : Promise.reject(err);
        });
    } else {
      recordFn(promiseOrResult);
      return promiseOrResult;
    }
  };

  const get = (key: string) =>
    handleOperation(
      store.get(key),
      (result) => record('get', result === undefined ? 'miss' : 'hit'),
      () => record('get', 'error')
    );

  const mget = (...keys: string[]) =>
    handleOperation(
      store.mget(...keys),
      (results) => {
        results.forEach((res) => {
          record('get', res === undefined ? 'miss' : 'hit');
        });
      },
      () => record('get', 'error', keys.length)
    );

  const set = (key: string, value: T, ttl?: number) =>
    handleOperation(
      store.set(key, value, ttl),
      () => record('set'),
      () => record('set', 'error')
    );

  const mset = (entries: [string, T][], ttl?: number) =>
    handleOperation(
      store.mset(entries, ttl),
      () => record('set', 'success', entries.length),
      () => record('set', 'error', entries.length)
    );

  const del = (key: string) =>
    handleOperation(
      store.del(key),
      () => record('del'),
      () => record('del', 'error')
    );

  const mdel = (...keys: string[]) =>
    handleOperation(
      store.mdel(...keys),
      () => record('del', 'success', keys.length),
      () => record('del', 'error', keys.length)
    );

  const reset = () =>
    handleOperation(
      store.reset(),
      () => record('reset'),
      () => record('reset', 'error')
    );

  const instrumentedStore: InstrumentedStore<S> = {
    ...store,
    get,
    mget,
    set,
    mset,
    del,
    mdel,
    reset,
    name,
  };

  const key = `${type}_${name}`;
  if (caches.get(key)?.deref()) {
    logger.warn(
      `Multiple caches instrumented with name ${name} and type ${type}`
    );
  }
  caches.set(key, new WeakRef(instrumentedStore));

  return instrumentedStore;
}
