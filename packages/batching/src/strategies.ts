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

export type BatchingStrategy =
  | 'BatchByInboundRequest'
  | 'BatchByUpstreamHeaders'
  | 'InsecurelyBatchIndiscriminately';

type Strategy = (
  executor: TaqlBatchLoader
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

const byRequestStrategy: Strategy =
  (executor: TaqlBatchLoader) => async (requests) => {
    const batches = batchByKey(requests, {
      subBatchIdFn: (req) =>
        // Fall back to a symbol (which will never match another value)
        req.context?.state._batching.requestUnique || Symbol(),
      seriesIdFn,
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
  (executor: TaqlBatchLoader) => async (requests) => {
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
  /**
   * Barely permissive. Requests to upstream services triggered by the same
   * request to taql may be batched.
   */
  BatchByInboundRequest: byRequestStrategy,
  /**
   * Moderately permissive. Requests to upstream services using this strategy
   * may be batched with any other upstream request to that service so long as
   * each upstream request has identical headers. The principle here is that if
   * the service relies on headers to determine the contents of the response
   * (say, for security reasons), and the requests have the same headers, the
   * upstream service will make the same determinations either way. That is,
   * such requests implicitly have the same origin.
   *
   * Note: Tracing headers (e.g., b3, x-b3-*) are ignored for these purposes.
   */
  BatchByUpstreamHeaders: byHeadersStrategy,
  /**
   * Note: This is incredibly dangerous. It has impressive performance
   * implications, but you should use this strategy in only the most
   * constrained, well-understood cases, or you will be the reason we're paying
   * out an expensive bug bounty. Your call.
   *
   * Most permissive. Requests to upstream services may be batched together
   * regardless of origin, with only headers from the first request sent
   * upstream. If the upstream service consumes headers to provide security,
   * this is incredibly dangerous, and should be used with caution.
   */
  InsecurelyBatchIndiscriminately: insecureStrategy,
};
