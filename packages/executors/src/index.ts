import {
  AUTH_MANAGER_CONFIG,
  ENABLE_FEATURES,
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
import {
  type DocumentNode,
  GraphQLError,
  getOperationAST,
  print,
} from 'graphql';
import {
  ExecutionRequest,
  ExecutionResult,
  memoize1,
} from '@graphql-tools/utils';
import { ForwardableHeaders, type TaqlState } from '@taql/context';
import fetch, { Headers } from 'node-fetch';
import { httpAgent, httpsAgent, legacyHttpsAgent } from '@taql/httpAgent';
import type { Agent } from 'http';
import { SpanKind } from '@opentelemetry/api';
import { SubgraphExecutorConfig } from '@ta-graphql-utils/stitch';
import { getDeadline } from '@taql/deadlines';
import path from 'node:path';
import { performance } from 'perf_hooks';
import promClient from 'prom-client';
import { tracerProvider } from '@taql/observability';

export type TaqlRequest = ExecutionRequest<Record<string, unknown>, TaqlState>;

const tracer = tracerProvider.getTracer('taql');
const PRINT_OPERATION_NAME = 'graphql.print.operationName';

const labelNames = ['worker'];
const buckets = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5];

const memoizedPrint = memoize1(print);

const EXECUTOR_PRINT_DURATION_HISTOGRAM = new promClient.Histogram({
  name: 'taql_executor_print_duration',
  help: 'Time spent printing the graphql document or accessing the printed ones from the cache',
  labelNames,
  buckets,
});

function instrumentedPrint(ast: DocumentNode): string {
  const operationAST = getOperationAST(ast);
  const operationName = operationAST?.name?.value;
  const printSpan = ENABLE_FEATURES.printSpans
    ? tracer.startSpan(`print - ${operationName || 'Anonymous Operation'}`, {
        kind: SpanKind.SERVER,
        attributes: {
          [PRINT_OPERATION_NAME]: operationName,
        },
      })
    : undefined;
  const stopTimer = EXECUTOR_PRINT_DURATION_HISTOGRAM.startTimer({
    worker,
  });
  const result = memoizedPrint(ast);
  stopTimer();
  printSpan?.end();
  return result;
}

export class DummyRequestTerminated extends Error {}

export const requestFormatter = () => async (request: TaqlRequest) => {
  const { document, variables, context } = request;

  if (context?.isDummyRequest) {
    memoizedPrint(document);
    throw new DummyRequestTerminated();
  }

  const query = instrumentedPrint(document);

  // Pass on as much information as we can to upstreams by extensions
  // preregisteredQueryId gives a hint of how to trace back to a client component/use case and
  // operation id gives even more to sniff out.
  // Note: this function is not currently called for single batching executors, so they
  // won't get the same information.  This might be ok, as it will be less meaningful there, but it's still
  // worth noting
  const extensions = {
    servicing: {
      preregisteredQueryId: context?.params?.extensions?.preregisteredQueryId ?? 'N/A',
      operationName: context?.params?.operationName ?? 'unknown',
    }
  };

  return { query, variables, extensions } as const;
};

const durationBucketsMs = [
  10, 25, 50, 75, 100, 150, 200, 300, 500, 700, 1000, 2000,
];
const EXECUTOR_REQUEST_DURATION_HISTOGRAM = new promClient.Histogram({
  name: 'taql_executor_request_duration_ms',
  help: 'executor time (ms) spent on HTTP connection',
  labelNames: ['subgraph', 'client'],
  buckets: durationBucketsMs,
});

const EXECUTOR_ERROR_COUNT = new promClient.Counter({
  name: 'taql_executor_error_count',
  help: 'number of executor failures',
  labelNames: ['subgraph'],
});

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
  clientName?: string;
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
  clientName,
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

  //copy authorization header to x-trip-iat if not already set
  if (!headers.has('x-trip-iat')) {
    const authorization = headers.get('authorization');
    authorization != undefined && headers.set('x-trip-iat', authorization);
  }

  headers.set('x-timeout', `${paddedTimeout}`);
  headers.set('content-type', 'application/json');
  logger.debug(`Fetching from remote: ${subgraph.url}`);
  const body = Buffer.from(JSON.stringify(await request));
  BODY_BYTES_SENT.labels({ subgraph: subgraph.name }).inc(body.byteLength);
  const start = performance.now();
  const response = await fetch(subgraph.url, {
    method: 'POST',
    redirect: 'error',
    headers,
    agent,
    timeout,
    body,
  });
  const duration = performance.now() - start;
  EXECUTOR_REQUEST_DURATION_HISTOGRAM.observe(
    { subgraph: subgraph.name, client: clientName || 'unknown' },
    duration
  );
  if (!response.ok) {
    EXECUTOR_ERROR_COUNT.labels(subgraph.name).inc();
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
  const agent =
    subgraph.url.protocol == 'http:'
      ? httpAgent
      : subgraph.authProvider == undefined
        ? legacyHttpsAgent
        : httpsAgent;

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
  subgraph: SubgraphConfig
): ((req: ExecutionRequest) => Promise<ExecutionResult>) => {
  const load = bindLoad<TaqlRequest, ExecutionResult>(subgraph, getDeadline, {
    request: requestFormatter(),
  });
  return async (request: TaqlRequest): Promise<ExecutionResult> =>
    load({
      forwardHeaders: request.context?.state.taql.forwardHeaders,
      request,
      clientName: request.context?.state.taql.client,
    });
};
