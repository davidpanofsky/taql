import { ExecutionRequest, ExecutionResult } from '@graphql-tools/utils';
import fetch, { Headers } from 'node-fetch';
import { httpAgent, httpsAgent } from '@taql/httpAgent';
import type { Agent } from 'http';
import { ForwardableHeaders } from '@taql/context';
import type { TaqlState } from '@taql/context';
import { logger } from '@taql/config';
import { print } from 'graphql';

export type TaqlRequest = ExecutionRequest<Record<string, unknown>, TaqlState>;

export const formatRequest = (request: TaqlRequest) => {
  const { document, variables } = request;
  const query = print(document);
  return { query, variables } as const;
};

type ConstantLoadParams = {
  url: string;
  agent: Agent;
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

const load = async <T, R>({
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

  headers.set('content-type', 'application/json');
  logger.debug('Fetching from remote: ', url);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    agent,
    body: JSON.stringify(request),
  });
  return <R>response.json();
};

export const bindLoad = <T_1, R_1, T_2 = unknown, R_2 = unknown>(
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
      forwardHeaders: request.context?.state.taql.forwardHeaders,
      request,
    });
};
