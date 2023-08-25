import { type ASTNode, GraphQLError, print } from 'graphql';
import {
  AUTH_MANAGER_CONFIG,
  EXECUTION_TIMEOUT_PARAMS,
  UPSTREAM_TIMEOUT_PARAMS,
  logger,
  WORKER as worker,
} from '@taql/config';
import {
  AuthManager,
  AuthProvider,
  getManager,
} from '@ta-graphql-utils/auth-manager';
import { ExecutionRequest, ExecutionResult } from '@graphql-tools/utils';
import { ForwardableHeaders, type TaqlState } from '@taql/context';
import fetch, { Headers } from 'node-fetch';
import { httpAgent, httpsAgent } from '@taql/httpAgent';
import type { Agent } from 'http';
import { Cache } from 'cache-manager';
import { SubgraphExecutorConfig } from '@ta-graphql-utils/stitch';
import { getDeadline } from '@taql/deadlines';
import path from 'node:path';
import promClient from 'prom-client';

export type TaqlRequest = ExecutionRequest<Record<string, unknown>, TaqlState>;

export type PrintedDocumentCacheConfig = {
  cache?: Omit<Cache, 'store'>;
  keyFn?: (queryId: string, fieldName: string | number) => string;
};

const labelNames = ['worker'];
const buckets = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5];

const EXECUTOR_PRINT_DURATION_HISTOGRAM = new promClient.Histogram({
  name: 'taql_executor_print_duration',
  help: 'Time spent printing the graphql document or accessing the printed ones from the cache',
  labelNames,
  buckets,
});

const EXECUTOR_UNCACHED_PRINT_DURATION_HISTOGRAM = new promClient.Histogram({
  name: 'taql_executor_uncached_print_duration',
  help: 'Time spent printing the graphql document',
  labelNames,
  buckets,
});

function instrumentedPrint(ast: ASTNode): string {
  const stopTimer = EXECUTOR_UNCACHED_PRINT_DURATION_HISTOGRAM.startTimer({
    worker,
  });
  const result = print(ast);
  stopTimer();
  return result;
}

export const requestFormatter =
  (config: PrintedDocumentCacheConfig) => async (request: TaqlRequest) => {
    const { document, variables, context, info } = request;
    const { cache, keyFn } = config;

    const queryId =
      context?.params?.extensions?.preRegisteredQueryId ||
      context?.params?.extensions?.persistedQuery?.sha256Hash;
    const fieldName = info?.path.key; // the aliased field name

    const cacheKey = keyFn && queryId && fieldName && keyFn(queryId, fieldName);

    const stopTimer = EXECUTOR_PRINT_DURATION_HISTOGRAM.startTimer({ worker });

    // It's important that we call cache.wrap here, as for multicaches this ensures that if the value is in a "deeper" cache
    // that the value is propagated into the "shallower" caches that we would prefer to resolve it from in the future.
    const query: string =
      cache && cacheKey
        ? await cache.wrap(cacheKey, async () => instrumentedPrint(document))
        : instrumentedPrint(document);

    stopTimer();

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

export type SubgraphConfig = SubgraphExecutorConfig & {
  authProvider?: AuthProvider;
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

export const authManager = (
  oidcLiteAuthorizationDomain: string
): AuthManager => {
  if (AUTH_MANAGER_CONFIG.authKind == undefined) {
    throw new Error('working authManager is required');
  } else {
    if (AUTH_MANAGER_CONFIG.authKind == 'aws') {
      return getManager({ kind: 'iam' });
    } else {
      const tokenPath = path.join(
        AUTH_MANAGER_CONFIG.oidcTokenPath,
        oidcLiteAuthorizationDomain
      );
      return getManager({ tokenPath });
    }
  }
};

export const subgraphAuthProvider = (
  url: URL,
  oidcLiteAuthorizationDomain?: string
): AuthProvider | undefined => {
  if (oidcLiteAuthorizationDomain == undefined) {
    return undefined;
  }

  const audience = url.origin;
  const scopeBase = url.href.replace(/\/$/, '');
  const scopes = new Set([`${scopeBase}::write`, `${scopeBase}::read`]);
  logger.debug('@taql/executors subgraphAuthProvider: ', {
    oidcLiteAuthorizationDomain,
    audience,
    scopes: [...scopes],
  });
  const providerConfig = {
    issuerConfig: { domain: oidcLiteAuthorizationDomain },
    audience,
    scopes,
  };
  return oidcLiteAuthorizationDomain
    ? AUTH_MANAGER_CONFIG.eagerProvider
      ? authManager(oidcLiteAuthorizationDomain).getEagerProvider(
          providerConfig
        )
      : authManager(oidcLiteAuthorizationDomain).getLazyProvider(providerConfig)
    : undefined;
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

  const token = (await subgraph.authProvider?.getAuth())?.accessToken;
  token != undefined && headers.set('x-oidc-authorization', `Bearer ${token}`);
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
  if (!response.ok) {
    throw new GraphQLError(
      `Got ${response.status} error from remote: ${subgraph.url}`
    );
  } else {
    const responseBody = await response.json();
    BODY_BYTES_RECEIVED.labels({ subgraph: subgraph.name }).inc(
      responseBody.length
    );
    return responseBody;
  }
};

export const bindLoad = <T_1, R_1, T_2 = unknown, R_2 = unknown>(
  subgraph: SubgraphConfig,
  getDeadline: (req: T_1) => number | undefined,
  transform?: Transform<T_1, R_1, T_2, R_2>
): Load<T_1, R_1> => {
  subgraph.authProvider = subgraphAuthProvider(
    subgraph.url,
    subgraph.oidcLiteAuthorizationDomain
  );
  if (subgraph.url.protocol == 'http:' && subgraph.authProvider != undefined) {
    throw new Error(
      `Subgraph misconfiguration for: ${subgraph.url}. Refusing to send authentication headers over cleartext http.`
    );
  }
  const agent = subgraph.url.protocol == 'https:' ? httpsAgent : httpAgent;

  const maxTimeout = Math.min(
    UPSTREAM_TIMEOUT_PARAMS.hardMaxUpstreamTimeoutMillis,
    subgraph.sla.maxTimeoutMillis ??
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
