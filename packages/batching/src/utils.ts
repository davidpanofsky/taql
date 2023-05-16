import type { BatchLoadFn, Options as DataLoaderOptions } from 'dataloader';
import type { ExecutionRequest, ExecutionResult } from '@graphql-tools/utils';
import type { ForwardableHeaders, TaqlState } from '@taql/context';
import type { BatchingConfig } from '@ta-graphql-utils/stitch';

export type TaqlRequest = ExecutionRequest<Record<string, unknown>, TaqlState>;
export type TaqlBatchLoader = (args: {
  request: Readonly<TaqlRequest[]>;
  forwardHeaders: ForwardableHeaders | undefined;
}) => ReturnType<BatchLoadFn<TaqlRequest, ExecutionResult>>;

export type BatchEntry<T> = { val: T; idx: number };

export const translateConfigToLoaderOptions = <T = unknown, E = unknown>(
  config: BatchingConfig
): DataLoaderOptions<T, E> => ({
  batchScheduleFn: (callback) => setTimeout(callback, config?.wait?.millis),
  maxBatchSize: config.maxSize,
});

export type BatchingOptions<
  T,
  V extends string | number | symbol,
  U extends string | number | symbol
> = {
  /** Method to extract batch keys from values */
  subBatchIdFn?: (val: T) => V;
  /**
   * Method to compare values. Must be transitive, e.g. subBatchEqFn(a, b) =>
   * true and subBatchEqFn(b, c) => true implies subBatchEqFn(a, c) => true,
   * and likewise subBatchEqFn(a, b) => true and subBatchEqFn(b, c) => false
   * implies subBatchEqFn(a, c) => false. Return true they are allowed in the
   * same batch; false otherwise.
   */
  subBatchEqFn?: (lhs: T, rhs: T) => boolean;
  /*
   * Method to extract a series id from values. Whenever the current val has a
   * different series id than the previous val, all prior batches are _frozen_,
   * and subsequently vals can only be added to new batches. Suppose inputs [a,
   * b, c, d], with batch ids [1,1,2,1] and series ids [1,2,2,2]; they will be
   * batched into [[a],[b,d],[c]].
   */
  seriesIdFn?: (val: T) => U;
  /**
   * Cluster items in batches, potentially breaking them down into
   * sub-batches if items in batches cannot be clustered together.
   *
   * Prefer using series ids to clusters when possible; clustering is
   * always a more expensive operation.
   */
  clustering?: {
    /**
     * Use this comparator to order items in the batch to prepare for clustering
     */
    comparator?: (lhs: T, rhs: T) => number;
    /**
     * Compare a potential update to a cluster to the first item in a cluster; if false,
     * the update is rejected from the cluster and put into a new cluster.
     */
    clusterable: (base: T, update: T) => boolean;
  };
  /**
   * The maximum size of a batch. If unset, there will be no limit.
   */
  maxSize?: number;
};

export type BatchingParams<
  T,
  V extends string | number | symbol,
  U extends string | number | symbol
> = T extends V
  ? [vals: ReadonlyArray<T>, options?: BatchingOptions<T, V, U>]
  : [
      vals: ReadonlyArray<T>,
      options: BatchingOptions<T, V, U> &
        Required<Pick<BatchingOptions<T, V, U>, 'subBatchIdFn'>>
    ];

/**
 * Break the vals array into batches using subBatchIdFn to derive batch keys.
 * Vals are batched by first being divided into series by seriesIdFn, then by
 * bucketing over an extracted key, then an explicit comparison which must be
 * true for all vals in a batch. In other words, batching is fundamentally
 * similar to a multimap with a custom provided hash and equals method. If the
 * comparison method is not provided, only the extracted id is used
 *
 * Ordering: Within a batch, items appear in the order they appeared in the
 * original array. Batches are ordered by the position of the first item in
 * each batch within the original list.
 *
 * @return {{val: T, idx: number}[][]} a list of batches. Each entry in a batch
 * is paired with the index at which it originally appeared in the input.
 */
export const batchByKey = <
  T,
  V extends string | number | symbol,
  U extends string | number | symbol
>(
  ...args: BatchingParams<T, V, U>
): BatchEntry<T>[][] => {
  const vals = args[0];
  // subbatchIdFn can only be undefined if T extends V, ergo T is a valid V in these cases.
  const subBatchIdFn: (val: T) => V =
    args[1]?.subBatchIdFn || ((x) => <V>(<unknown>x));
  const { subBatchEqFn, seriesIdFn, maxSize } = args[1] || {};
  if (vals.length === 1) {
    // don't do anything if we don't have to. It might be expensive.
    return [[{ val: vals[0], idx: 0 }]];
  }
  const results: BatchEntry<T>[][] = [];
  const ids: Map<V, BatchEntry<T>[][]> = new Map();
  let series: U | undefined = undefined;
  let idx = 0;
  vals
    .map((val) => ({ val, key: subBatchIdFn(val) }))
    .forEach(({ val, key }) => {
      if (series !== (series = seriesIdFn?.(val))) {
        // The series value changed! By clearing the id-to-batch map, we freeze
        // existing batches and begin adding values to _new_ batches.
        ids.clear();
      }

      // find the batches for this series with this hash.
      let seriesIdBatches = ids.get(key);
      if (seriesIdBatches == undefined) {
        seriesIdBatches = [];
        ids.set(key, seriesIdBatches);
      }

      let batchIdx = 0;
      if (subBatchEqFn != undefined) {
        // Find the specific batch this value is valid for
        batchIdx = seriesIdBatches.findIndex((b) =>
          subBatchEqFn(b[0]?.val, val)
        );
      }
      if (
        maxSize != undefined &&
        seriesIdBatches[batchIdx]?.length >= maxSize
      ) {
        // The batch for this val is full. Remove it from further
        // consideration, which will force a new batch to be started for this
        // val and the vals it matches
        seriesIdBatches.splice(batchIdx, 1);
      }

      let batch: BatchEntry<T>[] | undefined = seriesIdBatches[batchIdx];

      // Create a new batch if needed
      if (batch == undefined) {
        batch = [];
        // add it to the set of batches for this series with this hash.
        seriesIdBatches.push(batch);
        // add it to our results list
        results.push(batch);
      }

      // Add the value to the batch
      batch.push({ val, idx: idx++ });
    });

  const clusteringConfig = args[1]?.clustering;
  if (clusteringConfig) {
    // break the batch into clusters

    // Iterate over the results batches backwards so we can add to results
    // behind our index _without breaking our index_.
    for (let i = results.length - 1; i >= 0; i--) {
      const batch = [...results[i]];
      const comparator = clusteringConfig.comparator;
      if (comparator != undefined) {
        batch.sort((lhs, rhs) => comparator(lhs.val, rhs.val));
      }
      const clusters: BatchEntry<T>[][] = [];
      let cluster: BatchEntry<T>[] = [];
      batch.forEach((item) => {
        if (
          cluster.length != 0 &&
          !clusteringConfig.clusterable(cluster[0].val, item.val)
        ) {
          // If the item can't be added to the current cluster, start a new cluster.
          clusters.push(cluster);
          cluster = [];
        }
        cluster.push(item);
      });
      // replace the batch with the clusters
      if (clusters.length > 1) {
        results.splice(i, 1, ...clusters);
      }
    }
  }
  return results;
};

/**
 * Restore original order to flattened batch outputs.
 *
 * @param {{val: T, idx: number}[][]} batches The batches to base our ordering
 * on
 * @param {V[]} flattenedResults The items to reorder.
 *
 * If values T[] are batched via {@link batchByKey}, flattened (see
 * Array.prototype.flat), and mapped via function F (not provided) to create
 * flattenedResults V[], this will reorder flattenedResults such that it is
 * equivalent to the output of values.map(F). That is,
 *
 * ```
 * const values: T[] = [...]
 * const batched = batchByKey(values, () => Math.floor(Math.random() * 5));
 * const transform = (val: T): V => val.makeV();
 * const batchTransformed = batched.flat().map(({val}) => tranform(val));
 * const restored = restoreOrder(batched, batchTransformed);
 * const rawTransformed = values.map(transform);
 *
 * deepEquals(restored, rawTransformed)
 * // true
 * ```
 *
 * @return {V[]} reordered results.
 *
 */
export const restoreOrder = <T, V>(
  batches: BatchEntry<T>[][],
  flattenedResults: ArrayLike<V>[]
): V[] => {
  const order = batches.flat();
  const orderedResults = Array(order.length);
  flattenedResults
    .flat()
    .forEach((result, idx) => (orderedResults[order[idx].idx] = result));
  return orderedResults;
};
