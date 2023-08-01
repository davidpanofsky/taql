/**
 * Mostly taken from https://github.com/node-cache-manager/node-cache-manager/blob/a20c6b6b37d935de190206245b6144153317ede8/src/stores/memory.ts
 * The following changes were made:
 *  - exposed underlying LRU cache
 *  - changed the default so that objects are not cloned when stored to cache
 *  - made all methods synchronous
 */

import { Cache, Config, Store } from 'cache-manager';
import { LRUCache } from 'lru-cache';
import cloneDeep from 'lodash.clonedeep';

function clone<T>(object: T): T {
  if (typeof object === 'object' && object !== null) {
    return cloneDeep(object);
  }
  return object;
}

export type MemoryConfig = {
  shouldCloneBeforeSet?: boolean;
} & Config &
  LRUCache.Options<string, unknown, unknown>;

export type MemoryStore<T = unknown> = Store<T> & {
  // @ts-expect-error LRUCache has unnecessary constraint on value type
  lruCache: LRUCache<string, T>;
};

// @ts-expect-error cache-manager will complain about synchronous API, but it works perfectly fine nonetheless
export type MemoryCache<T = unknown> = Cache<MemoryStore<T>>;

export function isMemoryStore<T = unknown>(
  store: Store<T>
): store is MemoryStore<T> {
  return 'lruCache' in store && store.lruCache instanceof LRUCache;
}

/**
 * Wrapper for lru-cache.
 */
export function memoryStore<T>(args: MemoryConfig): MemoryStore<T> {
  const shouldCloneBeforeSet = !!args?.shouldCloneBeforeSet; // do not clone by default
  const isCacheable = args?.isCacheable ?? ((val) => val !== undefined);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lruCache = new LRUCache<string, any>(args);

  return {
    del(key) {
      lruCache.delete(key);
    },
    get: <T>(key: string) => lruCache.get(key) as T,
    keys: () => [...lruCache.keys()],
    mget: (...args) => args.map((x) => lruCache.get(x)),
    mset(args, ttl?) {
      const opt = { ttl: ttl !== undefined ? ttl : lruCache.ttl } as const;
      for (const [key, value] of args) {
        if (!isCacheable(value)) {
          throw new Error(`no cacheable value ${JSON.stringify(value)}`);
        }
        if (shouldCloneBeforeSet) {
          lruCache.set(key, clone(value), opt);
        } else {
          lruCache.set(key, value, opt);
        }
      }
    },
    mdel(...args) {
      for (const key of args) {
        lruCache.delete(key);
      }
    },
    reset() {
      lruCache.clear();
    },
    ttl: (key) => lruCache.getRemainingTTL(key),
    set(key, value, opt) {
      if (!isCacheable(value)) {
        throw new Error(`no cacheable value ${JSON.stringify(value)}`);
      }
      if (shouldCloneBeforeSet) {
        value = clone(value);
      }

      const ttl = opt !== undefined ? opt : lruCache.ttl;

      lruCache.set(key, value, { ttl });
    },
    lruCache,
  };
}
