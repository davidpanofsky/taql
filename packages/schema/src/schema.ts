import {
  BatchStyle,
  BatchingStrategy,
  Subgraph,
  SubgraphExecutorConfig,
  normalizeSdl,
  stitch,
} from '@ta-graphql-utils/stitch';
import { DEFAULT, ENABLE_FEATURES, SCHEMA, logger } from '@taql/config';
import { GraphQLError, GraphQLSchema } from 'graphql';
import {
  SubgraphConfig,
  authManager,
  makeRemoteExecutor,
  requestFormatter,
} from '@taql/executors';
import { getLegacySubgraph, legacyTransforms } from './legacy';
import type { Executor } from '@graphql-tools/utils';
import { Cluster as RedisCluster } from 'ioredis';
import { createExecutor as batchingExecutorFactory } from '@taql/batching';
import { inspect } from 'util';
import { loadSchema } from '@graphql-tools/load';
import { makeClient } from '@gsr/client';
import promClient from 'prom-client';
import { promises } from 'fs';

export type TASchema = {
  schema: GraphQLSchema;
  id: string;
};

export type ErrorSchema = {
  validationErrors: (string | GraphQLError)[];
};

export type PartialSchema = ErrorSchema & TASchema;

export type StitchResult =
  | {
      success: TASchema;
    }
  | { partial: PartialSchema }
  | {
      error: ErrorSchema;
    };

/**
 * Remove unused types from the schema.
 * If ENABLE_AST_DESCRIPTION env var is set to false descriptions will be removed too.
 */
export const optimizeSdl = async (rawSchema: string): Promise<string> => {
  const schema = await loadSchema(rawSchema, {
    loaders: [],
    noLocation: !ENABLE_FEATURES.astLocationInfo,
  });
  return normalizeSdl(schema, {
    noDescription: !ENABLE_FEATURES.astDescription,
  });
};

function makeExecutorFactory(): (config: SubgraphConfig) => Executor {
  return (config: SubgraphConfig): Executor =>
    config.batching != undefined
      ? batchingExecutorFactory(
          {
            ...(<
              SubgraphConfig &
                Required<Pick<SubgraphExecutorConfig, 'batching'>>
            >config),
          },
          requestFormatter()
        )
      : makeRemoteExecutor({ ...config });
}

type RawSupergraph = {
  id: string;
  manifest: Subgraph[];
  supergraph: string;
};

export type Supergraph = RawSupergraph & {
  legacyDigest?: string;
};

const loadSupergraphFromGsr = async (): Promise<RawSupergraph> => {
  const manager = authManager(SCHEMA.oidcLiteAuthorizationDomain);
  const gsrClient = makeClient(SCHEMA, manager);

  const supergraph = await gsrClient.supergraph({
    method: 'GET',
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

const subgraphsPulled = new promClient.Gauge({
  name: 'subgraphs_pulled',
  help: 'count of subgraphs pulled',
  labelNames: ['source'] as const,
});

const subgraphCacheMemory = new promClient.Gauge({
  name: 'subgraph_cache_size_bytes',
  help: 'size of cached subgraphs in bytes',
  labelNames: ['cacheKey'] as const,
});

/**
 * Try to update a metric with the cached schema size.  Unfortunately this doesn't seem reliable;
 * often we get null back without an error.  It seems that this is an issue with the command not being
 * handled by the node that actually has the key.
 * For now this is best effort. Hopefully _an_ instance will succeed in surfacing the information.
 */
const updateSubgraphCacheSizeMetric = (key: string, client: RedisCluster) => {
  client.memory('USAGE', key, (err, result) => {
    if (err) {
      console.warn(
        `Failed to fetch size of cached manifests with key ${key}: ${err}`
      );
      return;
    }
    if (result) {
      logger.info(`Current cached schema size (bytes): ${result}`);
      subgraphCacheMemory.set({ cacheKey: key }, result);
    } else {
      logger.warn(
        `Got null when fetching size of cached schema for key ${key}`
      );
    }
  });
};

const loadSchemaFromCache = async (
  key: string,
  redisClient: RedisCluster
): Promise<Subgraph[]> => {
  const raw = await redisClient.get(SCHEMA.schemaCacheKey);
  if (raw == null) {
    throw new Error(`No cached schema found with key ${key}`);
  }

  return JSON.parse(raw);
};

export const loadSupergraph = async (options: {
  source: string;
  updateCache?: boolean;
  useCacheOnFailure?: boolean;
  schemaCacheKey?: string;
  lastSchemaDigestKey?: string;
  schemaFile?: string;
  redisCluster?: string;
  redisPort?: number;
}): Promise<Supergraph> => {
  const {
    source,
    updateCache = !(options.source == 'file' || options.source == 'cache'),
    useCacheOnFailure = SCHEMA.trySchemaFromCache,
    schemaCacheKey = SCHEMA.schemaCacheKey,
    lastSchemaDigestKey = SCHEMA.lastSchemaDigestKey,
    schemaFile = SCHEMA.schemaFile,
    redisCluster = DEFAULT.redisCluster,
    redisPort = DEFAULT.redisPort,
  } = options;

  if (source == 'file') {
    logger.info(`loaded supergraph from file: ${schemaFile}`);
    if (schemaFile == undefined) {
      throw new Error('no schema file specified');
    }
    return JSON.parse(await promises.readFile(schemaFile, 'utf-8'));
  }

  const wantsCache = updateCache || useCacheOnFailure || source == 'cache';

  if (wantsCache && !redisCluster) {
    logger.error(
      'loadSupergraph configured to interact with cache, but redis is not configured!'
    );
  }

  const redisClient =
    wantsCache && redisCluster
      ? new RedisCluster([
          {
            host: redisCluster,
            port: redisPort,
          },
        ])
      : undefined;

  let id = 'unknown';
  let manifest: Subgraph[] = [];
  let sdl = '';
  let legacyDigest: string | undefined = undefined;
  let fromCache = false;

  // try ... finally redisClient.disconnect()
  try {
    // try pulling the schema from the configured source.
    try {
      if (source == 'cache') {
        if (!redisClient) {
          throw new Error(
            "Schema source is set to 'cache' but there is no configured default redis cache"
          );
        }
        logger.info(
          `loading supergraph preferentially from cache with key = ${schemaCacheKey}`
        );
        manifest = await loadSchemaFromCache(schemaCacheKey, redisClient);
        fromCache = true;
        subgraphsPulled.set({ source: 'cache' }, manifest.length);
        updateSubgraphCacheSizeMetric(schemaCacheKey, redisClient);
      } else {
        logger.info('loading supergraph from GSR');
        const supergraph = await loadSupergraphFromGsr();
        id = supergraph.id;
        sdl = supergraph.supergraph;
        manifest = [...supergraph.manifest];
        subgraphsPulled.set({ source: 'gsr' }, manifest.length);
      }
    } catch (err) {
      if (
        source == 'cache' ||
        SCHEMA.legacySchemaSource == 'gsr' ||
        !useCacheOnFailure ||
        !redisClient
      ) {
        // we have no schema. DO not proceed.
        throw err;
      }
      logger.error(
        `unable to load schema from GSR: ${err}, trying to load from cache...`
      );
      // try loading from the cache after failing to pull from the configured source
      try {
        manifest = await loadSchemaFromCache(schemaCacheKey, redisClient);
        fromCache = true;
        subgraphsPulled.set({ source: 'cache' }, manifest.length);
        updateSubgraphCacheSizeMetric(schemaCacheKey, redisClient);
        console.log(
          `Successfully pulled ${manifest.length} subgraphs from cache`
        );
      } catch (redisErr) {
        console.error(`unable to load cached schema from redis: ${redisErr}`);
        // Throw the original error from the GSR
        throw err;
      }
    }

    if (!fromCache && updateCache && redisClient) {
      // try updating the redis cache
      try {
        logger.info('Caching subgraph manifests in redis');
        const lastSchemaDigest = await redisClient.get(lastSchemaDigestKey);
        const stringifiedManifest = JSON.stringify(manifest);
        await redisClient.set(schemaCacheKey, stringifiedManifest);
        updateSubgraphCacheSizeMetric(schemaCacheKey, redisClient);

        if (SCHEMA.schemaDigest) {
          // In bootstrapping environments, there might be no schema digest specified in the environment.
          await redisClient.set(SCHEMA.schemaDigest, stringifiedManifest);
          updateSubgraphCacheSizeMetric(SCHEMA.schemaDigest, redisClient);
        }

        if (
          lastSchemaDigest &&
          SCHEMA.schemaDigest &&
          lastSchemaDigest != SCHEMA.schemaDigest
        ) {
          // We are observing a new schema, update the cached digest with the new one and expire the old
          // cache after 48 hours.
          await redisClient.set(lastSchemaDigestKey, SCHEMA.schemaDigest);
          await redisClient.expire(lastSchemaDigest, 2 * 24 * 60 * 60);
        }
      } catch (err) {
        logger.error(`Unable to cache subgraph manifests in redis: ${err}`);
      }
    }
  } finally {
    // try to shut down the redis client if one has been constructed
    try {
      redisClient && redisClient.disconnect();
    } catch (disconnectErr) {
      console.warn(
        `Error while shutting down schema cache redis client: ${disconnectErr}`
      );
    }
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
    subgraphsPulled.set({ source: 'legacy' }, 1);
  }

  const subgraphs = await Promise.all(
    manifest.map(async ({ sdl: subgraphSdl, ...rest }) => ({
      ...rest,
      sdl: await optimizeSdl(subgraphSdl),
    }))
  );

  const stitched = await stitch({
    subgraphs,
    parseOptions: {
      noLocation: !ENABLE_FEATURES.astLocationInfo,
    },
  });
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
    manifest: subgraphs,
    supergraph: reprintedSdl,
    legacyDigest,
  };
};

export const makeSchema = async (
  supergraph: Supergraph
): Promise<StitchResult> => {
  const schemaId =
    supergraph.id +
    (supergraph.legacyDigest != undefined ? `_${supergraph.legacyDigest}` : '');

  // Our runtime doesn't have `findLast` yet, so filter and pop to find the last legacy-graphql subgraph :(
  // There may be more than one if an override was applied; it is the last one that will be stitched.
  const legacySubgraph = supergraph.manifest
    .filter((sg) => sg.name == 'legacy-graphql')
    .pop();
  if (legacySubgraph != undefined) {
    // We need a few transforms for the legacy subgraph to work, add a final copy of it to the manifest with the transforms
    // Cast to dangerously escape the readonly nature of the subgraphs.
    (<Record<string, unknown>>legacySubgraph).transforms = legacyTransforms;
  }

  try {
    const stitchResult = await stitch({
      subgraphs: supergraph.manifest,
      executorFactory: makeExecutorFactory(),
      parseOptions: {
        noLocation: !ENABLE_FEATURES.astLocationInfo,
      },
    });

    let validationErrors: (string | GraphQLError)[] = [];
    if ('errors' in stitchResult) {
      validationErrors = stitchResult.errors;
    }

    if ('schema' in stitchResult) {
      const { schema } = stitchResult;
      return { success: { schema, id: schemaId } };
    } else if ('schemaWithErrors' in stitchResult) {
      const { schemaWithErrors: schema } = stitchResult;
      return {
        partial: {
          schema,
          validationErrors,
          id: schemaId,
        },
      };
    } else {
      return { error: { validationErrors } };
    }
  } catch (err: unknown) {
    throw new Error(`Error stitching schemas: ${err}`);
  }
};

export const overrideSupergraphWithSvco = async (
  supergraph: Supergraph,
  legacySVCO: string
): Promise<StitchResult | undefined> => {
  const manifest: Subgraph[] = [...supergraph.manifest];
  const legacySubgraph = manifest.find((sg) => sg.name == 'legacy-graphql');
  if (legacySubgraph == undefined) {
    console.warn("Can't use svco without legacy graphql");
    return undefined;
  }

  const legacyHost = new URL(legacySubgraph.executorConfig.url);

  const legacyOverride = await getLegacySubgraph({
    url: legacyHost,
    oidcLiteAuthorizationDomain:
      legacySubgraph.executorConfig.oidcLiteAuthorizationDomain,
    batchMaxSize: legacySubgraph.executorConfig.batching?.maxSize ?? 250,
    batchStrategy:
      legacySubgraph.executorConfig.batching?.strategy ??
      <BatchingStrategy>'Headers',
    batchStyle:
      legacySubgraph.executorConfig.batching?.style ?? <BatchStyle>'Legacy',
    batchWaitMillis:
      legacySubgraph.executorConfig.batching?.wait?.millis ?? 200,
    legacySVCO,
    maxTimeout: legacySubgraph.executorConfig.sla?.maxTimeoutMillis ?? 5000,
  });

  if (
    legacyOverride.digest == supergraph.legacyDigest &&
    legacyOverride.subgraph.executorConfig.url ==
      legacySubgraph.executorConfig.url
  ) {
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
