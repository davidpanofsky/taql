import fetchMock from 'fetch-mock-jest';
import * as graphql from 'graphql';

jest.mock('graphql', () => ({
  __esModule: true,
  ...jest.requireActual('graphql'),
}));

const validateSpy = jest.spyOn(graphql, 'validate');
const parseSpy = jest.spyOn(graphql, 'parse');
const printSpy = jest.spyOn(graphql, 'print');

import {
  createTaqlServer,
  makeGraphqlRequest,
  testSubgraph,
} from './test-utils';

describe('document memoization/caching', () => {
  const query =
    'query GetProductDetails($id: Int!) { product(id: $id) { id name url @obfuscate } }';

  let server: Awaited<ReturnType<typeof createTaqlServer>>;

  beforeAll(async () => {
    fetchMock.post(testSubgraph.executorConfig.url.toString(), {
      body: JSON.stringify({
        results: [{ result: { data: { product: { id: 1, name: 'test' } } } }],
      }),
    });

    server = await createTaqlServer();
  });

  beforeEach(() => {
    parseSpy.mockClear();
    validateSpy.mockClear();
    printSpy.mockClear();
    fetchMock.mockClear();
  });

  it('should parse/validate document on first request', async () => {
    await makeGraphqlRequest(server, { query, variables: { id: 1 } });

    expect(parseSpy).toBeCalledTimes(1);
    expect(validateSpy).toBeCalledTimes(1);
    expect(printSpy).toBeCalledTimes(1);
    expect(fetchMock).toBeCalledTimes(1);
  });

  it('should use document cache on subsequent requests', async () => {
    await makeGraphqlRequest(server, { query, variables: { id: 1 } });

    expect(parseSpy).toBeCalledTimes(0);
    expect(validateSpy).toBeCalledTimes(0);
    expect(printSpy).toBeCalledTimes(0);
    expect(fetchMock).toBeCalledTimes(1);
  });

  it('should still use document cache if variables have changed', async () => {
    await makeGraphqlRequest(server, { query, variables: { id: 2 } });

    expect(parseSpy).toBeCalledTimes(0);
    expect(validateSpy).toBeCalledTimes(0);
    expect(printSpy).toBeCalledTimes(0);
    expect(fetchMock).toBeCalledTimes(1);
  });
});
