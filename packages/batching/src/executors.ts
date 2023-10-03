import { BatchStyle, SubgraphExecutorConfig } from '@ta-graphql-utils/stitch';
import {
  ExecutionResult,
  ExecutionRequest,
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
import { SubgraphConfig } from '@taql/executors';
import type { TaqlState } from '@taql/context';
import { createLoadFn } from '@graphql-tools/batch-execute';
import promClient from 'prom-client';

const BATCH_SIZE_HISTOGRAM = new promClient.Histogram({
  name: 'taql_executor_batch_size',
  help: 'number of requests in the batch',
  buckets: [1, 5, 20, 50, 100, 160, 240],
  labelNames: ['subgraph', 'batchStyle'],
});

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
  return (request: ExecutionRequest) => {
    const operationAst = getOperationASTFromRequest(request);
    return operationAst.operation !== 'subscription'
      ? loader.load(request)
      : executor(request);
  };
};

type BatchingExecutorConfig<T extends BatchStyle = BatchStyle> = Readonly<
  SubgraphExecutorConfig &
    SubgraphConfig &
    Required<Pick<SubgraphExecutorConfig, 'batching'>> & {
      batching: { style: T };
    }
>;

function makeSingleQueryBatchingExecutor(
  config: BatchingExecutorConfig<'Single'>
): Executor<TaqlRequest> {
  const executor = makeRemoteExecutor(config);
  // Use a loader graphql-tools helpfully defines, which goes through the
  // effort of merging queries for us.
  const loadFn = createLoadFn(
    <Executor>executor,
    wrapReducerWithDeadlineHandling()
  );

  return createBatchingExecutor(
    STRATEGIES[config.batching.strategy](
      ({ request }) => loadFn(request),
      config.batching
    ),
    executor,
    translateConfigToLoaderOptions(config)
  );
}

function makeArrayBatchingExecutor(
  config: BatchingExecutorConfig<'Array'>,
  requestFormatter: (req: TaqlRequest) => unknown | Promise<unknown>
): Executor<TaqlRequest> {
  const arrayLoader = bindLoad<ReadonlyArray<TaqlRequest>, ExecutionResult[]>(
    config,
    pickDeadline,
    {
      async request(requests) {
        BATCH_SIZE_HISTOGRAM.observe(
          {
            subgraph: config.name,
            batchStyle: config.batching.style,
          },
          requests.length
        );
        return await Promise.all(requests.map(requestFormatter));
      },
    }
  );

  return createBatchingExecutor(
    STRATEGIES[config.batching.strategy](arrayLoader, config.batching),
    makeRemoteExecutor(config),
    translateConfigToLoaderOptions(config)
  );
}

// TODO this papers over a problem in the publication cronjob, namely that it passes on the
// url it uses to procure the legacy schema (the graphqlUnwrapped endpoint on legacy). Big
// changes are coming to that cronjob later; for now this will do
const rewriteLegacyConfig = (
  config: BatchingExecutorConfig<'Legacy'>
): BatchingExecutorConfig<'Legacy'> => ({
  ...config,
  url: new URL(
    config.url.toString().replace('graphqlUnwrapped', 'graphqlBatched')
  ),
});

function makeLegacyGqlExecutor(
  rawConfig: BatchingExecutorConfig<'Legacy'>,
  requestFormatter: (req: TaqlRequest) => unknown | Promise<unknown>
): Executor {
  const config = rewriteLegacyConfig(rawConfig);
  const load = bindLoad<
    ReadonlyArray<TaqlRequest>,
    ExecutionResult[],
    unknown,
    { results: { result: ExecutionResult }[] }
  >(config, pickDeadline, {
    // legacy graphql's batched endpoint accepts `{ requests: request[] }`, not request[]
    async request(requests) {
      // Since we generate the legacy RequestContext from headers we assume that if those headers are considered batch-compatible,
      // we can just select any request in the batch from which to use the derived context.
      const legacyContext = requests?.find((i) => i)?.context?.state.taql
        .legacyContext;

      BATCH_SIZE_HISTOGRAM.observe(
        {
          subgraph: config.name,
          batchStyle: config.batching.style,
        },
        requests.length
      );

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
    STRATEGIES[config.batching.strategy](load, config.batching),
    // Legacy-style endpoints must shape single requests like singleton batches; they don't
    // speak the typical graphql API.
    (req: ExecutionRequest) =>
      load({
        forwardHeaders: req.context?.state.taql.forwardHeaders,
        request: [req],
      }).then((results) => results[0]),
    translateConfigToLoaderOptions(config)
  );
}

/**
 * Create an executor that will call the given url according to the provided configuration
 */
export const createExecutor = (
  config: BatchingExecutorConfig,
  requestFormatter: (req: TaqlRequest) => unknown | Promise<unknown>
): Executor => {
  switch (config.batching.style) {
    case 'Single':
      return makeSingleQueryBatchingExecutor(
        <BatchingExecutorConfig<'Single'>>config
      );
    case 'Array':
      return makeArrayBatchingExecutor(
        <BatchingExecutorConfig<'Array'>>config,
        requestFormatter
      );
    case 'Legacy':
      return makeLegacyGqlExecutor(
        <BatchingExecutorConfig<'Legacy'>>config,
        requestFormatter
      );
  }
};
