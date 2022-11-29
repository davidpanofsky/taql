import { BatchingStrategy, STRATEGIES } from './strategies';
import {
  ExecutionResult,
  Executor,
  getOperationASTFromRequest,
} from '@graphql-tools/utils';
import { bindLoad, formatRequest, makeRemoteExecutor } from '@taql/executors';
import DataLoader from 'dataloader';
import type { PrivateContext } from './context';
import type { TaqlRequest } from './utils';
import { createLoadFn } from '@graphql-tools/batch-execute';

/**
 * Enumerate the styles of batched requests we support
 */
export type BatchStyle =
  /**
   * Just for legacy graphql and other things shaped like it. Queries in a
   * batch will be added to an array, and that array will be set as a
   * 'requests' field on the request object. The responses will be in the
   * 'result' field on objects listed in a 'results' array on the top level
   * object.
   *
   * @deprecated This exists only to support legacy graphql. There's no reason
   * to go out of your way to shape an API like that today and require further
   * use of this style, so don't.
   */
  | 'Legacy'
  /**
   * Queries in a batch will be combined into fewer, larger queries (usually
   * exactly one query) before being sent upstream. Each of these queries will
   * be given the context (ergo headers) from the first request in the batch.
   * The response(s) will be parsed to reverse the process
   */
  | 'Single'
  /**
   * Queries in a batch will be added to an array and that array will be sent
   * as the request object. The response will be an array at the top level.
   */
  | 'Array';

/**
 * Configure how batched queries are to be executed for any given subgraph
 */
export type BatchingConfig = {
  /** The strategy specifies how to decide which queries can be batched
   * together
   */
  strategy: BatchingStrategy;
  /** The style specifies how batches of queries are sent upstream */
  style: BatchStyle;
  /**
   * These options configure which requests we _attempt_ to batch together in
   * the first place, for example by setting how long we should wait for
   * additional queries to add to the batch, or how many queries are allowed in
   * a batch
   */
  dataLoaderOptions?: DataLoader.Options<TaqlRequest, ExecutionResult>;
};

export const createBatchingExecutor = (
  /** The load function that we expect to do execution for batches */
  loadFn: DataLoader.BatchLoadFn<TaqlRequest, ExecutionResult>,
  /** A fallback executor for single requests, to be used when batching
   * cannot safely be used (e.g., for subscriptions)
   */
  executor: Executor<PrivateContext>,
  /**
   * Data loader configuration
   */
  dataLoaderOptions?: DataLoader.Options<TaqlRequest, ExecutionResult>
): Executor<PrivateContext> => {
  const loader = new DataLoader(loadFn, { cache: false, ...dataLoaderOptions });
  return (request: TaqlRequest) => {
    const operationAst = getOperationASTFromRequest(request);
    operationAst.operation;
    return operationAst.operation !== 'subscription'
      ? loader.load(request)
      : executor(request);
  };
};

function makeSingleQueryBatchingExecutor(
  url: string,
  config: BatchingConfig
): Executor<PrivateContext> {
  const executor = makeRemoteExecutor(url);
  // Use a loader graphql-tools helpfully defines, which goes through the
  // effort of merging queries for us.
  const loadFn = createLoadFn(<Executor>executor);
  return createBatchingExecutor(
    STRATEGIES[config.strategy](({ request }) => loadFn(request)),
    executor,
    config.dataLoaderOptions
  );
}

function makeArrayBatchingExecutor(
  url: string,
  config: BatchingConfig
): Executor<PrivateContext> {
  const arrayLoader = bindLoad<ReadonlyArray<TaqlRequest>, ExecutionResult[]>(
    url,
    {
      request: (requests) => requests.map(formatRequest),
    }
  );

  return createBatchingExecutor(
    STRATEGIES[config.strategy](arrayLoader),
    makeRemoteExecutor(url),
    config.dataLoaderOptions
  );
}
function makeLegacyGqlExecutor(url: string, config: BatchingConfig): Executor {
  const load = bindLoad<
    ReadonlyArray<TaqlRequest>,
    ExecutionResult[],
    unknown,
    { results: { result: ExecutionResult }[] }
  >(url, {
    // legacy graphql's batched endpoint accepts `{ requests: request[] }`, not request[]
    request: (requests) => ({
      requests: requests.map(formatRequest),
    }),
    // legacy graphql's batched endpoint returns `{ results: {result}[] }`,
    // not `result[]`
    response: (response) =>
      response.results.map((result) => <ExecutionResult>result.result),
  });

  return createBatchingExecutor(
    STRATEGIES[config.strategy](load),
    // Legacy-style endpoints must shape single requests like singleton batches; they don't
    // speak the typical graphql API.
    (req: TaqlRequest) =>
      load({
        forwardHeaders: req.context?.state.forwardHeaders,
        request: [req],
      }).then((results) => results[0]),
    config.dataLoaderOptions
  );
}

/**
 * Create an executor that will call the given url according to the provided configuration
 */
export const createExecutor = (url: string, config: BatchingConfig) => {
  switch (config.style) {
    case 'Single':
      return makeSingleQueryBatchingExecutor(url, config);
    case 'Array':
      return makeArrayBatchingExecutor(url, config);
    case 'Legacy':
      return makeLegacyGqlExecutor(url, config);
  }
};
