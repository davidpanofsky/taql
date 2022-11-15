import {
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from '@graphql-tools/utils';

import { TaqlContext, copyHeaders } from '@taql/context';
import { createBatchingExecutor, subBatch } from './batching';
import { fetchWithAgent, sslConfig } from '@taql/ssl';
import DataLoader from 'dataloader';
import { Headers } from 'node-fetch';
import { createLoadFn } from '@graphql-tools/batch-execute';
import { print } from 'graphql';

export type TaqlRequest = ExecutionRequest<
  Record<string, unknown>,
  TaqlContext
>;

const formatRequest = (request: TaqlRequest) => {
  const { document, variables } = request;
  const query = print(document);
  return { query, variables } as const;
};

const load = async <T_1, R_1, T_2 = T_1, R_2 = R_1>({
  url,
  forwardHeaders,
  request,
  transform,
}: {
  url: string;
  forwardHeaders: Headers | undefined;
  request: T_1;
  transform?: Readonly<{
    request?: (req: T_1) => T_2;
    response?: (res: R_2) => R_1;
  }>;
}): Promise<R_1> => {
  const headers = copyHeaders(forwardHeaders);
  headers.set('content-type', 'application/json');
  const response = await fetchWithAgent(url, {
    method: 'POST',
    ...sslConfig,
    headers,
    body: JSON.stringify(
      transform?.request != undefined ? transform?.request(request) : request
    ),
  });
  return transform?.response != undefined
    ? transform.response(<R_2>await response.json())
    : <R_1>response.json();
};

export const makeRemoteExecutor =
  (url: string) =>
  async (request: TaqlRequest): Promise<ExecutionResult> =>
    load({
      url,
      forwardHeaders: request.context?.forwardHeaders,
      request,
      transform: { request: () => formatRequest },
    });

const arrayLoader = async (
  url: string,
  requests: ReadonlyArray<TaqlRequest>
): Promise<ExecutionResult[]> =>
  load({
    url,
    // thankfully we know all these requests have the same context, so
    // these headers are correct for all the requests in the batch, not
    // just the first.
    // TODO this is tremendously bad code smell, though. The headers must be passed in.
    forwardHeaders: requests[0].context?.forwardHeaders,
    request: requests,
    transform: {
      request: (requests: ReadonlyArray<TaqlRequest>) =>
        requests.map(formatRequest),
    },
  });

export function createArrayBatchingExecutor<T extends string | number = never>(
  url: string,
  dataLoaderOptions?: DataLoader.Options<TaqlRequest, ExecutionResult>,
  subBatchIdFn?: (req: TaqlRequest) => T
): Executor<TaqlContext> {
  return createBatchingExecutor(
    subBatch(arrayLoader.bind(null, url), subBatchIdFn),
    makeRemoteExecutor(url),
    dataLoaderOptions
  );
}

const legacyGqlLoader = async (
  url: string,
  requests: ReadonlyArray<TaqlRequest>
): Promise<ExecutionResult[]> =>
  load({
    url,
    // thankfully we know all these requests have the same context, so
    // these headers are correct for all the requests in the batch, not
    // just the first.
    // TODO this is tremendously bad code smell, though. The headers must be passed in.
    forwardHeaders: requests[0].context?.forwardHeaders,
    request: requests,
    transform: {
      // legacy graphql's batched endpoint accepts `{ requests: request[] }`, not request[]
      request: (requests: ReadonlyArray<TaqlRequest>) => ({
        requests: requests.map(formatRequest),
      }),
      //legacy graphql's batched endpoint returns `{ results: {result}[] }`,
      //not `result[]`
      response: (response: { results: { result: ExecutionResult }[] }) =>
        response.results.map((result) => result.result),
    },
  });

export function makeLegacyGqlExecutor<T extends string | number = never>(
  url: string,
  executor: Executor<TaqlContext>,
  dataLoaderOptions?: DataLoader.Options<TaqlRequest, ExecutionResult>,
  subBatchIdFn?: (req: TaqlRequest) => T
): Executor {
  return createBatchingExecutor(
    subBatch(legacyGqlLoader.bind(null, url), subBatchIdFn),
    executor,
    dataLoaderOptions
  );
}

export function makeSingleQueryBatchingExecutor<
  T extends string | number = never
>(
  url: string,
  dataLoaderOptions?: DataLoader.Options<TaqlRequest, ExecutionResult>,
  subBatchIdFn?: (req: TaqlRequest) => T
): Executor<TaqlContext> {
  const executor = makeRemoteExecutor(url);
  return createBatchingExecutor(
    subBatch(createLoadFn(<Executor>executor), subBatchIdFn),
    executor,
    dataLoaderOptions
  );
}
