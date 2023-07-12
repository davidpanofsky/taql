import { Cache, caching, multiCaching } from 'cache-manager';
import { ExecutorConfig, Subgraph, stitch } from '@ta-graphql-utils/stitch';
import { InstrumentedCache, wrappedLRUStore } from '@taql/metrics';
import { LEGACY_GQL_PARAMS, PRINT_DOCUMENT_PARAMS, logger } from '@taql/config';
import {
  PrintedDocumentCacheConfig,
  makeRemoteExecutor,
  requestFormatter,
} from '@taql/executors';
import { EventEmitter } from 'events';
import { Executor } from '@graphql-tools/utils';
import { GraphQLSchema } from 'graphql';
import type { TaqlYogaPlugin } from '@taql/context';
import TypedEmitter from 'typed-emitter';
import { createExecutor as batchingExecutorFactory } from '@taql/batching';
import deepEqual from 'deep-equal';
import { getLegacySubgraph } from './legacy';
import { ioRedisStore } from '@tirke/node-cache-manager-ioredis';

export type SchemaDigest = {
  legacyHash: string;
  manifest: string;
};

export type TASchema = {
  schema: GraphQLSchema;
  digest: SchemaDigest;
};

const requestedMaxTimeout = LEGACY_GQL_PARAMS.maxTimeout;

function makeExecutorFactory(
  cacheConfig: PrintedDocumentCacheConfig
): (config: ExecutorConfig) => Executor {
  return (config: ExecutorConfig): Executor =>
    config.batching != undefined
      ? batchingExecutorFactory(
          requestedMaxTimeout,
          config,
          requestFormatter(cacheConfig)
        )
      : makeRemoteExecutor(config.url, requestedMaxTimeout);
}

/**
 * Converting from DocumentNode to string can take more than 20ms for some of our lagger queries.
 * We'll cache the most common ones to avoid unnecessary work.
 * Currently only works for preregistered/persisted queries, as that's the only thing we could use as a cache key.
 */
async function createPrintedDocumentCache() {
  // Set up redis cache, if so configured
  const printCacheRedisParams = PRINT_DOCUMENT_PARAMS.redisInstance
    ? {
        ttl: PRINT_DOCUMENT_PARAMS.redisTTL,
        host: PRINT_DOCUMENT_PARAMS.redisInstance,
        port: 6379,
      }
    : PRINT_DOCUMENT_PARAMS.redisCluster
    ? {
        ttl: PRINT_DOCUMENT_PARAMS.redisTTL,
        clusterConfig: {
          nodes: [
            {
              host: PRINT_DOCUMENT_PARAMS.redisCluster,
              port: 6379,
            },
          ],
        },
      }
    : undefined;

  const printCacheWrappedRedis =
    printCacheRedisParams && ioRedisStore(printCacheRedisParams);

  // Multicache with redis if a redis configuration is present
  return multiCaching([
    await caching(
      wrappedLRUStore({
        cache: new InstrumentedCache<string, string>('printed_documents', {
          max: PRINT_DOCUMENT_PARAMS.maxCacheSize,
        }),
      })
    ),
    ...(printCacheWrappedRedis ? [await caching(printCacheWrappedRedis)] : []),
  ]);
}

let printedDocumentCache: Omit<Cache, 'store'>;

export async function makeSchema({
  previous,
  legacySVCO,
}: {
  previous?: TASchema;
  legacySVCO?: string;
} = {}): Promise<TASchema> {
  const subgraphs: Subgraph[] = [];

  // TODO load manifest from schema repository

  const legacy = await getLegacySubgraph(legacySVCO);
  const digest: SchemaDigest = { manifest: '', legacyHash: legacy?.hash || '' };

  // Initialize the printed document cache if it hasn't been already
  if (!printedDocumentCache) {
    logger.info('building printed document cache');
    printedDocumentCache = await createPrintedDocumentCache();
  }

  const cacheConfig: PrintedDocumentCacheConfig = {
    cache: printedDocumentCache,
    keyFn(queryId: string, fieldName: string | number) {
      return `${queryId}_${fieldName}_${digest.manifest}_${digest.legacyHash}`;
    },
  };

  if (previous != undefined && deepEqual(digest, previous.digest)) {
    return previous;
  }

  subgraphs.push(legacy.subgraph);

  // TODO load schemas from schema repository, add to subschemas.

  try {
    const stitchResult = await stitch(
      subgraphs,
      makeExecutorFactory(cacheConfig)
    );

    if ('errors' in stitchResult) {
      throw new Error(
        `Schema failed to validate: ${stitchResult.errors.toString()}`
      );
    }

    if ('schema' in stitchResult) {
      const { schema } = stitchResult;
      return { schema, digest };
    } else {
      throw new Error('No schema in stitch result');
    }
  } catch (err: unknown) {
    throw new Error(`Error stitching schemas: ${err}`);
  }
}

type SchemaEvents = {
  schema: (schema: GraphQLSchema) => void;
};

export class SchemaPoller extends (EventEmitter as new () => TypedEmitter<SchemaEvents>) {
  private _schema: undefined | TASchema | Promise<TASchema | undefined>;

  constructor(args: { interval: number }) {
    super();
    const { interval } = args;
    this._schema = makeSchema();
    setInterval(this.tryUpdate.bind(this), interval);
  }

  private async tryUpdate() {
    const prev = await this._schema;
    const next = await makeSchema({ previous: prev });
    if (next != prev && next != undefined) {
      // Don't update on broken schemas. The change between any two
      // schemas likely concerns very few subgraphs. If changing them
      // fails validation, we'll see errors in calls to them no matter
      // what. The rest of the schema is probably fine, so skipping the
      // update preserves most of our functionality. Conversely, producing
      // an empty schema at this juncture would cause every query to fail.
      this._schema = next;
      this.emit('schema', next.schema);
    }
  }

  public asPlugin(): TaqlYogaPlugin {
    const onSchema = this.on.bind(this, 'schema');
    return {
      onPluginInit({ setSchema }) {
        onSchema((schema) => setSchema(schema));
      },
    };
  }

  get schema(): Promise<GraphQLSchema | undefined> {
    return Promise.resolve(this._schema).then((s) => s?.schema);
  }
}
