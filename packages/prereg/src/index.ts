import { Kind, OperationDefinitionNode, OperationTypeNode } from 'graphql';
import { Plugin, handleStreamOrSingleExecutionResult } from '@envelop/core';
import { LRUCache } from 'lru-cache';
import { Pool } from 'pg';
import { Plugin as YogaPlugin } from 'graphql-yoga';
import promClient from 'prom-client';

// metrics
const PREREG_UNK = new promClient.Counter({
  name: 'preregistered_query_unknown',
  help: 'Count of preregistered query IDs encountered which were unknown/unresolved',
});

const PREREG_MISS = new promClient.Counter({
  name: 'preregistered_query_cache_miss',
  help: 'Count of preregistered query IDs encountered which were resolved not from cache',
});

const PREREG_HIT = new promClient.Counter({
  name: 'pregegistered_query_cache_hit',
  help: 'Count of preregistered query IDs that were resolved from cache',
});

const PREREG_UPDATED_AT = new promClient.Gauge({
  name: 'preregistered_query_last_load',
  help: 'epoch of last load of preregistered queries',
});

// epoch
let MOST_RECENT_KNOWN = 0;

async function populateKnownQueries(
  known: Set<string>,
  db: Pool
): Promise<number> {
  try {
    const known_queries_res = await db.query(
      'SELECT id FROM t_graphql_operations WHERE extract(epoch from updated) > $1',
      [MOST_RECENT_KNOWN]
    );
    const previousKnown = known.size;
    known_queries_res.rows.forEach(
      (
        o: any // eslint-disable-line @typescript-eslint/no-explicit-any
      ) => known.add(o.id)
    );
    // Small fudge factor to avoid any concern about updated times falling between query execution
    // and updating the most recently known.  A bit of overlap is fine.
    const now = Date.now();
    MOST_RECENT_KNOWN = now - 5000;
    PREREG_UPDATED_AT.set(now);
    return known.size - previousKnown;
  } catch (e) {
    console.error(`Unexpected database error: ${e}`);
    return 0;
  }
}

async function lookupQuery(
  queryId: string,
  db: Pool,
  cache: LRUCache<string, string>
): Promise<string | undefined> {
  if (cache.has(queryId)) {
    PREREG_HIT.inc();
    return cache.get(queryId);
  } else {
    let queryText: string | undefined = undefined;
    try {
      const res = await db.query(
        'SELECT code FROM t_graphql_operations WHERE id = $1',
        [queryId]
      );
      queryText = res.rows.length > 0 ? res.rows[0].code : undefined;
    } catch (e) {
      console.error(`Unexpected database error: ${e}`);
    }
    if (queryText) {
      PREREG_MISS.inc();
      cache.set(queryId, queryText);
    } else {
      PREREG_UNK.inc();
    }
    return queryText;
  }
}

async function preloadCache(
  cache: LRUCache<string, string>,
  db: Pool,
  limit: number
): Promise<number> {
  return db
    .query(
      'WITH most_recent AS (SELECT max(updated) AS updated FROM t_graphql_operations) ' +
        'SELECT id, code FROM t_graphql_operations WHERE updated = (select updated from most_recent) LIMIT $1',
      [limit]
    )
    .then((res) => {
      res.rows.forEach((o: any) => cache.set(o.id, o.code)); // eslint-disable-line @typescript-eslint/no-explicit-any
      return res.rows.length;
    });
}

export function usePreregisteredQueries(
  options: {
    max_cache_size?: number;
    postgresConnectionString?: string;
  } = {}
): YogaPlugin {
  const {
    max_cache_size = 2000,
    postgresConnectionString = 'postgres:///graphql_operations_ros@localhost',
  } = options;

  console.log(
    `Initializing preregistered queries plugin using ${postgresConnectionString}, max cache size = ${max_cache_size}`
  );

  const known_queries = new Set<string>();

  const cache = new LRUCache<string, string>({
    max: max_cache_size,
  });

  const pool = new Pool({
    connectionString: postgresConnectionString,
  });

  return {
    async onPluginInit(_) {
      try {
        const known = await populateKnownQueries(known_queries, pool);
        console.log(`Loaded ${known} known preregistered query ids`);
      } catch (e) {
        console.error(`Failed to load known preregistered queries: ${e}`);
        throw e; // Let's shut down; we could choose not to and hope that the next try works, but why be optimistic
      }
      await preloadCache(cache, pool, max_cache_size).catch((err) =>
        console.error(`Failed to preload preregisterd queries cache: ${err}`)
      );
      setInterval(
        () =>
          populateKnownQueries(known_queries, pool).catch((e) =>
            console.error(`Failed to update known query ids: ${e}`)
          ),
        10000
      );
    },
    // Check extensions for a potential preregistered query id, and resolve it to the query text, parsed
    async onParams({ params, setParams }) {
      const extensions = params.extensions;
      const maybePreregisteredId: string | null =
        extensions && extensions['preRegisteredQueryId'];
      if (
        maybePreregisteredId &&
        (known_queries.has(maybePreregisteredId) || known_queries.size == 0)
      ) {
        const preregisteredQuery: string | undefined = await lookupQuery(
          maybePreregisteredId,
          pool,
          cache
        );
        if (preregisteredQuery) {
          setParams({
            ...params,
            query: preregisteredQuery,
          });
        }
      } else if (maybePreregisteredId) {
        PREREG_UNK.inc();
      }
    },
  };
}

/**
 * Envelop plugin which adds the 'mutatedFields' extension.
 * When using preregistered queries, the client doesn't have any view of the query text, so is unaware
 * what, if any, mutations take place.  By adding the mutatedFields extension, clients can still cache bust
 * on mutations.
 */
export const mutatedFieldsExtensionPlugin: Plugin = {
  onExecute({ args }) {
    const mutatedFields: string[] = [];
    args.document.definitions.forEach((d: OperationDefinitionNode) => {
      if (
        d.operation === OperationTypeNode.MUTATION &&
        d.selectionSet &&
        d.selectionSet.selections
      ) {
        d.selectionSet.selections.forEach((selection) => {
          if (selection.kind === Kind.FIELD) {
            mutatedFields.push(selection.name.value);
          }
        });
      }
    });

    if (mutatedFields.length === 0) {
      // No mutated fields means no need to have any hooks, so return an empty map of hooks
      return {};
    }

    return {
      onExecuteDone(payload) {
        return handleStreamOrSingleExecutionResult(
          payload,
          ({ result, setResult }) => {
            setResult({
              ...result,
              extensions: {
                ...(result.extensions || {}),
                mutatedFields,
              },
            });
          }
        );
      },
    };
  },
};
