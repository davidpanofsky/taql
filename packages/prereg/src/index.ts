import { Kind, OperationDefinitionNode, OperationTypeNode } from 'graphql';
import { Plugin, handleStreamOrSingleExecutionResult } from '@envelop/core';
import { Plugin as YogaPlugin, createGraphQLError } from 'graphql-yoga';
import { logger, WORKER as worker } from '@taql/config';
import { InstrumentedCache } from '@taql/metrics';
import { Pool } from 'pg';
import promClient from 'prom-client';

// metrics
const PREREG_UNK = new promClient.Counter({
  name: 'preregistered_query_unknown',
  help: 'Count of preregistered query IDs encountered which were unknown/unresolved',
  labelNames: ['worker'],
});

const PREREG_UPDATED_AT = new promClient.Gauge({
  name: 'preregistered_query_last_load',
  help: 'epoch of last load of preregistered queries',
  labelNames: ['worker'],
});

// epoch
let MOST_RECENT_KNOWN = 0;

async function populateKnownQueries(
  known: Set<string>,
  db: Pool,
  refresh = false
): Promise<{ count: number; asOf?: number }> {
  logger.debug(
    `Populating preregistered queries${refresh ? ' (full refresh)' : ''}`
  );
  try {
    const known_queries_res = await db.query(
      'SELECT id FROM t_graphql_operations WHERE extract(epoch from updated) > $1',
      [refresh ? 0 : MOST_RECENT_KNOWN]
    );
    const previousKnown = known.size;
    if (refresh) {
      known.clear();
    }
    known_queries_res.rows.forEach((o: { id: string }) => known.add(o.id));
    // Small fudge factor to avoid any concern about updated times falling between query execution
    // and updating the most recently known. A bit of overlap is fine.
    const now = Math.floor(Date.now() / 1000);
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
  cache: InstrumentedCache<string, string>,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): YogaPlugin & {
  loadCurrentQueries(): Promise<{ id: string; query: string }[]>;
} {
  const {
    maxCacheSize,
    postgresConnectionString = 'postgres://graphql_operations_ros@localhost',
    maxPoolSize = 10,
    poolConnectionTimeoutMillis = 0,
    ssl,
  } = options;

  logger.info(
    `Initializing preregistered queries plugin using ${postgresConnectionString}, max cache size = ${maxCacheSize}`
  );

  const knownQueries = new Set<string>();

  const cache = new InstrumentedCache<string, string>('preregistered_query', {
    max: maxCacheSize,
  });

  const pool = new Pool({
    connectionString: postgresConnectionString,
    max: maxPoolSize,
    connectionTimeoutMillis: poolConnectionTimeoutMillis,
    ssl,
  });

  return {
    async loadCurrentQueries(): Promise<{ id: string; query: string }[]> {
      return pool
        .query(
          'WITH most_recent AS (SELECT max(updated) AS updated FROM t_graphql_operations) ' +
            'SELECT id, code AS query FROM t_graphql_operations WHERE updated = (select updated from most_recent)'
        )
        .then((res) => res.rows.map((o: { id: string; query: string }) => o));
    },
    async onPluginInit(_) {
      try {
        const { count, asOf } = await populateKnownQueries(knownQueries, pool);
        logger.info(`Loaded ${count} known preregistered query ids`);
        if (asOf) {
          PREREG_UPDATED_AT.labels({ worker }).set(asOf);
        }
      } catch (e) {
        logger.error(`Failed to load known preregistered queries: ${e}`);
        throw e; // Let's shut down; we could choose not to and hope that the next try works, but why be optimistic
      }
      await preloadCache(cache, pool, maxCacheSize).catch((err) =>
        logger.error(`Failed to preload preregisterd queries cache: ${err}`)
      );
      const refreshEvery = 100;
      let untilRefresh = refreshEvery;
      setInterval(() => {
        // Periodically execute a full refresh of the knownQueries set to allow
        // removals to be effective. The infrequency reflects our expectation
        // that this will be rare.
        let refresh = false;
        if (untilRefresh-- <= 0) {
          refresh = true;
          untilRefresh = refreshEvery;
        }

        populateKnownQueries(knownQueries, pool, refresh)
          .then(({ count, asOf }) => {
            if (count != 0 && asOf) {
              logger.debug(`prereg change: ${count} preregistered queries`);
              PREREG_UPDATED_AT.labels({ worker }).set(asOf);
            }
          })
          .catch((e) => logger.error(`Failed to update known query ids: ${e}`));
      }, 30000);
    },

    // Check extensions for a potential preregistered query id, and resolve it to the query text, parsed
    async onParams({ params, setParams }) {
      const extensions = params.extensions;
      const maybePreregisteredId: string | undefined =
        extensions?.['preRegisteredQueryId'];
      if (
        maybePreregisteredId &&
        (knownQueries.has(maybePreregisteredId) || knownQueries.size == 0)
      ) {
        let preregisteredQuery: string | undefined;
        const cached = cache.get(maybePreregisteredId);
        if (cached) {
          logger.debug(
            `preregistered query cache hit: ${maybePreregisteredId}`
          );
          preregisteredQuery = cached;
        } else if (
          (preregisteredQuery = await lookupQuery(maybePreregisteredId, pool))
        ) {
          logger.debug(
            'preregistered query cache miss: ',
            maybePreregisteredId
          );
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
          PREREG_UNK.labels({ worker }).inc();
          throw createGraphQLError('PreregisteredQueryNotResolved', {
            extensions: {
              http: {
                status: 503,
              },
            },
          });
        }
      } else if (maybePreregisteredId) {
        logger.debug(`preregistered query unresolved: ${maybePreregisteredId}`);
        PREREG_UNK.labels({ worker }).inc();
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
