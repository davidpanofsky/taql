import {
  EXECUTION_TIMEOUT_PARAMS,
  UPSTREAM_TIMEOUT_PARAMS,
  logger,
} from '@taql/config';
import { ExecutionRequest, ExecutionResult } from '@graphql-tools/utils';
import fetch, { Headers } from 'node-fetch';
import { httpAgent, httpsAgent } from '@taql/httpAgent';
import type { Agent } from 'http';
import { Cache } from 'cache-manager';
import { ForwardableHeaders } from '@taql/context';
import type { TaqlState } from '@taql/context';
import { getDeadline } from '@taql/deadlines';
import { print } from 'graphql';
import promClient from 'prom-client';

export type TaqlRequest = ExecutionRequest<Record<string, unknown>, TaqlState>;

export type PrintedDocumentCacheConfig = {
  cache?: Omit<Cache, 'store'>;
  keyFn?: (queryId: string, fieldName: string | number) => string;
};

export const requestFormatter =
  (config: PrintedDocumentCacheConfig) => async (request: TaqlRequest) => {
    const { document, variables, context, info } = request;
    const { cache, keyFn } = config;

    const queryId =
      context?.params?.extensions?.preRegisteredQueryId ||
      context?.params?.extensions?.persistedQuery?.sha256Hash;
    const fieldName = info?.path.key; // the aliased field name

    const cacheKey = keyFn && queryId && fieldName && keyFn(queryId, fieldName);

    // It's important that we call cache.wrap here, as for multicaches this ensures that if the value is in a "deeper" cache
    // that the value is propagated into the "shallower" caches that we would prefer to resolve it from in the future.
    const query: string =
      cache && cacheKey
        ? await cache.wrap(cacheKey, async () => print(document))
        : print(document);

    return { query, variables } as const;
  };

const BODY_BYTES_SENT = new promClient.Counter({
  name: 'taql_executor_body_bytes_sent',
  help: 'byte length of request bodies sent by taql executors',
  labelNames: ['subgraph'],
});

const BODY_BYTES_RECEIVED = new promClient.Counter({
  name: 'taql_executor_body_bytes_received',
  help: 'byte length of response bodies receieved by this executor',
  labelNames: ['subgraph'],
});

type SubgraphConfig = {
  url: string;
  name: string;
  requestedMaxTimeout?: number;
};

type ConstantLoadParams = {
  subgraph: SubgraphConfig;
  agent: Agent;
  timeout: number;
};

type LoadParams<T> = {
  forwardHeaders?: ForwardableHeaders;
  request: Promise<T> | T;
};

type RequestTransform<T_1, T_2> = {
  request: (req: T_1) => Promise<T_2> | T_2;
};

type ResponseTransform<R_1, R_2> = {
  response: (res: R_2) => R_1;
};

type Transform<T_1, R_1, T_2 = T_1, R_2 = R_1> =
  | RequestTransform<T_1, T_2>
  | ResponseTransform<R_1, R_2>
  | (RequestTransform<T_1, T_2> & ResponseTransform<R_1, R_2>);

type Load<T, R> = (args: LoadParams<T>) => Promise<R>;

const computeTimeout = (maxTimeout: number, deadline?: number): number => {
  if (deadline == undefined) {
    return maxTimeout;
  } else {
    // Pad so we have time to work with the results.
    return Math.min(
      maxTimeout,
      deadline - Date.now() - EXECUTION_TIMEOUT_PARAMS.executionPaddingMillis
    );
  }
};

const load = async <T, R>({
  timeout,
  subgraph,
  agent,
  forwardHeaders,
  request,
}: ConstantLoadParams & LoadParams<T>): Promise<R> => {
  const headers = new Headers();
  if (forwardHeaders) {
    Object.entries(forwardHeaders).forEach((entry) =>
      entry[1].forEach((val) => headers.append(entry[0], val))
    );
  }

  if (timeout < 0) {
    throw new Error(
      `Skipping upstream request to ${subgraph.url}. No time remaining.`
    );
  }

  // pad timeout to give the upstream time for network overhead.
  const paddedTimeout = Math.max(
    UPSTREAM_TIMEOUT_PARAMS.upstreamTimeoutPaddingThreshold,
    timeout - UPSTREAM_TIMEOUT_PARAMS.upstreamTimeoutPaddingMillis
  );

  headers.set('x-timeout', `${paddedTimeout}`);
  headers.set('content-type', 'application/json');
  logger.debug(`Fetching from remote: ${subgraph.url}`);
  const body = Buffer.from(JSON.stringify(await request));
  BODY_BYTES_SENT.labels({ subgraph: subgraph.name }).inc(body.byteLength);
  const response = await fetch(subgraph.url, {
    method: 'POST',
    headers,
    agent,
    timeout,
    body,
  });
  const responseBody = await response.buffer();
  BODY_BYTES_RECEIVED.labels({ subgraph: subgraph.name }).inc(
    responseBody.byteLength
  );
  return <R>JSON.parse(responseBody.toString());
};

export const bindLoad = <T_1, R_1, T_2 = unknown, R_2 = unknown>(
  subgraph: SubgraphConfig,
  getDeadline: (req: T_1) => number | undefined,
  transform?: Transform<T_1, R_1, T_2, R_2>
): Load<T_1, R_1> => {
  const agent = subgraph.url.startsWith('https://') ? httpsAgent : httpAgent;
  if (agent == undefined) {
    throw new Error(
      `Cannot create agent for requests to ${subgraph.url}. (This probably happened because you are trying to use https, but don't have ssl configured. See @taql/config or the project README for more information)`
    );
  }

  const maxTimeout = Math.min(
    UPSTREAM_TIMEOUT_PARAMS.hardMaxUpstreamTimeoutMillis,
    subgraph.requestedMaxTimeout ??
      UPSTREAM_TIMEOUT_PARAMS.softMaxUpstreamTimeoutMillis
  );

  const requestTimeout = (req: T_1) =>
    computeTimeout(maxTimeout, getDeadline(req));

  if (transform == undefined) {
    return async (args: LoadParams<T_1>) =>
      load({
        subgraph,
        timeout: requestTimeout(await args.request),
        agent,
        ...args,
      });
  } else if (!('response' in transform)) {
    // this is a request transformation without a response transformation:
    return async (args: LoadParams<T_1>) =>
      load({
        subgraph,
        agent,
        ...args,
        timeout: requestTimeout(await args.request),
        request: transform.request(await args.request),
      });
  } else if (!('request' in transform)) {
    // the response is transformed but the request is not
    return async (args: LoadParams<T_1>) =>
      load({
        subgraph,
        agent,
        timeout: requestTimeout(await args.request),
        ...args,
      }).then((response) => transform.response(<R_2>response));
  } else {
    //both request and response are transformed.
    return async (args: LoadParams<T_1>) =>
      load({
        subgraph,
        agent,
        timeout: requestTimeout(await args.request),
        ...args,
        request: transform.request(await args.request),
      }).then((response) => transform.response(<R_2>response));
  }
};

export const makeRemoteExecutor = (
  subgraph: SubgraphConfig,
  printedDocumentCacheConfig: PrintedDocumentCacheConfig = {}
): ((req: ExecutionRequest) => Promise<ExecutionResult>) => {
  const load = bindLoad<TaqlRequest, ExecutionResult>(subgraph, getDeadline, {
    request: requestFormatter(printedDocumentCacheConfig),
  });
  return async (request: TaqlRequest): Promise<ExecutionResult> =>
    load({
      forwardHeaders: request.context?.state.taql.forwardHeaders,
      request,
    });
};
