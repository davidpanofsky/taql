import {
  EXECUTION_TIMEOUT_PARAMS,
  PRINT_DOCUMENT_PARAMS,
  UPSTREAM_TIMEOUT_PARAMS,
  logger,
} from '@taql/config';
import { ExecutionRequest, ExecutionResult } from '@graphql-tools/utils';
import fetch, { Headers } from 'node-fetch';
import { caching, multiCaching } from 'cache-manager';
import { httpAgent, httpsAgent } from '@taql/httpAgent';
import { wrappedLRUStore, InstrumentedCache } from '@taql/metrics';
import type { Agent } from 'http';
import { ForwardableHeaders } from '@taql/context';
import type { TaqlState } from '@taql/context';
import { getDeadline } from '@taql/deadlines';
import { ioRedisStore } from '@tirke/node-cache-manager-ioredis';
import { print } from 'graphql';

export type TaqlRequest = ExecutionRequest<Record<string, unknown>, TaqlState>;

/**
 *  Set up redis cache for printed documents, if so configured.
 */
const printCacheRedisParams = PRINT_DOCUMENT_PARAMS.redisInstance
  ? {
    ttl: PRINT_DOCUMENT_PARAMS.redisTTL,
    host: PRINT_DOCUMENT_PARAMS.redisInstance,
    port: 6379,
  }
  : PRINT_DOCUMENT_PARAMS.redisCluster
  ? {
    ttl: PRINT_DOCUMENT_PARAMS.redisTTL,
    clusterConfig: {
      nodes: [
        {
          host: PRINT_DOCUMENT_PARAMS.redisCluster,
          port: 6379,
        },
      ],
    },
  }
  : undefined;

const printCacheWrappedRedis = printCacheRedisParams && ioRedisStore(printCacheRedisParams);

/**
 * Converting from DocumentNode to string can take more than 20ms for some of our lagger queries.
 * We'll cache the most common ones to avoid unnecessary work.
 * Currently only works for preregistered/persisted queries, as that's the only thing we could use as a cache key.
 */
const printCache = new InstrumentedCache<string, string>('printed_documents', {
  max: PRINT_DOCUMENT_PARAMS.maxCacheSize,
});



export const formatRequest = (request: TaqlRequest) => {
  const { document, variables, context, info } = request;
  let query: string | undefined;

  const queryId =
    context?.params?.extensions?.preRegisteredQueryId ||
    context?.params?.extensions?.persistedQuery?.sha256Hash;
  const fieldName = info?.path.key; // the aliased field name

  const cacheKey = queryId && fieldName && `${queryId}_${fieldName}`;

  if (cacheKey) {
    query = printCache.get(cacheKey);
  }

  if (!query) {
    query = print(document);
    if (cacheKey) {
      printCache.set(cacheKey, query);
    }
  }

  return { query, variables } as const;
};

type ConstantLoadParams = {
  url: string;
  agent: Agent;
  timeout: number;
};

type LoadParams<T> = {
  forwardHeaders?: ForwardableHeaders;
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
  url,
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
    throw new Error(`Skipping upstream request to ${url}. No time remaining.`);
  }

  // pad timeout to give the upstream time for network overhead.
  const paddedTimeout = Math.max(
    UPSTREAM_TIMEOUT_PARAMS.upstreamTimeoutPaddingThreshold,
    timeout - UPSTREAM_TIMEOUT_PARAMS.upstreamTimeoutPaddingMillis
  );

  headers.set('x-timeout', `${paddedTimeout}`);
  headers.set('content-type', 'application/json');
  logger.debug('Fetching from remote: ', url);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    agent,
    timeout,
    body: JSON.stringify(request),
  });
  return <R>response.json();
};

export const bindLoad = <T_1, R_1, T_2 = unknown, R_2 = unknown>(
  url: string,
  getDeadline: (req: T_1) => number | undefined,
  requestedMaxTimeout: number | undefined,
  transform?: Transform<T_1, R_1, T_2, R_2>
): Load<T_1, R_1> => {
  const agent = url.startsWith('https://') ? httpsAgent : httpAgent;
  if (agent == undefined) {
    throw new Error(
      `Cannot create agent for requests to ${url}. (This probably happened because you are trying to use https, but don't have ssl configured. See @taql/config or the project README for more information)`
    );
  }

  const maxTimeout = Math.min(
    UPSTREAM_TIMEOUT_PARAMS.hardMaxUpstreamTimeoutMillis,
    requestedMaxTimeout ?? UPSTREAM_TIMEOUT_PARAMS.softMaxUpstreamTimeoutMillis
  );

  const requestTimeout = (req: T_1) =>
    computeTimeout(maxTimeout, getDeadline(req));

  if (transform == undefined) {
    return (args: LoadParams<T_1>) =>
      load({ url, timeout: requestTimeout(args.request), agent, ...args });
  } else if (!('response' in transform)) {
    // this is a request transformation without a response transformation:
    return (args: LoadParams<T_1>) =>
      load({
        url,
        agent,
        ...args,
        timeout: requestTimeout(args.request),
        request: transform.request(args.request),
      });
  } else if (!('request' in transform)) {
    // the response is transformed but the request is not
    return (args: LoadParams<T_1>) =>
      load({ url, agent, timeout: requestTimeout(args.request), ...args }).then(
        (response) => transform.response(<R_2>response)
      );
  } else {
    //both request and response are transformed.
    return (args: LoadParams<T_1>) =>
      load({
        url,
        agent,
        timeout: requestTimeout(args.request),
        ...args,
        request: transform.request(args.request),
      }).then((response) => transform.response(<R_2>response));
  }
};

export const makeRemoteExecutor = (
  url: string,
  requestedMaxTimeout: number | undefined
): ((req: ExecutionRequest) => Promise<ExecutionResult>) => {
  const load = bindLoad<TaqlRequest, ExecutionResult>(
    url,
    getDeadline,
    requestedMaxTimeout,
    {
      request: formatRequest,
    }
  );
  return async (request: TaqlRequest): Promise<ExecutionResult> =>
    load({
      forwardHeaders: request.context?.state.taql.forwardHeaders,
      request,
    });
};
