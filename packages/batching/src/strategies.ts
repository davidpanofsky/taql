import { BatchingConfig, BatchingStrategy } from '@taql/batching-config';
import {
  ExecutionResult,
  getOperationASTFromRequest,
} from '@graphql-tools/utils';
import {
  TaqlBatchLoader,
  TaqlRequest,
  batchByKey,
  restoreOrder,
} from './utils';

import type { BatchHeaders } from './context';
import type { BatchLoadFn } from 'dataloader';

type Strategy = (
  executor: TaqlBatchLoader,
  config: BatchingConfig
) => BatchLoadFn<TaqlRequest, ExecutionResult>;

/**
 * Extract the operation type from the request. Intended to be passed as an
 * option to `batchByKey`, it will prevent requests with different series ids
 * from being batched together, and prevent two requests from being batched
 * together _if there is a request with a different series id between them in
 * the input list_. This will ensure basic ordering assumptions hold, so for
 * example a mutation will not be pulled into a batch ahead of a query that was
 * made before the mutation was made.
 */
const seriesIdFn = (req: TaqlRequest) =>
  getOperationASTFromRequest(req).operation;

const byRequestStrategy: Strategy = (executor, config) => async (requests) => {
  const batches = batchByKey(requests, {
    subBatchIdFn: (req) =>
      // Fall back to a symbol (which will never match another value)
      req.context?.state._batching.requestUnique || Symbol(),
    seriesIdFn,
    maxSize: config.maxSize,
  });
  const resultBatches = await Promise.all(
    batches.map((subBatch) =>
      executor({
        request: subBatch.map((sub) => sub.val),
        forwardHeaders: subBatch[0]?.val?.context?.state.forwardHeaders,
      })
    )
  );
  return restoreOrder(batches, resultBatches);
};

// Check a list of headers _assumed to be ordered_ for equality.
const headersEqual = (
  lhsHeaders?: BatchHeaders,
  rhsHeaders?: BatchHeaders
): boolean =>
  // When queries are submitted from clients in batches already, these will
  // be the exact same object often enough it's worth adding this cheap check
  // to potentially skip expensive ones.
  lhsHeaders === rhsHeaders ||
  // the both-undefined case is a match, actually, but covered by the direct
  // equality check above.
  (lhsHeaders != undefined &&
    rhsHeaders != undefined &&
    lhsHeaders.length === rhsHeaders.length &&
    lhsHeaders.every((lhs, i) => {
      const rhs = rhsHeaders[i];
      return lhs[0] === rhs[0] && lhs[1] === rhs[1];
    }));

const byHeadersStrategy: Strategy =
  (executor: TaqlBatchLoader, config: BatchingConfig) => async (requests) => {
    const batches = batchByKey(requests, {
      subBatchIdFn: (req) =>
        // Fall back to a symbol (which will never match another value)
        req.context?.state._batching.batchByHeadersHash || Symbol(),
      subBatchEqFn: (lhs, rhs) =>
        headersEqual(
          lhs.context?.state?._batching.batchByHeaders,
          rhs.context?.state?._batching.batchByHeaders
        ),
      seriesIdFn,
      maxSize: config.maxSize,
    });

    const resultBatches = await Promise.all(
      batches.map((subBatch) =>
        executor({
          request: subBatch.map((sub) => sub.val),
          forwardHeaders: subBatch[0]?.val?.context?.state.forwardHeaders,
        })
      )
    );
    return restoreOrder(batches, resultBatches);
  };

const insecureStrategy: Strategy = (executor: TaqlBatchLoader) => (request) =>
  executor({
    request,
    forwardHeaders: request[0]?.context?.state.forwardHeaders,
  });

export const STRATEGIES: Record<BatchingStrategy, Strategy> = {
  [BatchingStrategy.BatchByInboundRequest]: byRequestStrategy,
  [BatchingStrategy.BatchByUpstreamHeaders]: byHeadersStrategy,
  [BatchingStrategy.InsecurelyBatchIndiscriminately]: insecureStrategy,
};
