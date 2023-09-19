import { ForwardHeaderName, TaqlContext } from '@taql/context';
import crypto from 'crypto';

/**
 * Define envelop and koa plugins to add private state useful for batching
 *
 * @author jacobkatz
 * @since 2022-12
 */

/** The set of headers we will ignore when otherwise batching requests together
 * by the header we are forwarding them along with.
 */
const batchIgnoreHeaders: ReadonlySet<ForwardHeaderName> = new Set([
  // These are (mostyl) unique per request, so comparing them undermines the
  // point of batching by headers.
  'x-guid',
  'x-request-id',
  // b3 headers are trace headers
  //'b3',
  //'x-b3-flags',
  //'x-b3-parentspanid',
  //'x-b3-sampled',
  //'x-b3-spanid',
  //'x-b3-traceid',
]);

export type BatchHeaders = (readonly [string, string])[];

const PRIVATE_STATE: WeakMap<TaqlContext, BatchingState> = new WeakMap();

type MutableBatchingState = {
  /**
   * A strictly unique-per-request value that is intentionally not meaningful
   * or worth transfering into another service, etc. We are not trying to
   * compete with or complement TA's request uids; we are just giving ourselves
   * a tool for trivially disambiguating requests where caches and other forms
   * of shared state are involved.
   */
  requestUnique: symbol;
  /** The set of forwarded headers we will batch on */
  batchByHeaders: BatchHeaders;
  /** A hash of those same headers */
  batchByHeadersHash: string;
};
type BatchingState = Readonly<MutableBatchingState>;

export const loadState = (ctx: TaqlContext): BatchingState => {
  const existing = PRIVATE_STATE.get(ctx);
  if (existing != undefined) {
    return existing;
  }

  const computed: BatchingState = {
    requestUnique: Symbol(),
    get batchByHeaders() {
      // filter the set of headers already on the request down to those
      // we will use for batching
      const batchByHeaders = Object.entries(ctx.forwardHeaders)
        .filter(([key]) => !batchIgnoreHeaders.has(<ForwardHeaderName>key))
        .flatMap(([key, vals]) => vals.map((val) => [key, val] as const))
        .sort(
          // sort so hashes, etc, are consistent and lists can be
          // compared cheaply. The resulting order does not matter except
          // for its consistency.
          (lhs, rhs) =>
            lhs[0].localeCompare(rhs[0]) || lhs[1].localeCompare(rhs[1])
        );
      // memoize... it's mutable _for us_.
      delete (<Partial<MutableBatchingState>>this).batchByHeaders;
      return ((<MutableBatchingState>this).batchByHeaders = batchByHeaders);
    },
    // Compute a hash from the headers we'll batch by. This can be used
    // to avoid expensive comparisons of entire header lists.
    get batchByHeadersHash() {
      const hash = crypto.createHash('md5');
      this.batchByHeaders?.forEach((tuple) =>
        hash.update(tuple[0]).update(tuple[1])
      );
      const batchByHeadersHash = hash.digest('hex');
      // memoize... it's mutable _for us_.
      delete (<Partial<MutableBatchingState>>this).batchByHeadersHash;
      return ((<MutableBatchingState>this).batchByHeadersHash =
        batchByHeadersHash);
    },
  };
  PRIVATE_STATE.set(ctx, computed);
  return computed;
};
