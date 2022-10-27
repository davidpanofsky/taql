import { ExecutionRequest, ExecutionResult } from '@graphql-tools/utils';

import { GraphQLFileLoader } from '@graphql-tools/graphql-file-loader';
import { createBatchingExecutor } from '@graphql-tools/batch-execute';
import { createServer } from 'node:http';
import { createYoga } from 'graphql-yoga';
import { fetch } from '@whatwg-node/fetch';
import { loadSchema } from '@graphql-tools/load';
import { print } from 'graphql';
import { stitchSchemas } from '@graphql-tools/stitch';
import { wrapSchema } from '@graphql-tools/wrap';

async function executor(request: ExecutionRequest): Promise<ExecutionResult> {
  const { document, variables } = request;
  const query = print(document);
  const response = await fetch(
    'http://jacobkatz.sleds.dev.tripadvisor.com:14724/v1/graphqlUnwrapped',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    }
  );
  return <ExecutionResult>response.json();
}

async function makeSchema() {
  // curl http://jacobkatz.sleds.dev.tripadvisor.com:14724/Schema > /tmp/schema
  const schema = await loadSchema('/tmp/schema.graphql', {
    loaders: [new GraphQLFileLoader()],
  });
  const batchedExecutor = createBatchingExecutor(executor);
  const subSchema = wrapSchema({ schema, executor: batchedExecutor });
  // build the combined schema
  return stitchSchemas({
    subschemas: [subSchema],
  });
}

export function main() {
  const yoga = createYoga({ schema: makeSchema() });
  const server = createServer(yoga);
  server.listen(4000, () => {
    console.info('server running');
  });
}

main();
