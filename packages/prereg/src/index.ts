import {
  DocumentNode,
  Kind,
  OperationDefinitionNode,
  OperationTypeNode,
  parse,
} from 'graphql';
import { Plugin, handleStreamOrSingleExecutionResult } from '@envelop/core';
import { Plugin as YogaPlugin, createGraphQLError } from 'graphql-yoga';
import { LRUCache } from 'lru-cache';
import { Pool } from 'pg';
import { logger } from '@taql/config';
import promClient from 'prom-client';

interface Cache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
}

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
): Promise<{ count: number; asOf?: number }> {
  logger.debug('Populating preregistered queries');
  try {
    const known_queries_res = await db.query(
      'SELECT id FROM t_graphql_operations WHERE extract(epoch from updated) > $1',
      [MOST_RECENT_KNOWN]
    );
    const previousKnown = known.size;
    known_queries_res.rows.forEach((o: { id: string }) => known.add(o.id));
    // Small fudge factor to avoid any concern about updated times falling between query execution
    // and updating the most recently known.  A bit of overlap is fine.
    const now = Date.now();
    MOST_RECENT_KNOWN = now - 5000;
    return {
      count: known.size - previousKnown,
      asOf: now,
    };
  } catch (e) {
    logger.error(`Unexpected database error: ${e}`);
    return { count: 0 };
  }
}

async function lookupQuery(
  queryId: string,
  db: Pool
): Promise<string | undefined> {
  let queryText: string | undefined = undefined;
  logger.debug(`Looking up query ${queryId}`);
  try {
    const res = await db.query(
      'SELECT code FROM t_graphql_operations WHERE id = $1',
      [queryId]
    );
    queryText = res.rows.length > 0 ? res.rows[0].code : undefined;
  } catch (e) {
    logger.error(`Unexpected database error: ${e}`);
  }
  return queryText;
}

async function preloadCache(
  cache: Cache<string, string>,
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
      res.rows.forEach((o: { id: string; code: string }) =>
        cache.set(o.id, o.code)
      );
      return res.rows.length;
    });
}

/**
 * Prewarm a given cache with known preregistered queries.
 * Allows for a function to be applied to the raw query text, but as it stands the full document is used as the
 * cache key.
 * See:
 * https://github.com/dotansimha/graphql-yoga/blob/main/packages/graphql-yoga/src/plugins/use-parser-and-validation-cache.ts#L50
 */
async function prewarmDocumentCache(
  cache: Cache<string, DocumentNode>,
  db: Pool,
  keyFn: (query: string) => string = (query) => query
): Promise<number> {
  return db
    .query(
      // Here we make an assumption that 'cache' might be LRU, so sort with ascending 'updated'-ness such that
      // the most recently updated queries hit the cache last.
      'SELECT code, updated FROM t_graphql_operations ORDER BY updated ASC'
    )
    .then((res) => {
      res.rows.forEach((o: { code: string }) =>
        cache.set(keyFn(o.code), parse(o.code))
      );
      return res.rows.length;
    });
}

export function usePreregisteredQueries(options: {
  maxCacheSize: number;
  postgresConnectionString?: string;
  maxPoolSize?: number;
  poolConnectionTimeoutMillis?: number;
  ssl?: {
    ca: string;
    cert: string;
    key: string;
    rejectUnauthorized: boolean;
  };
  documentCacheForWarming?: Cache<string, DocumentNode>;
}): YogaPlugin {
  const {
    maxCacheSize,
    postgresConnectionString = 'postgres://graphql_operations_ros@localhost',
    maxPoolSize = 10,
    poolConnectionTimeoutMillis = 0,
    ssl,
    documentCacheForWarming,
  } = options;

  logger.info(
    `Initializing preregistered queries plugin using ${postgresConnectionString}, max cache size = ${maxCacheSize}`
  );

  const knownQueries = new Set<string>();

  const cache = new LRUCache<string, string>({
    max: maxCacheSize,
  });

  const pool = new Pool({
    connectionString: postgresConnectionString,
    max: maxPoolSize,
    connectionTimeoutMillis: poolConnectionTimeoutMillis,
    ssl,
  });

  return {
    async onPluginInit(_) {
      try {
        const { count, asOf } = await populateKnownQueries(knownQueries, pool);
        logger.info(`Loaded ${count} known preregistered query ids`);
        if (asOf) {
          PREREG_UPDATED_AT.set(asOf);
        }
      } catch (e) {
        logger.error(`Failed to load known preregistered queries: ${e}`);
        throw e; // Let's shut down; we could choose not to and hope that the next try works, but why be optimistic
      }
      await preloadCache(cache, pool, maxCacheSize).catch((err) =>
        logger.error(`Failed to preload preregisterd queries cache: ${err}`)
      );
      setInterval(
        () =>
          populateKnownQueries(knownQueries, pool)
            .then(({ count, asOf }) => {
              if (count > 0 && asOf) {
                PREREG_UPDATED_AT.set(asOf);
              }
            })
            .catch((e) =>
              logger.error(`Failed to update known query ids: ${e}`)
            ),
        10000
      );

      if (documentCacheForWarming) {
        logger.info("Starting to prewarm the document cache...");
        await prewarmDocumentCache(documentCacheForWarming, pool)
          .then((count) =>
            logger.info(
              `Prewarmed document cache with ${count} preregistered queries`
            )
          )
          .catch((e) => logger.error(`Failed prewarming document cache: ${e}`));
      }
    },

    // Check extensions for a potential preregistered query id, and resolve it to the query text, parsed
    async onParams({ params, setParams }) {
      const extensions = params.extensions;
      const maybePreregisteredId: string | null =
        extensions && extensions['preRegisteredQueryId'];
      if (
        maybePreregisteredId &&
        (knownQueries.has(maybePreregisteredId) || knownQueries.size == 0)
      ) {
        let preregisteredQuery: string | undefined;
        if (cache.has(maybePreregisteredId)) {
          logger.debug('preregistered query cache hit: ', maybePreregisteredId);
          preregisteredQuery = cache.get(maybePreregisteredId);
          PREREG_HIT.inc();
        } else if (
          (preregisteredQuery = await lookupQuery(maybePreregisteredId, pool))
        ) {
          logger.debug(
            'preregistered query cache miss: ',
            maybePreregisteredId
          );
          PREREG_MISS.inc();
          cache.set(maybePreregisteredId, preregisteredQuery);
        }

        if (preregisteredQuery) {
          setParams({
            ...params,
            query: preregisteredQuery,
          });
        } else {
          logger.warn(
            'preregistered query unresolved warning: ',
            maybePreregisteredId
          );
          PREREG_UNK.inc();
          throw createGraphQLError('PreregisteredQueryNotResolved', {
            extensions: {
              http: {
                status: 503,
              },
            },
          });
        }
      } else if (maybePreregisteredId) {
        logger.debug('preregistered query unresolved: ', maybePreregisteredId);
        PREREG_UNK.inc();
        throw createGraphQLError('PreregisteredQueryNotFound', {
          extensions: {
            http: {
              status: 404,
            },
          },
        });
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
