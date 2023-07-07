import { LRUCache } from 'lru-cache';
import cloneDeep from 'lodash.clonedeep';

import { Config, Cache, Store } from 'cache-manager';

function clone<T>(object: T): T {
  if (typeof object === 'object' && object !== null) {
    return cloneDeep(object);
  }
  return object;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LRU = LRUCache<string, any, unknown>;

export type WrappedLRUConfig = {
  cache: LRU,
  shouldCloneBeforeSet?: boolean;
} & Config;

export type WrappedLRUStore = Store & {
  get size(): number;
  dump: LRU['dump'];
  load: LRU['load'];
  calculatedSize: LRU['calculatedSize'];
};

export type WrappedLRUCache = Cache<WrappedLRUStore>;

/**
 * True wrapper for lru-cache. Rather than initializing the LRU store, just accept one.
 * This allows us to use our InstrumentedCaches with node-cache-manager.
 */
export function wrappedLRUStore(args: WrappedLRUConfig): WrappedLRUStore {
  // Clone by default; this matches the default in memory implementation that ships with node-cache-manager
  const shouldCloneBeforeSet = args?.shouldCloneBeforeSet !== false;
  const isCacheable = args?.isCacheable ?? ((val) => val !== undefined);

  const lruCache = args.cache;

  return {
    async del(key) {
      lruCache.delete(key);
    },
    get: async <T>(key: string) => lruCache.get(key) as T,
    keys: async () => [...lruCache.keys()],
    mget: async (...args) => args.map((x) => lruCache.get(x)),
    async mset(args, ttl?) {
      const opt = { ttl: ttl !== undefined ? ttl : lruCache.ttl } as const;
      for (const [key, value] of args) {
        if (!isCacheable(value))
          throw new Error(`no cacheable value ${JSON.stringify(value)}`);
        if (shouldCloneBeforeSet) lruCache.set(key, clone(value), opt);
        else lruCache.set(key, value, opt);
      }
    },
    async mdel(...args) {
      for (const key of args) lruCache.delete(key);
    },
    async reset() {
      lruCache.clear();
    },
    ttl: async (key) => lruCache.getRemainingTTL(key),
    async set(key, value, opt) {
      if (!isCacheable(value)) {
        throw new Error(`no cacheable value ${JSON.stringify(value)}`);
      }
      if (shouldCloneBeforeSet) {
        value = clone(value);
      }

      const ttl = opt !== undefined ? opt : lruCache.ttl;

      lruCache.set(key, value, { ttl });
    },
    get calculatedSize() {
      return lruCache.calculatedSize;
    },
    /**
     * This method is not available in the caching modules.
     */
    get size() {
      return lruCache.size;
    },
    /**
     * This method is not available in the caching modules.
     */
    dump: () => lruCache.dump(),
    /**
     * This method is not available in the caching modules.
     */
    load: (...args: Parameters<LRU['load']>) => lruCache.load(...args),
  };
}
