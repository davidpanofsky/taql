import {
  ExecutionResult,
  Executor,
  getOperationASTFromRequest,
} from '@graphql-tools/utils';

import DataLoader from 'dataloader';
import { TaqlContext } from '@taql/context';
import { TaqlRequest } from './index';

type BatchEntry<T> = { val: T; idx: number };

/**
 * Break the vals array into batches using subBatchIdFn to derive batch keys.
 * Vals with the same batch key will end up in the same batch.
 *
 * Ordering: Within a batch, items appear in the order they appeared in the
 * original array. Batches are ordered by the position of the first item in
 * each batch within the original list.
 *
 * @param {ReadonlyArray<T>} vals Array of values to batch @param {(val: T) =>
 * V} subBatchIdFn Method to extract batch ids from values
 *
 * @return {{val: T, idx: number}[][]} a list of batches. Each entry in a batch
 * is paired with the index at which it originally appeared in the input.
 */
const batchByKey = <T, V extends string | number>(
  vals: ReadonlyArray<T>,
  subBatchIdFn: (val: T) => V
): BatchEntry<T>[][] => {
  if (vals.length == 1) {
    //don't keymap if we don't have to. it might be expensive.
    return [[{ val: vals[0], idx: 0 }]];
  }
  const results: BatchEntry<T>[][] = [];
  const ids: Partial<Record<V, BatchEntry<T>[]>> = {};
  let idx = 0;
  vals
    .map((val) => ({ val, key: subBatchIdFn(val) }))
    .forEach(({ val, key }) => {
      let batch = ids[key];
      if (batch == undefined) {
        batch = [];
        ids[key] = batch;
        results.push(batch);
      }
      batch.push({ val, idx: idx++ });
    });

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
const restoreOrder = <T, V>(
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

// This should not, for any given user, reorder queries and mutations... I think.
// TODO confirm that.
// TODO confirm that's important - I think it is because I have a hazy memory
// of legacy graphql code managing the order of service calls that are
// mutations specially with respect to optimizations and reordering, on principle
// that a batch containing a mutation and a query should execute the calls
// in a specific order (I forget if it is the order they appear in the batch,
// or strictly mutations-first, such that the queries will always see the result
// of the mutations). I should at least find the code in question in legacy graphql.
// TODO target this method for unit testing. There are good enough odds it's messed up.
/**
 * Wrap a batch loader function such that batches are divided into sub-batches
 * via `subBatchIdFn` and each sub-batch is executed independently before
 * results are merged into the expected order. See {@link subBatch} and {@link
 * restoreOrder} for implementation details
 *
 * @param {DataLoader.BatchLoadFn<T, R>} loadFn The loader to wrap
 * @param {(val: T) => K} subBatchIdFn The method to use to extract batch keys
 * from items in the batch.
 *
 * @return {DataLoader.BatchLoadFn<T, R>} a data loader that will divide the
 * batches it loads into sub-batches
 */
export const subBatch = <T, K extends string | number, R>(
  loadFn: DataLoader.BatchLoadFn<T, R>,
  subBatchIdFn?: (val: T) => K
): DataLoader.BatchLoadFn<T, R> =>
  subBatchIdFn == undefined
    ? loadFn
    : async (batch: ReadonlyArray<T>) => {
        const batches = batchByKey(batch, subBatchIdFn);
        const resultBatches = await Promise.all(
          batches.map((subBatch) => loadFn(subBatch.map((sub) => sub.val)))
        );
        return restoreOrder(batches, resultBatches);
      };

export const createBatchingExecutor = (
  loadFn: DataLoader.BatchLoadFn<TaqlRequest, ExecutionResult>,
  executor: Executor<TaqlContext>,
  dataLoaderOptions?: DataLoader.Options<TaqlRequest, ExecutionResult>
): Executor<TaqlContext> => {
  //TODO evaluate whether having caching disabled is the correct default. I
  //think it is; our keys are necessarily the batch identifier  (see
  //batchByKey) AND the details of the execution request, which is an object.
  //Computation will be expensive.
  const loader = new DataLoader(loadFn, { cache: false, ...dataLoaderOptions });
  return function batchingExecutor(request: TaqlRequest) {
    const operationAst = getOperationASTFromRequest(request);
    return operationAst.operation === 'subscription'
      ? executor(request)
      : loader.load(request);
  };
};
