import { type Supergraph, makeSchema } from '@taql/schema';
import type { Subgraph } from '@ta-graphql-utils/stitch';
import { createYoga } from 'graphql-yoga';
import { makePlugins } from './useYoga';

const baseYogaOptions = {
  graphiql: false,
  multipart: false,
  batching: { limit: 10 },
  cors: false,
  logging: false,
  maskedErrors: true,
  graphqlEndpoint: '/graphql',
  landingPage: false,
} as const;

export const testSubgraph: Subgraph = {
  name: 'test',
  namespace: 'Global',
  sdl: `
    schema {
      query: Query
    }
    directive @obfuscate on FIELD
    type Product {
      id: Int
      name: String
      url: String
    }
    type Query {
      allProducts: [Product]
      product(id: Int!): Product
    }
  `,
  executorConfig: {
    url: 'http://test.com/graphql',
    sla: { maxTimeoutMillis: 100 },
    batching: {
      style: 'Legacy',
      strategy: 'Request',
      maxSize: 10,
      wait: {
        millis: 10,
      },
    },
  },
};

export const testSupergraph: Supergraph = {
  id: 'foobar',
  manifest: [testSubgraph],
  supergraph: testSubgraph.sdl,
  legacyDigest: '123',
};

type GraphqlRequest = {
  query: string;
  variables?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};

export async function makeGraphqlRequest(
  server: ReturnType<typeof createYoga>,
  req: GraphqlRequest | GraphqlRequest[]
) {
  const res = await server.fetch(server.graphqlEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-taql-trust-client': 'true',
    },
    body: JSON.stringify(req),
  });
  return res.json();
}

export async function createTaqlServer(
  supergraph: Supergraph = testSupergraph
) {
  const stitchResult = await makeSchema(supergraph);

  if (!('success' in stitchResult)) {
    throw new Error('Could not stitch schema');
  }

  return createYoga({
    ...baseYogaOptions,
    schema: stitchResult.success.schema,
    plugins: await makePlugins(stitchResult.success.schema),
  });
}
