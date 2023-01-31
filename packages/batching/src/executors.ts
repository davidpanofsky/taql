import { BatchStyle, BatchingConfig } from '@taql/batching-config';
import {
  ExecutionResult,
  Executor,
  getOperationASTFromRequest,
} from '@graphql-tools/utils';
import { TaqlRequest, translateConfigToLoaderOptions } from './utils';
import { bindLoad, formatRequest, makeRemoteExecutor } from '@taql/executors';
import DataLoader from 'dataloader';
import type { PrivateContext } from './context';
import { STRATEGIES } from './strategies';
import { createLoadFn } from '@graphql-tools/batch-execute';

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
    STRATEGIES[config.strategy](({ request }) => loadFn(request), config),
    executor,
    translateConfigToLoaderOptions(config)
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
    STRATEGIES[config.strategy](arrayLoader, config),
    makeRemoteExecutor(url),
    translateConfigToLoaderOptions(config)
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
    request(requests) {
      const a_request = requests.length > 0 ? requests[0] : undefined;
      const legacyContext = a_request?.context?.state.legacyContext;
      const formatted: {
        requests: unknown[];
        requestContext?: unknown | undefined;
      } = {
        requests: requests.map(formatRequest),
      };

      if (legacyContext) {
        formatted.requestContext = legacyContext;
      }

      return formatted;
    },
    // legacy graphql's batched endpoint returns `{ results: {result}[] }`,
    // not `result[]`
    response: (response) =>
      response.results.map((result) => <ExecutionResult>result.result),
  });

  return createBatchingExecutor(
    STRATEGIES[config.strategy](load, config),
    // Legacy-style endpoints must shape single requests like singleton batches; they don't
    // speak the typical graphql API.
    (req: TaqlRequest) =>
      load({
        forwardHeaders: req.context?.state.forwardHeaders,
        request: [req],
      }).then((results) => results[0]),
    translateConfigToLoaderOptions(config)
  );
}

/**
 * Create an executor that will call the given url according to the provided configuration
 */
export const createExecutor = (url: string, config: BatchingConfig) => {
  switch (config.style) {
    case BatchStyle.Single:
      return makeSingleQueryBatchingExecutor(url, config);
    case BatchStyle.Array:
      return makeArrayBatchingExecutor(url, config);
    case BatchStyle.Legacy:
      return makeLegacyGqlExecutor(url, config);
  }
};
