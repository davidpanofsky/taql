import promClient, { Gauge } from 'prom-client';
import { LRUCache } from 'lru-cache';
import { logger } from '@taql/config';
import { WORKER as worker } from '@taql/config';

const caches: Map<string, WeakRef<NonNullable<unknown>>> = new Map();

enum Operations {
  get = 'get',
  fetch = 'fetch',
  has = 'has',
  set = 'set',
}
const operations: Operations[] = Object.values(Operations);

const OPERATION_COUNTER = new promClient.Counter({
  name: 'taql_cache_operations',
  help: 'outcomes of operations on caches',
  labelNames: ['name', 'worker', 'operation', 'status'] as const,
});

type GenericCache = LRUCache<NonNullable<unknown>, NonNullable<unknown>>;

const cacheGauge = (
  /**
   * A gauge accepting a name label, intended to be the name of a cache, and a
   * worker label, intended to identify the current worker
   */
  gauge: Gauge<'name' | 'worker'>,
  /**
   * Compute the value of the gauge given a cache. If the val is undefined,
   * the gauge will be deleted.
   */
  val: (
    cache: GenericCache,
    gauge: Gauge<'name' | 'worker'>
  ) => number | undefined
) => {
  caches.forEach((cacheRef, name) => {
    const cache = <undefined | GenericCache>cacheRef.deref();
    if (cache == undefined) {
      caches.delete(name);
      return;
    }
    const computedVal = val(cache, gauge);
    if (computedVal != undefined) {
      gauge.set({ name, worker }, computedVal);
    } else {
      gauge.remove({ name, worker });
    }
  });
};

new promClient.Gauge({
  name: 'taql_cache_size',
  help: 'Sizes (as in cardinality) of caches',
  labelNames: ['name', 'worker'],
  collect() {
    cacheGauge(this, (cache) => cache.size);
  },
});

new promClient.Gauge({
  name: 'taql_cache_calculated_size',
  help: 'Sizes (as in weights) of caches.',
  labelNames: ['name', 'worker'],
  collect() {
    cacheGauge(this, (cache) => cache.sizeCalculation && cache.calculatedSize);
  },
});

new promClient.Gauge({
  name: 'taql_cache_max_size',
  help: 'Maximum sizes (as in cardinality) of caches',
  labelNames: ['name', 'worker'],
  collect() {
    cacheGauge(this, (cache) => cache.max || undefined);
  },
});

new promClient.Gauge({
  name: 'taql_cache_max_calculated_size',
  help: 'Maximum sizes (as in weights) of caches',
  labelNames: ['name', 'worker'],
  collect() {
    cacheGauge(this, (cache) => cache.maxSize || undefined);
  },
});

new promClient.Gauge({
  name: 'taql_cache_ttl',
  help: 'TTL for cache entries',
  labelNames: ['name', 'worker'],
  collect() {
    cacheGauge(this, (cache) => cache.ttl || undefined);
  },
});

/**
 * an LRUCache from lru-cache, but it's instrumented with prometheus.
 */
export class InstrumentedCache<
  K extends NonNullable<unknown>,
  V extends NonNullable<unknown>,
  FC = unknown
> extends LRUCache<K, V, FC> {
  private readonly name;

  constructor(name: string, options: LRUCache.Options<K, V, FC>) {
    super(options);
    this.name = name;
    if (caches.get(name)?.deref()) {
      logger.warn(`Multiple caches instrumented with name ${name}`);
    }
    caches.set(name, new WeakRef(this));
  }

  #record(args: { [K in Operations]?: string }) {
    operations.forEach((operation) => {
      const status = args[operation];
      if (status) {
        OPERATION_COUNTER.inc({
          name: this.name,
          worker,
          operation,
          status,
        });
      }
    });
  }

  set(...args: Parameters<LRUCache<K, V, FC>['set']>) {
    const options = (args[2] = args[2] ?? {});
    const status = (options.status = options.status ?? {});
    const result = super.set(...args);
    this.#record(status);
    return result;
  }

  has(...args: Parameters<LRUCache<K, V, FC>['has']>) {
    const options = (args[1] = args[1] ?? {});
    const status = (options.status = options.status ?? {});
    const result = super.has(...args);
    this.#record(status);
    return result;
  }

  // @ts-expect-error we are passing the methods arguments to iself... it's valid.
  // ts just has trouble with the overrides in this case.
  fetch(...args: Parameters<LRUCache<K, V, FC>['fetch']>) {
    // @ts-expect-error we are passing the methods arguments to iself... it's valid.
    // ts just has trouble with the overrides in this case.
    const options: LRUCache.FetchOptions<K, V, FC> = (args[1] = args[1] ?? {});
    const status = (options.status = options.status ?? {});
    const result = super.fetch(...args);
    this.#record(status);
    return result;
  }

  get(...args: Parameters<LRUCache<K, V, FC>['get']>) {
    const options = (args[1] = args[1] ?? {});
    const status = (options.status = options.status ?? {});
    const result = super.get(...args);
    this.#record(status);
    return result;
  }
}
