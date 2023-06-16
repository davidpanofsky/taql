import { logger } from '@taql/config';
/**
 * A weak map with _two_ weak keys.
 * Order matters under the hood: the longest-lived keys should be first. for best performance.
 */
export class BiWeakMap<
  K1 extends NonNullable<unknown>,
  K2 extends NonNullable<unknown>,
  V
> {
  private delegate = new WeakMap<K1, WeakMap<K2, V>>();

  set(k1: K1, k2: K2, val: V) {
    let k2Delegate = this.delegate.get(k1);
    if (k2Delegate == undefined) {
      k2Delegate = new WeakMap<K2, V>();
      this.delegate.set(k1, k2Delegate);
    }
    k2Delegate.set(k2, val);
  }

  get(k1: K1, k2: K2): V | undefined {
    return this.delegate.get(k1)?.get(k2);
  }
}

export const logPrewarm = async <T>(
  stage: string,
  entriesArg: undefined | T[] | (() => T[] | undefined),
  fun: (entry: T) => void | Promise<void>
) => {
  const entries = typeof entriesArg == 'function' ? entriesArg() : entriesArg;
  if (entries == undefined || entries.length == 0) {
    logger.info(`prewarm skipping ${stage}, 0 items to warm`);
    return;
  }

  logger.info(`prewarming ${stage} (${entries.length} item(s))`);
  const start = Date.now();
  for (const entry of entries) {
    await fun(entry);
  }
  logger.info(
    `prewarmed ${stage} (${entries.length} item(s)) in ${Date.now() - start}ms`
  );
};
