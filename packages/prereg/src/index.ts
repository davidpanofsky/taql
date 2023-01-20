import LRUCache = require('lru-cache');
import { PREREGISTERED_QUERY_PARAMS } from '@taql/config';
import { Plugin } from '@envelop/core';

// pg-native doesn't have typescript type definitions, so `const ... = require(...)` is the way to import it
const Client = require('pg-native'); // eslint-disable-line @typescript-eslint/no-var-requires

// One single pool at the top level; it seems overly complicated to try to keep this inside the plugin object,
// especially considering there's no lifecycle method for plugin destruction, meaning we arent' really going to
// do anything smart with destroying the pool when the plugin goes away.
//
// Another approach would be to change the exported plugin to be a () => Plugin and initialize
// the pool during the call.  That would be sweet if we were passed some params at that time.
// TODO(smitchell): Climb to the top of the stack and see where this is initialized and if we have access to make
// configuration passable

let DB: typeof Client | undefined;
try {
  DB = new Client();
  // envelop plugins' onParse method is synchronous and setting the document to a promise of the parsed query
  // breaks things. Instead we just bite the bullet and do synchronous IO.
  DB.connectSync(PREREGISTERED_QUERY_PARAMS.database_uri);
} catch (e) {
  console.error(
    `Failed to connect to ${PREREGISTERED_QUERY_PARAMS.database_uri}: ${e}`
  );
}

const CACHE = new LRUCache<string, string>({
  max: PREREGISTERED_QUERY_PARAMS.max_cache_size,
});

const KNOWN_QUERIES: Set<string> = new Set<string>();

function populateKnownQueries(known: Set<string>, db: typeof Client): number {
  const initialCount = known.size;
  db.querySync('SELECT id FROM t_graphql_operations').forEach(
    (
      o: any // eslint-disable-line @typescript-eslint/no-explicit-any
    ) => known.add(o.id)
  );
  return known.size - initialCount;
}

function lookupQuery(
  queryId: string,
  db: typeof Client,
  cache: LRUCache<string, string>
): string | undefined {
  if (cache.has(queryId)) {
    return cache.get(queryId);
  } else {
    let queryText: string | undefined = undefined;
    try {
      const res = db.querySync(
        'SELECT code FROM t_graphql_operations WHERE id = $1',
        [queryId]
      );
      queryText = res.length > 0 ? res[0].code : undefined;
    } catch (e) {
      console.error(`Unexpected database error: ${e}`);
    }
    if (queryText) {
      cache.set(queryId, queryText);
    }
    return queryText;
  }
}

function preloadCache(
  cache: LRUCache<string, string>,
  db: typeof Client,
  limit: number
): number {
  try {
    const rows = db.querySync(
      'WITH most_recent AS (SELECT max(updated) AS updated FROM t_graphql_operations) ' +
        'SELECT id, code FROM t_graphql_operations WHERE updated = (select updated from most_recent) LIMIT $1',
      [limit]
    );
    rows.forEach((o: any) => cache.set(o.id, o.code)); // eslint-disable-line @typescript-eslint/no-explicit-any
    return rows.length;
  } catch (e) {
    console.error(`Failed to preload preregisted query cache: ${e}`);
    return 0;
  }
}

const preregisteredQueryResolver: Plugin = {
  onPluginInit(_) {
    const loaded = preloadCache(
      CACHE,
      DB,
      PREREGISTERED_QUERY_PARAMS.max_cache_size
    );
    console.log(`Preloaded ${loaded} preregistered queries`);
    const known = populateKnownQueries(KNOWN_QUERIES, DB);
    setInterval(populateKnownQueries, 10000, KNOWN_QUERIES, DB);
    console.log(`Populated ${known} 'known' preregistered IDs`);
  },
  // Check extensions for a potential preregistered query id, and resolve it to the query text, parsed
  onParse(params) {
    const context = params['context'];
    const extensions = context['params' as keyof typeof context]['extensions'];

    const maybePreregisteredId: string | null =
      extensions && extensions['preRegisteredQueryId'];
    if (maybePreregisteredId && KNOWN_QUERIES.has(maybePreregisteredId)) {
      console.log(`Got preregistered query id: ${maybePreregisteredId}`);
      const preregisteredQuery: string | undefined = lookupQuery(
        maybePreregisteredId,
        DB,
        CACHE
      );
      if (preregisteredQuery) {
        params.setParsedDocument(params.parseFn(preregisteredQuery));
      }
    }
  },
};

export const plugins: (Plugin | (() => Plugin))[] = [
  preregisteredQueryResolver,
];
