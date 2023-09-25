import { type MemoryStore, isMemoryStore } from './memory-store';
import { type RedisStore, isRedisStore } from './redis-store';
import promClient, { Gauge } from 'prom-client';
import { SpanKind } from '@opentelemetry/api';
import type { Store } from 'cache-manager';
import { logger } from '@taql/config';
import { tracerProvider } from '@taql/observability';
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

const tracer = tracerProvider.getTracer('taql');
enum AttributeName {
  CACHE_OPERATION = 'taql.cache.operation',
  CACHE_ERROR = 'taql.cache.error',
  CACHE_STATUS = 'taql.cache.status',
  CACHE_NAME = 'taql.cache.name',
  CACHE_TYPE = 'taql.cache.type',
}

const buckets = [0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1];

const OPERATION_DURATION_HISTOGRAM = new promClient.Histogram({
  name: 'taql_cache_operations',
  help: 'outcomes of operations on caches',
  buckets,
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

  const handleOperation = <T>(
    operation: keyof Store,
    getPromiseOrResult: () => T | Promise<T>,
    getStatus?: (result: T) => string
  ) => {
    const cacheSpan = tracer.startSpan(`cache.${operation}`, {
      kind: SpanKind.SERVER,
      attributes: {
        [AttributeName.CACHE_OPERATION]: operation,
        [AttributeName.CACHE_NAME]: name,
        [AttributeName.CACHE_TYPE]: type,
      },
    });

    const stopTimer = OPERATION_DURATION_HISTOGRAM.startTimer({
      name,
      type,
      worker,
      operation,
    });

    let promiseOrResult;
    try {
      promiseOrResult = getPromiseOrResult();
    } catch (err) {
      stopTimer({ status: 'error' });
      cacheSpan.recordException({
        name: AttributeName.CACHE_ERROR,
        message: JSON.stringify(err),
      });
      cacheSpan.end();
      if (emptyOnError) {
        return undefined;
      } else {
        throw err;
      }
    }

    if (promiseOrResult instanceof Promise) {
      return promiseOrResult
        .then((result) => {
          const status = getStatus?.(result) || 'success';
          stopTimer({ status });
          cacheSpan.setAttribute(AttributeName.CACHE_STATUS, status);
          cacheSpan.end();
          return result;
        })
        .catch((err) => {
          stopTimer({ status: 'error' });
          cacheSpan.recordException({
            name: AttributeName.CACHE_ERROR,
            message: JSON.stringify(err),
          });
          cacheSpan.end();
          return emptyOnError ? undefined : Promise.reject(err);
        });
    } else {
      const status = getStatus?.(promiseOrResult) || 'success';
      stopTimer({ status });
      cacheSpan.setAttribute(AttributeName.CACHE_STATUS, status);
      cacheSpan.end();
      return promiseOrResult;
    }
  };

  const get = (key: string) =>
    handleOperation(
      'get',
      () => store.get(key),
      (result) => (result === undefined ? 'miss' : 'hit')
    );

  const mget = (...keys: string[]) =>
    handleOperation(
      'mget',
      () => store.mget(...keys),
      (results) => {
        if (results.some((r) => r === undefined)) {
          return 'partial';
        } else if (results.every((r) => r === undefined)) {
          return 'miss';
        } else {
          return 'hit';
        }
      }
    );

  const set = (key: string, value: T, ttl?: number) =>
    handleOperation('set', () => store.set(key, value, ttl));

  const mset = (entries: [string, T][], ttl?: number) =>
    handleOperation('mset', () => store.mset(entries, ttl));

  const del = (key: string) => handleOperation('del', () => store.del(key));

  const mdel = (...keys: string[]) =>
    handleOperation('mdel', () => store.mdel(...keys));

  const reset = () => handleOperation('reset', () => store.reset());

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
