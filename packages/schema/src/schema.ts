import { AuthManager, getManager } from '@ta-graphql-utils/auth-manager';
import { Cache, caching, multiCaching } from 'cache-manager';
import { GraphQLError, GraphQLSchema } from 'graphql';
import { PRINT_DOCUMENT_PARAMS, SCHEMA, logger } from '@taql/config';
import {
  PrintedDocumentCacheConfig,
  makeRemoteExecutor,
  requestFormatter,
} from '@taql/executors';
import {
  Subgraph,
  SubgraphExecutorConfig,
  normalizeSdl,
  stitch,
} from '@ta-graphql-utils/stitch';
import {
  instrumentedStore,
  isCache,
  memoryStore,
  redisStore,
} from '@taql/caching';
import type { Executor } from '@graphql-tools/utils';
import { createExecutor as batchingExecutorFactory } from '@taql/batching';
import { getLegacySubgraph } from './legacy';
import { inspect } from 'util';
import { makeClient } from '@gsr/client';
import { promises } from 'fs';

export type TASchema =
  | {
      schema: GraphQLSchema;
      validationErrors: (string | GraphQLError)[];
      id: string;
    }
  | { validationErrors: (string | GraphQLError)[] };

const requestedMaxTimeout = 5000;

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

const initAuth = (): AuthManager => {
  if (SCHEMA.useIam) {
    return getManager({ kind: 'iam' });
  } else {
    if (SCHEMA.identityToken == undefined) {
      throw new Error('cannot use oidc without identity token');
    }
    return getManager({ tokenPath: SCHEMA.identityToken });
  }
};

export type Supergraph = {
  id: string;
  manifest: Subgraph[];
  supergraph: string;
  legacyDigest?: string;
};

const loadSupergraphFromGsr = async (): Promise<Supergraph> => {
  const manager = initAuth();
  const gsrClient = makeClient(SCHEMA, manager);

  const supergraph = await gsrClient.supergraph({
    query: { environment: SCHEMA.environment },
  });
  switch (supergraph.statusCode) {
    case '200':
      return supergraph.body;
    case '404':
      throw new Error(
        `Unable to read supergraph: ${JSON.stringify(supergraph)}`
      );
  }
};

export const loadSupergraph = async (): Promise<Supergraph> => {
  if (SCHEMA.source == 'file') {
    logger.info(`loaded supergraph from file: ${SCHEMA.schemaFile}`);
    if (SCHEMA.schemaFile == undefined) {
      throw new Error('no schema file specified');
    }
    return JSON.parse(await promises.readFile(SCHEMA.schemaFile, 'utf-8'));
  }

  let id = 'unknown';
  let manifest: Subgraph[] = [];
  let sdl = '';
  let legacyDigest: string | undefined = undefined;

  try {
    logger.info('loading supergraph from GSR');
    const supergraph = await loadSupergraphFromGsr();
    id = supergraph.id;
    sdl = supergraph.supergraph;
    manifest = [...supergraph.manifest];
  } catch (err) {
    if (SCHEMA.legacySchemaSource == 'gsr') {
      // we have no schema. DO not proceed.
      throw err;
    }
    // TODO
    // This is a safety valve to allow us to 'test' GSR contact
    // by trying to load from GSR but falling back to querying legacy graphql.
    // That possibility will not remain long; remove this.
    logger.error(`unable to load schema from GSR: ${err}`);
  }

  if (SCHEMA.legacySchemaSource != 'gsr') {
    logger.info(
      `loading legacy subgraph from ${SCHEMA.legacySchemaSource.url}`
    );
    const { subgraph, digest } = await getLegacySubgraph(
      SCHEMA.legacySchemaSource
    );
    legacyDigest = digest;
    manifest.push(subgraph);
  }
  const stitched = await stitch(manifest);
  if (!('schema' in stitched)) {
    throw new Error(`Unable to stitch schema: ${inspect(stitched)}`);
  }

  // Check that we know what we're doing.
  const reprintedSdl = normalizeSdl(stitched.schema);
  if (SCHEMA.legacySchemaSource == 'gsr' && reprintedSdl != sdl) {
    // warn and continue.
    logger.warn(
      'Stitched schema SDL does not match SDL retrieved from GSR. Ensure GSR and taql have the same stitch version.'
    );
  }

  return {
    id,
    manifest,
    supergraph: reprintedSdl,
    legacyDigest,
  };
};

export const makeSchema = async (supergraph: Supergraph): Promise<TASchema> => {
  // Initialize the printed document cache if it hasn't been already
  if (!printedDocumentCache) {
    printedDocumentCache = await createPrintedDocumentCache(
      PRINT_DOCUMENT_PARAMS
    );
  }
  const schemaId =
    supergraph.id + supergraph.legacyDigest != undefined
      ? `_${supergraph.legacyDigest}`
      : '';

  const cacheConfig: PrintedDocumentCacheConfig = {
    cache: printedDocumentCache,
    keyFn(queryId: string, fieldName: string | number) {
      return `${queryId}_${fieldName}_${schemaId}`;
    },
  };

  try {
    const stitchResult = await stitch(
      supergraph.manifest,
      makeExecutorFactory(cacheConfig)
    );

    let validationErrors: (string | GraphQLError)[] = [];
    if ('errors' in stitchResult) {
      validationErrors = stitchResult.errors;
    }

    if ('schema' in stitchResult) {
      const { schema } = stitchResult;
      return { schema, validationErrors, id: schemaId };
    } else if ('schemaWithErrors' in stitchResult) {
      const { schemaWithErrors: schema } = stitchResult;
      return { schema, validationErrors, id: schemaId };
    } else {
      return { validationErrors };
    }
  } catch (err: unknown) {
    throw new Error(`Error stitching schemas: ${err}`);
  }
};

export const overrideSupergraphWithSvco = async (
  supergraph: Supergraph,
  legacySVCO: string
): Promise<TASchema | undefined> => {
  const manifest: Subgraph[] = [...supergraph.manifest];
  const legacySubgraph = manifest.find((sg) => sg.name == 'legacy-graphql');
  if (legacySubgraph == undefined) {
    console.warn("Can't use svco without legacy graphql");
    return undefined;
  }

  const legacyHost = new URL(legacySubgraph.executorConfig.url);

  const legacyOverride = await getLegacySubgraph({
    url: legacyHost,
    batchMaxSize: legacySubgraph.executorConfig.batching?.maxSize ?? 250,
    batchWaitQueries:
      legacySubgraph.executorConfig.batching?.wait?.queries ?? 20,
    batchWaitMillis:
      legacySubgraph.executorConfig.batching?.wait?.millis ?? 200,
    legacySVCO,
  });

  if (legacyOverride.digest == supergraph.legacyDigest) {
    //no change
    return undefined;
  }
  manifest.push(legacyOverride.subgraph);
  return makeSchema({
    ...supergraph,
    manifest,
    legacyDigest: legacyOverride.digest,
  });
};
