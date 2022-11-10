import {
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from '@graphql-tools/utils';

import { createBatchingExecutor, subBatch } from './batching';
import { fetchWithAgent, sslConfig } from '@taql/ssl';
import DataLoader from 'dataloader';
import { print } from 'graphql';

// extremely lazy header forwarding. all our custom
// headers start with x-, and I guess we should do cookies too.
// Cookie forwarding ought to be a subject of debate, though.
// Cut everything else for now.
// TODO develop allow-list list of headers to forward
// TODO move this to a middleware layer and attach output to the graphql
// context at that point (as a lazily evaluated getter?), so we don't have to
// continually check whether or not we've already ran the computation.
const deriveHeaders = (request: ExecutionRequest): Record<string, unknown> => {
  if (request.context?.forwardHeaders == undefined) {
    request.context.forwardHeaders = Object.fromEntries(
      Object.entries(request.context?.req?.headers || {}).filter(
        ([header]) => header.startsWith('x-') || header === 'cookie'
      )
    );
  }
  return request.context.forwardHeaders;
};

const formatRequest = (request: ExecutionRequest) => {
  const { document, variables } = request;
  const query = print(document);
  return { query, variables } as const;
};

const load = async <T_1, R_1, T_2 = T_1, R_2 = R_1>({
  url,
  headers,
  request,
  transform,
}: {
  url: string;
  headers: Record<string, unknown>;
  request: T_1;
  transform?: Readonly<{
    request?: (req: T_1) => T_2;
    response?: (res: R_2) => R_1;
  }>;
}): Promise<R_1> => {
  const response = await fetchWithAgent(url, {
    method: 'POST',
    ...sslConfig,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(
      transform?.request != undefined ? transform?.request(request) : request
    ),
  });
  return transform?.response != undefined
    ? transform.response(await response.json())
    : response.json();
};

export const makeRemoteExecutor =
  (url: string) =>
  async (request: ExecutionRequest): Promise<ExecutionResult> =>
    load({
      url,
      headers: deriveHeaders(request),
      request,
      transform: { request: formatRequest },
    });

const arrayLoader = async (
  url: string,
  requests: ReadonlyArray<ExecutionRequest>
): Promise<ExecutionResult[]> =>
  load({
    url,
    // thankfully we know all these requests have the same context, so
    // these headers are correct for all the requests in the batch, not
    // just the first.
    // TODO this is tremendously bad code smell, though. The headers must be passed in.
    headers: deriveHeaders(requests[0]),
    request: requests,
    transform: {
      request: (requests: ReadonlyArray<ExecutionRequest>) =>
        requests.map(formatRequest),
    },
  });

export function createArrayBatchingExecutor<T extends string | number = never>(
  url: string,
  dataLoaderOptions?: DataLoader.Options<ExecutionRequest, ExecutionResult>,
  subBatchIdFn?: (req: ExecutionRequest) => T
): Executor {
  return createBatchingExecutor(
    subBatch(arrayLoader.bind(null, url), subBatchIdFn),
    makeRemoteExecutor(url),
    dataLoaderOptions
  );
}

const legacyGqlLoader = async (
  url: string,
  requests: ReadonlyArray<ExecutionRequest>
): Promise<ExecutionResult[]> =>
  load({
    url,
    // thankfully we know all these requests have the same context, so
    // these headers are correct for all the requests in the batch, not
    // just the first.
    // TODO this is tremendously bad code smell, though. The headers must be passed in.
    headers: deriveHeaders(requests[0]),
    request: requests,
    transform: {
      // legacy graphql's batched endpoint accepts `{ requests: request[] }`, not request[]
      request: (requests: ReadonlyArray<ExecutionRequest>) => ({
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
  executor: Executor,
  dataLoaderOptions?: DataLoader.Options<ExecutionRequest, ExecutionResult>,
  subBatchIdFn?: (req: ExecutionRequest) => T
): Executor {
  return createBatchingExecutor(
    subBatch(legacyGqlLoader.bind(null, url), subBatchIdFn),
    executor,
    dataLoaderOptions
  );
}
