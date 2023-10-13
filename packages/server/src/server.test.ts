import fetchMock from 'fetch-mock-jest';
import {
  createTaqlServer,
  makeGraphqlRequest,
  testSubgraph,
} from './test-utils';

describe('server', () => {
  let server: Awaited<ReturnType<typeof createTaqlServer>>;

  beforeAll(async () => {
    fetchMock.post(testSubgraph.executorConfig.url.toString(), {
      body: JSON.stringify({
        results: [{ result: { data: { allProducts: [] } } }],
      }),
    });
    server = await createTaqlServer();
  });

  it('should handle requests', async () => {
    const result = await makeGraphqlRequest(server, {
      query: 'query prewarm { __typename }',
    });
    expect(result).toMatchObject({
      data: { __typename: 'Query' },
    });
  });

  it('should delegate requests to subgraph', async () => {
    const result = await makeGraphqlRequest(server, {
      query: 'query GetProducts { allProducts { name } }',
    });
    expect(fetchMock).toBeCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(testSubgraph.executorConfig.url.toString()),
      expect.anything()
    );
    expect(result).toMatchObject({
      data: { allProducts: [] },
    });
  });

  it('should handle anonymous operation', async () => {
    const result = await makeGraphqlRequest(server, {
      query: 'query { allProducts { name } }',
    });
    expect(result).toMatchObject({
      data: { allProducts: [] },
    });
  });
});
