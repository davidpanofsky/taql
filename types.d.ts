import * as cacheManager from 'cache-manager';

declare module 'cache-manager' {

  type MaybePromise<T> = T | Promise<T>;

  export type Store<T = unknown> = {
    get(key: string): MaybePromise<T | undefined>;
    set(key: string, data: T, ttl?: number): MaybePromise<void>;
    del(key: string): MaybePromise<void>;
    reset(): MaybePromise<void>;
    mset(args: (readonly [string, T])[], ttl?: number): MaybePromise<void>;
    mget(...args: string[]): MaybePromise<unknown[]>;
    mdel(...args: string[]): MaybePromise<void>;
    keys(pattern?: string): MaybePromise<string[]>;
    ttl(key: string): MaybePromise<number>;
  };

  export declare function caching<S extends Store>(store: S): Promise<cacheManager.Cache>;

}
