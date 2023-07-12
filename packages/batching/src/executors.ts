import {
  BatchStyle,
  BatchingConfig,
  BatchingStrategy,
  ExecutorConfig,
} from '@ta-graphql-utils/stitch';
import {
  ExecutionResult,
  Executor,
  getOperationASTFromRequest,
} from '@graphql-tools/utils';
import { TaqlRequest, translateConfigToLoaderOptions } from './utils';
import { bindLoad, makeRemoteExecutor } from '@taql/executors';
import {
  pickDeadline,
  wrapReducer as wrapReducerWithDeadlineHandling,
} from '@taql/deadlines';
import DataLoader from 'dataloader';
import { STRATEGIES } from './strategies';
import type { TaqlState } from '@taql/context';
import { createLoadFn } from '@graphql-tools/batch-execute';

export const createBatchingExecutor = (
  /** The load function that we expect to do execution for batches */
  loadFn: DataLoader.BatchLoadFn<TaqlRequest, ExecutionResult>,
  /** A fallback executor for single requests, to be used when batching
   * cannot safely be used (e.g., for subscriptions)
   */
  executor: Executor<TaqlState>,
  /**
   * Data loader configuration
   */
  dataLoaderOptions?: DataLoader.Options<TaqlRequest, ExecutionResult>
): Executor<TaqlState> => {
  const loader = new DataLoader(loadFn, { cache: false, ...dataLoaderOptions });
  return (request: TaqlRequest) => {
    const operationAst = getOperationASTFromRequest(request);
    return operationAst.operation !== 'subscription'
      ? loader.load(request)
      : executor(request);
  };
};

function makeSingleQueryBatchingExecutor(
  url: string,
  requestedMaxTimeout: number | undefined,
  config: BatchingConfig
): Executor<TaqlRequest> {
  const executor = makeRemoteExecutor(url, requestedMaxTimeout);
  // Use a loader graphql-tools helpfully defines, which goes through the
  // effort of merging queries for us.
  const loadFn = createLoadFn(
    <Executor>executor,
    wrapReducerWithDeadlineHandling()
  );

  return createBatchingExecutor(
    STRATEGIES[config.strategy](({ request }) => loadFn(request), config),
    executor,
    translateConfigToLoaderOptions(config)
  );
}

function makeArrayBatchingExecutor(
  url: string,
  requestedMaxTimeout: number | undefined,
  config: BatchingConfig,
  requestFormatter: (req: TaqlRequest) => unknown | Promise<unknown>
): Executor<TaqlRequest> {
  const arrayLoader = bindLoad<ReadonlyArray<TaqlRequest>, ExecutionResult[]>(
    url,
    pickDeadline,
    requestedMaxTimeout,
    {
      async request(requests) {
        return await Promise.all(requests.map(requestFormatter));
      },
    }
  );

  return createBatchingExecutor(
    STRATEGIES[config.strategy](arrayLoader, config),
    makeRemoteExecutor(url, requestedMaxTimeout),
    translateConfigToLoaderOptions(config)
  );
}

function makeLegacyGqlExecutor(
  url: string,
  requestedMaxTimeout: number | undefined,
  config: BatchingConfig,
  requestFormatter: (req: TaqlRequest) => unknown | Promise<unknown>
): Executor {
  const load = bindLoad<
    ReadonlyArray<TaqlRequest>,
    ExecutionResult[],
    unknown,
    { results: { result: ExecutionResult }[] }
  >(url, pickDeadline, requestedMaxTimeout, {
    // legacy graphql's batched endpoint accepts `{ requests: request[] }`, not request[]
    async request(requests) {
      // Since we generate the legacy RequestContext from headers we assume that if those headers are considered batch-compatible,
      // we can just select any request in the batch from which to use the derived context.
      const legacyContext = requests?.find((i) => i)?.context?.state.taql
        .legacyContext;
      const formatted: {
        requests: unknown[];
        requestContext?: unknown | undefined;
      } = {
        requests: await Promise.all(requests.map(requestFormatter)),
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
        forwardHeaders: req.context?.state.taql.forwardHeaders,
        request: [req],
      }).then((results) => results[0]),
    translateConfigToLoaderOptions(config)
  );
}

const defaultBatchingConfig: BatchingConfig = {
  style: BatchStyle.Single,
  strategy: BatchingStrategy.BatchByInboundRequest,
};

/**
 * Create an executor that will call the given url according to the provided configuration
 */
export const createExecutor = (
  requestedMaxTimeout: number | undefined,
  { url, batching: config = defaultBatchingConfig }: ExecutorConfig,
  requestFormatter: (req: TaqlRequest) => unknown | Promise<unknown>
): Executor => {
  switch (config.style) {
    case BatchStyle.Single:
      return makeSingleQueryBatchingExecutor(url, requestedMaxTimeout, config);
    case BatchStyle.Array:
      return makeArrayBatchingExecutor(
        url,
        requestedMaxTimeout,
        config,
        requestFormatter
      );
    case BatchStyle.Legacy:
      return makeLegacyGqlExecutor(
        url,
        requestedMaxTimeout,
        config,
        requestFormatter
      );
  }
};
