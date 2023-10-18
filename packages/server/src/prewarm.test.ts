declare let TEST_DB: import('pg-mem').IMemoryDb;

import fetchMock from 'fetch-mock-jest';
import * as graphql from 'graphql';
import { randomUUID } from 'crypto';

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

describe('prewarming', () => {
  const queryId = randomUUID();
  const query =
    'query GetProductDetails($id: Int!) { product(id: $id) { id name url @obfuscate } }';

  const request = { query: '', extensions: { preRegisteredQueryId: queryId } };

  let server: Awaited<ReturnType<typeof createTaqlServer>>;

  beforeAll(async () => {
    TEST_DB.getTable('t_graphql_operations').insert({
      id: queryId,
      code: query,
    });

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

  it('should not parse/validate document on first request', async () => {
    await makeGraphqlRequest(server, { ...request, variables: { id: 1 } });

    expect(parseSpy).toBeCalledTimes(0);
    expect(validateSpy).toBeCalledTimes(0);
    expect(printSpy).toBeCalledTimes(0);
    expect(fetchMock).toBeCalledTimes(1);
  });

  it('should still use document cache if variables have changed', async () => {
    await makeGraphqlRequest(server, { ...request, variables: { id: 2 } });

    expect(parseSpy).toBeCalledTimes(0);
    expect(validateSpy).toBeCalledTimes(0);
    expect(printSpy).toBeCalledTimes(0);
    expect(fetchMock).toBeCalledTimes(1);
  });
});
