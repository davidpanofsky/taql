const fetchMockJest = require('fetch-mock-jest');
const fetchMock = fetchMockJest.sandbox();

jest.mock('node-fetch', () => fetchMock);
jest.mock('fetch-mock-jest', () => fetchMock);

jest.mock('pg', () => {
  const { newDb } = require('pg-mem');
  const db = newDb();

  globalThis.TEST_DB = db;

  db.public.none(`
    CREATE TABLE public.t_graphql_operations (
      id text NOT NULL,
      code text NOT NULL,
      updated timestamp with time zone DEFAULT now() NOT NULL
    );
  `);

  return db.adapters.createPg();
});



