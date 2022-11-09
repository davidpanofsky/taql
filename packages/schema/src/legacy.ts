import {
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from '@graphql-tools/utils';

import { fetchWithAgent, sslConfig } from '@taql/ssl';
import crypto from 'crypto';
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
    const { document, variables, context } = request;
    // extremely lazy header forwarding, all our custom
    // headers start with x-, and I guess we should do cookies too.
    // TODO develop allow-list list of headers to forward
    const headers = Object.fromEntries(
      Object.entries(context?.req?.headers || {}).filter(
        ([header]) => header.startsWith('x-') || header === 'cookie'
      )
    );

    const query = print(document);
    const response = await fetchWithAgent(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      ...sslConfig,
    });
    return <ExecutionResult>response.json();
  };
  return executor;
}

export async function makeLegacySchema(config: LegacyConfig) {
  const [protocol, port] = sslConfig
    ? ['https', config.httpsPort]
    : ['http', config.httpPort];
  try {
    const rootUrl = `${protocol}://${config.host}:${port}`;
    const url = `${rootUrl}/v1/graphqlUnwrapped`;
    const rawSchemaResponse = await fetchWithAgent(`${rootUrl}/Schema`);
    const rawSchema = await rawSchemaResponse.text();
    const schema = await loadSchema(rawSchema, { loaders: [] });
    const executor = makeLegacyExecutor(url);
    const wrappedSchema = wrapSchema({ schema, executor });
    const hash = crypto.createHash('md5').update(rawSchema).digest('hex');
    return { schema: wrappedSchema, hash };
  } catch (e) {
    console.error(`error loading legacy schema: ${e}`);
    throw e;
  }
}
