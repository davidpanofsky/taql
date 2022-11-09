import {
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from '@graphql-tools/utils';

import { UrlLoader } from '@graphql-tools/url-loader';
import { agent } from '@taql/ssl';
import fetch from 'node-fetch';
import { loadSchema } from '@graphql-tools/load';
import { print } from 'graphql';
import { wrapSchema } from '@graphql-tools/wrap';

export type LegacyConfig = {
  host: string;
  httpPort: string;
  httpsPort: string;
};

export function makeLegacyExecutor(url: string): Executor {
  const executor: Executor = async (
    request: ExecutionRequest
  ): Promise<ExecutionResult> => {
    const { document, variables } = request;
    const query = print(document);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      agent,
    });
    return <ExecutionResult>response.json();
  };
  return executor;
}

export async function makeLegacySchema(config: LegacyConfig) {
  const url = `http://${config.host}:${config.httpPort}/v1/graphqlUnwrapped`;
  const executor = makeLegacyExecutor(url);
  const schema = await loadSchema(url, {
    loaders: [new UrlLoader()],
  });
  return wrapSchema({ schema, executor });
}
