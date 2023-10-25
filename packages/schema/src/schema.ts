import {
  BatchStyle,
  BatchingStrategy,
  Subgraph,
  SubgraphExecutorConfig,
  normalizeSdl,
  stitch,
} from '@ta-graphql-utils/stitch';
import { ENABLE_FEATURES, SCHEMA, logger } from '@taql/config';
import { GraphQLError, GraphQLSchema } from 'graphql';
import {
  SubgraphConfig,
  authManager,
  makeRemoteExecutor,
  requestFormatter,
} from '@taql/executors';
import { getLegacySubgraph, legacyTransforms } from './legacy';
import type { Executor } from '@graphql-tools/utils';
import { createExecutor as batchingExecutorFactory } from '@taql/batching';
import { inspect } from 'util';
import { loadSchema } from '@graphql-tools/load';
import { makeClient } from '@gsr/client';
import { promises } from 'fs';

export type TASchema = {
  schema: GraphQLSchema;
  isOverriddenBy: (svco?: string) => boolean;
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

  let isOverriddenBy = () => false;
  // Our runtime doesn't have `findLast` yet, so filter and pop to find the last legacy-graphql subgraph :(
  // There may be more than one if an override was applied; it is the last one that will be stitched.
  const legacySubgraph = supergraph.manifest
    .filter((sg) => sg.name == 'legacy-graphql')
    .pop();
  if (legacySubgraph != undefined) {
    // We know these roles do not affect the stitched schema. This list is not
    // intended to be exhaustive, and an exhaustive list is not desirable: services
    // may _become_ stitched, unless there is some special property or use case
    // around the service that makes that extremely unlikely.
    const legacyUrl = new URL(legacySubgraph.executorConfig.url);
    const legacyPort =
      legacyUrl.port || (legacyUrl.protocol == 'http:' ? 80 : 443);
    const nonstitchedRoles = [
      // the components svc only consumes the schema - it's probably what called us
      'components*',
      'componentsweb*',
      // taql _is_ us
      'taql*',
      `graphql*${legacyUrl.hostname}:${legacyPort}:${legacyUrl.protocol}`,
    ];
    logger.info(
      `Schema will ignore SVCO records starting with ${nonstitchedRoles}`
    );

    isOverriddenBy = (svco?: string) =>
      svco != undefined &&
      svco
        .split('|')
        .filter((role) => role.trim() !== '')
        .find(
          (role) =>
            // The role is not non-stitched, so it _may_ be stitched.
            nonstitchedRoles.find((nonStitched) =>
              role.startsWith(nonStitched)
            ) == undefined
        ) != undefined;

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
      return { success: { schema, isOverriddenBy, id: schemaId } };
    } else if ('schemaWithErrors' in stitchResult) {
      const { schemaWithErrors: schema } = stitchResult;
      return {
        partial: {
          schema,
          isOverriddenBy,
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
