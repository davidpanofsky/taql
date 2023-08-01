import { Cache, caching, multiCaching } from 'cache-manager';
import { LEGACY_GQL_PARAMS, PRINT_DOCUMENT_PARAMS, logger } from '@taql/config';
import {
  PrintedDocumentCacheConfig,
  makeRemoteExecutor,
  requestFormatter,
} from '@taql/executors';
import {
  Subgraph,
  SubgraphExecutorConfig,
  stitch,
} from '@ta-graphql-utils/stitch';
import {
  instrumentedStore,
  isCache,
  memoryStore,
  redisStore,
} from '@taql/caching';
import { EventEmitter } from 'events';
import type { Executor } from '@graphql-tools/utils';
import { GraphQLSchema } from 'graphql';
import type { TaqlYogaPlugin } from '@taql/context';
import type TypedEmitter from 'typed-emitter';
import { createExecutor as batchingExecutorFactory } from '@taql/batching';
import deepEqual from 'deep-equal';
import { getLegacySubgraph } from './legacy';

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
): (config: SubgraphExecutorConfig) => Executor {
  return (config: SubgraphExecutorConfig): Executor =>
    config.batching != undefined
      ? batchingExecutorFactory(
          {
            ...(<
              SubgraphExecutorConfig &
                Required<Pick<SubgraphExecutorConfig, 'batching'>>
            >config),
            requestedMaxTimeout,
          },
          requestFormatter(cacheConfig)
        )
      : makeRemoteExecutor({ ...config, requestedMaxTimeout });
}

/**
 * Converting from DocumentNode to string can take more than 20ms for some of our larger queries.
 * We'll cache the most common ones to avoid unnecessary work.
 * Currently only works for preregistered/persisted queries, as their respective IDs constitute a portion
 * of the cache key.
 */
async function createPrintedDocumentCache(params: {
  maxCacheSize: number;
  redisTTL: number;
  redisInstance?: string;
  redisCluster?: string;
  redisWaitTimeMs?: number;
}) {
  // Set up redis cache, if so configured
  const printCacheRedisParams = params.redisInstance
    ? {
        ttl: params.redisTTL,
        waitTimeMs: params.redisWaitTimeMs,
        host: params.redisInstance,
        port: 6379,
      }
    : params.redisCluster
    ? {
        ttl: params.redisTTL,
        waitTimeMs: params.redisWaitTimeMs,
        clusterConfig: {
          nodes: [
            {
              host: params.redisCluster,
              port: 6379,
            },
          ],
        },
      }
    : undefined;

  const cacheInfo = [
    `lru: max=${params.maxCacheSize}`,
    ...(printCacheRedisParams
      ? [
          `redis: ${params.redisInstance || params.redisCluster} ttl=${
            params.redisTTL
          }`,
        ]
      : []),
  ];

  logger.info(`building printed document cache: [${cacheInfo}]`);

  const printRedisStore =
    printCacheRedisParams &&
    instrumentedStore({
      name: 'printed_documents',
      store: redisStore<string>(printCacheRedisParams),
    });

  // Try to establish connection to redis before we start handling traffic
  await printRedisStore?.ready().catch((err) => {
    // Still use the store even if this fails, since we may get connection later
    // If we don't, volume of errors that store produces should let us know that something is wrong
    logger.error(err?.message || err);
  });

  // Multicache with redis if a redis configuration is present
  return multiCaching(
    [
      await caching(
        instrumentedStore({
          name: 'printed_documents',
          store: memoryStore<string>({
            max: params.maxCacheSize,
          }),
        })
      ),
      printRedisStore && (await caching(printRedisStore)),
    ].filter(isCache)
  );
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
    printedDocumentCache = await createPrintedDocumentCache(
      PRINT_DOCUMENT_PARAMS
    );
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
