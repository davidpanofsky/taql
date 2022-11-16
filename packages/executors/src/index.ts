import {
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from '@graphql-tools/utils';

import { TaqlContext, copyHeaders } from '@taql/context';
import { createBatchingExecutor, subBatch } from './batching';
import fetch, { Headers } from 'node-fetch';
import { httpAgent, httpsAgent } from '@taql/httpAgent';
import { Agent } from 'http';
import DataLoader from 'dataloader';
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

type ConstantLoadParams = {
  url: string;
  agent: Agent;
};

type LoadParams<T> = {
  forwardHeaders: Headers | undefined;
  request: T;
};

type RequestTransform<T_1, T_2> = {
  request: (req: T_1) => T_2;
};

type ResponseTransform<R_1, R_2> = {
  response: (res: R_2) => R_1;
};
type Transform<T_1, R_1, T_2 = T_1, R_2 = R_1> =
  | RequestTransform<T_1, T_2>
  | ResponseTransform<R_1, R_2>
  | (RequestTransform<T_1, T_2> & ResponseTransform<R_1, R_2>);

type Load<T, R> = (args: LoadParams<T>) => Promise<R>;

const load = async <T, R>({
  url,
  agent,
  forwardHeaders,
  request,
}: ConstantLoadParams & LoadParams<T>): Promise<R> => {
  const headers = copyHeaders(forwardHeaders);
  headers.set('content-type', 'application/json');
  const response = await fetch(url, {
    method: 'POST',
    headers,
    agent,
    body: JSON.stringify(request),
  });
  return <R>response.json();
};

const bindLoad = <T_1, R_1, T_2 = unknown, R_2 = unknown>(
  url: string,
  transform?: Transform<T_1, R_1, T_2, R_2>
): Load<T_1, R_1> => {
  const agent = url.startsWith('https://') ? httpsAgent : httpAgent;
  if (agent == undefined) {
    throw new Error(
      `Cannot create agent for requests to ${url}. (This probably happened because you are trying to use https, but don't have ssl configured. See @taql/config or the project README for more information)`
    );
  }
  if (transform == undefined) {
    return (args: LoadParams<T_1>) => load({ url, agent, ...args });
  } else if (!('response' in transform)) {
    // this is a request transformation without a response transformation:
    return (args: LoadParams<T_1>) =>
      load({ url, agent, ...args, request: transform.request(args.request) });
  } else if (!('request' in transform)) {
    // the response is transformed but the request is not
    return (args: LoadParams<T_1>) =>
      load({ url, agent, ...args }).then((response) =>
        transform.response(<R_2>response)
      );
  } else {
    //both request and response are transformed.
    return (args: LoadParams<T_1>) =>
      load({
        url,
        agent,
        ...args,
        request: transform.request(args.request),
      }).then((response) => transform.response(<R_2>response));
  }
};

export const makeRemoteExecutor = (url: string) => {
  const load = bindLoad<TaqlRequest, ExecutionResult>(url, {
    request: formatRequest,
  });
  return async (request: TaqlRequest): Promise<ExecutionResult> =>
    load({
      forwardHeaders: request.context?.forwardHeaders,
      request,
    });
};

export function createArrayBatchingExecutor<T extends string | number = never>(
  url: string,
  dataLoaderOptions?: DataLoader.Options<TaqlRequest, ExecutionResult>,
  subBatchIdFn?: (req: TaqlRequest) => T
): Executor<TaqlContext> {
  const arrayLoader = bindLoad(url, {
    request: (requests: ReadonlyArray<TaqlRequest>) =>
      requests.map(formatRequest),
  });

  return createBatchingExecutor(
    subBatch(
      (requests) => <Promise<ExecutionResult[]>>arrayLoader({
          request: requests,
          // thankfully we know all these requests have the same context, so
          // these headers are correct for all the requests in the batch, not
          // just the first.
          // TODO this is tremendously bad code smell, though.
          // The headers must be passed in.
          forwardHeaders: requests[0].context?.forwardHeaders,
        }),
      subBatchIdFn
    ),
    makeRemoteExecutor(url),
    dataLoaderOptions
  );
}

export function makeLegacyGqlExecutor<T extends string | number = never>(
  url: string,
  executor: Executor<TaqlContext>,
  dataLoaderOptions?: DataLoader.Options<TaqlRequest, ExecutionResult>,
  subBatchIdFn?: (req: TaqlRequest) => T
): Executor {
  type LegacyResponse = { results: { result: ExecutionResult }[] };

  const load = bindLoad<
    ReadonlyArray<TaqlRequest>,
    ExecutionResult[],
    unknown,
    LegacyResponse
  >(url, {
    // legacy graphql's batched endpoint accepts `{ requests: request[] }`, not request[]
    request: (requests) => ({
      requests: requests.map(formatRequest),
    }),
    //legacy graphql's batched endpoint returns `{ results: {result}[] }`,
    //not `result[]`
    response: (response) =>
      response.results.map((result) => <ExecutionResult>result.result),
  });

  return createBatchingExecutor(
    subBatch(
      (requests) =>
        load({
          request: requests,
          // thankfully we know all these requests have the same context, so
          // these headers are correct for all the requests in the batch, not
          // just the first.
          // TODO this is tremendously bad code smell, though.
          // The headers must be passed in.
          forwardHeaders: requests[0].context?.forwardHeaders,
        }),
      subBatchIdFn
    ),
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
