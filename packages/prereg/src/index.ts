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

// epoch
let MOST_RECENT_KNOWN = 0;

function populateKnownQueries(
  known: Set<string>,
  db: typeof Client
): Promise<number> {
  return new Promise((resolve, reject) => {
    db.query(
      'SELECT id FROM t_graphql_operations WHERE extract(epoch from updated) > $1',
      [MOST_RECENT_KNOWN],
      function (err: Error, rows: unknown[]) {
        if (err) {
          reject(err);
          return;
        }
        const previousKnown = known.size;
        rows.forEach(
          (
            o: any // eslint-disable-line @typescript-eslint/no-explicit-any
          ) => known.add(o.id)
        );
        // Small fudge factor to avoid any concern about updated times falling between query execution
        // and updating the most recently known.  A bit of overlap is fine.
        MOST_RECENT_KNOWN = Date.now() - 5000;
        resolve(known.size - previousKnown);
      }
    );
  });
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
): void {
  db.query(
    'WITH most_recent AS (SELECT max(updated) AS updated FROM t_graphql_operations) ' +
      'SELECT id, code FROM t_graphql_operations WHERE updated = (select updated from most_recent) LIMIT $1',
    [limit],
    function (err: Error, rows: unknown[]) {
      if (err) {
        console.error(`Failed to preload preregistered query cache: ${err}`);
        return;
      }
      rows.forEach((o: any) => cache.set(o.id, o.code)); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
  );
}

const preregisteredQueryResolver: Plugin = {
  async onPluginInit(_) {
    try {
      const known = await populateKnownQueries(KNOWN_QUERIES, DB);
      console.log(`Loaded ${known} known preregistered query ids`);
    } catch (e) {
      console.error(`Failed to load known preregistered queries: ${e}`);
      throw e; // Let's shut down; we could choose not to and hope that the next try works, but why be optimistic
    }
    preloadCache(CACHE, DB, PREREGISTERED_QUERY_PARAMS.max_cache_size);
    setInterval(
      () =>
        populateKnownQueries(KNOWN_QUERIES, DB).catch((e) =>
          console.error(`Failed to update known query ids: ${e}`)
        ),
      10000
    );
  },
  // Check extensions for a potential preregistered query id, and resolve it to the query text, parsed
  onParse(params) {
    const context = params['context'];
    const extensions = context['params' as keyof typeof context]['extensions'];

    const maybePreregisteredId: string | null =
      extensions && extensions['preRegisteredQueryId'];
    if (
      maybePreregisteredId &&
      (KNOWN_QUERIES.has(maybePreregisteredId) || KNOWN_QUERIES.size == 0)
    ) {
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
