import fetchMock from 'fetch-mock-jest';
import * as graphql from 'graphql';
import {
  createTaqlServer,
  makeGraphqlRequest,
  testSubgraph,
} from './test-utils';

jest.mock('graphql', () => ({
  __esModule: true,
  ...jest.requireActual('graphql'),
}));

describe('document memoization/caching', () => {
  const query =
    'query GetProductDetails($id: Int!) { product(id: $id) { id name url @obfuscate } }';

  let validateSpy: jest.SpyInstance;
  let parseSpy: jest.SpyInstance;
  let printSpy: jest.SpyInstance;
  let server: Awaited<ReturnType<typeof createTaqlServer>>;
  let firstDocument: graphql.ASTNode | undefined;

  beforeAll(async () => {
    server = await createTaqlServer();

    validateSpy = jest.spyOn(graphql, 'validate');
    parseSpy = jest.spyOn(graphql, 'parse');
    printSpy = jest.spyOn(graphql, 'print');

    fetchMock.post(testSubgraph.executorConfig.url.toString(), {
      body: JSON.stringify({
        results: [{ result: { data: { product: { id: 1, name: 'test' } } } }],
      }),
    });
  });

  it('should parse/validate document on first request', async () => {
    await makeGraphqlRequest(server, { query, variables: { id: 1 } });
    firstDocument = printSpy.mock.lastCall?.[0];

    expect(parseSpy).toBeCalledTimes(1);
    expect(validateSpy).toBeCalledTimes(1);
    expect(fetchMock).toBeCalledTimes(1);
  });

  it('should use document cache on subsequent requests', async () => {
    await makeGraphqlRequest(server, { query, variables: { id: 1 } });

    expect(parseSpy).toBeCalledTimes(1);
    expect(validateSpy).toBeCalledTimes(1);
    expect(fetchMock).toBeCalledTimes(2);

    // ensure subsequent calls aren't doing unnecessary document transformations
    // by checking whether the document that's being printed is the same as in first request (we got it from cache)
    expect(firstDocument === printSpy.mock.lastCall?.[0]).toBe(true);
  });

  it('should still use document cache if variables have changed', async () => {
    await makeGraphqlRequest(server, { query, variables: { id: 2 } });

    expect(parseSpy).toBeCalledTimes(1);
    expect(validateSpy).toBeCalledTimes(1);
    expect(fetchMock).toBeCalledTimes(3);

    // ensure document memoization doesn't depend on variables
    expect(firstDocument === printSpy.mock.lastCall?.[0]).toBe(true);
  });

  // TODO: cache printed documents based of document reference and test that too
});
