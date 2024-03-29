import { BatchHeaders, loadState } from './context';
import { BatchingConfig, BatchingStrategy } from '@ta-graphql-utils/stitch';
import {
  ExecutionResult,
  getOperationASTFromRequest,
} from '@graphql-tools/utils';
import { ForwardHeaderName, ForwardableHeaders } from '@taql/context';
import {
  TaqlBatchLoader,
  TaqlRequest,
  batchByKey,
  restoreOrder,
} from './utils';

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

/**
 * Extract deadlines from each request in a batch and ensure that no request
 * added to a batch has a deadline substantially different from that of the
 * first request in the batch, ensuring requests with impossibly short
 * deadlines won't get batched together with and kill (by forcing failures)
 * requests with more reasonable deadlines.
 */
const makeDeadlineClustering = (config: BatchingConfig) => {
  // TODO remove ! when stitch is updated to export the resolved configs so this function can accept a resolved batching config
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const waitMillis = config.wait!.millis!;
  return {
    comparator: (lhs: TaqlRequest, rhs: TaqlRequest) =>
      //order from soonest to latest deadline
      (lhs.context?.state?.taql?.deadline ?? 0) -
      (rhs.context?.state?.taql?.deadline ?? 0),
    clusterable: (base: TaqlRequest, update: TaqlRequest) =>
      // ensure the next deadline isn't substantially later than the current
      // deadline, using the wait millis as our cutoff. After all, the
      // configured wait millis is explicitly the amount of time upstreams are
      // willing to lose from their requests, so they can lose it from the last request
      // in a batch as surely as the first
      (update.context?.state?.taql?.deadline ?? NaN) -
        (base.context?.state?.taql?.deadline ?? NaN) <
      waitMillis,
  };
};

const byRequestStrategy: Strategy = (executor, config) => async (requests) => {
  const clustering = makeDeadlineClustering(config);
  const batches = batchByKey(requests, {
    subBatchIdFn: (req) =>
      // Fall back to a symbol (which will never match another value)
      (req.context?.state?.taql != undefined &&
        loadState(req.context.state.taql).requestUnique) ||
      Symbol(),
    seriesIdFn,
    clustering,
    maxSize: config.maxSize,
  });
  const resultBatches = await Promise.all(
    batches.map((subBatch) =>
      executor({
        request: subBatch.map((sub) => sub.val),
        forwardHeaders: subBatch[0]?.val?.context?.state?.taql?.forwardHeaders,
        clientName: subBatch[0]?.val?.context?.state?.taql?.client,
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
    const clustering = makeDeadlineClustering(config);
    const batches = batchByKey(requests, {
      subBatchIdFn: (req) =>
        // Fall back to a symbol (which will never match another value)
        (req.context?.state?.taql &&
          loadState(req.context.state.taql).batchByHeadersHash) ||
        Symbol(),
      subBatchEqFn: (lhs, rhs) =>
        lhs === rhs ||
        headersEqual(
          lhs.context?.state?.taql &&
            loadState(lhs.context.state.taql).batchByHeaders,
          rhs.context?.state?.taql &&
            loadState(rhs.context.state.taql).batchByHeaders
        ),
      seriesIdFn,
      clustering,
      maxSize: config.maxSize,
    });

    const resultBatches = await Promise.all(
      batches.map((subBatch) =>
        executor({
          request: subBatch.map((sub) => sub.val),
          forwardHeaders:
            subBatch[0]?.val?.context?.state?.taql?.forwardHeaders,
          clientName: subBatch[0]?.val?.context?.state?.taql?.client,
        })
      )
    );
    return restoreOrder(batches, resultBatches);
  };

// Don't haphazardly forward headers when batching indiscriminately. If the headers
// matter, the requests shouldn't be batched together.
// Exceptions are the ones we'd use for debugging, etc:
const insecureAllowedHeaders: Set<ForwardHeaderName> = new Set([
  'x-guid',
  'x-request-id',
  'x-unique-id',
  'x-ta-unique-dec',
  // service overrides get to go because all requests to this resolver will
  // have the same service overrides no matter how we batch; requests with
  // different overrides will be handled by entirely different schemas and go
  // to different resolvers.
  'x-service-overrides',

  // tracing headers
  //'x-b3-traceid',
  //'x-b3-spanid',
  //'x-b3-parentspanid',
  //'x-b3-flags',
  //'x-b3-sampled',
  //'b3',
]);

const mergeInsecureHeaders = (requests: TaqlRequest[]) => {
  const collectedHeaders = requests
    .map((req) => req.context?.state?.taql?.forwardHeaders)
    .map((headers) => Object.entries(headers ?? <ForwardableHeaders>{}))
    .flat()
    .filter(([key]) => insecureAllowedHeaders.has(<ForwardHeaderName>key))
    .reduce((acc: { [key: string]: Set<string> }, next: [string, string[]]) => {
      const set = (acc[next[0]] = acc[next[0]] ?? new Set());
      next[1].forEach((val) => set.add(val));
      return acc;
    }, {});

  return <ForwardableHeaders>(
    Object.fromEntries(
      Object.entries(collectedHeaders).map(([header, vals]) => [
        header,
        [...vals],
      ])
    )
  );
};

const insecureStrategy: Strategy = (executor, config) => async (requests) => {
  const clustering = makeDeadlineClustering(config);
  const batches = batchByKey(requests, {
    subBatchIdFn: () => 0,
    clustering,
    maxSize: config.maxSize,
  });
  const resultBatches = await Promise.all(
    batches.map((subBatch) => {
      const request = subBatch.map((sub) => sub.val);
      const clientNames = [
        ...new Set(
          request.map((r) => r.context?.state?.taql?.client).filter(Boolean)
        ),
      ];
      return executor({
        request,
        forwardHeaders: mergeInsecureHeaders(request),
        clientName: clientNames.length === 1 ? clientNames[0] : undefined,
      });
    })
  );
  return restoreOrder(batches, resultBatches);
};

export const STRATEGIES: Record<BatchingStrategy, Strategy> = {
  Request: byRequestStrategy,
  Headers: byHeadersStrategy,
  Insecure: insecureStrategy,
};
