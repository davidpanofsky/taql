import { ExecutorConfig, Subgraph, stitch } from '@ta-graphql-utils/stitch';
import { EventEmitter } from 'events';
import { Executor } from '@graphql-tools/utils';
import { GraphQLSchema } from 'graphql';
import { LEGACY_GQL_PARAMS } from '@taql/config';
import type { TaqlYogaPlugin } from '@taql/context';
import TypedEmitter from 'typed-emitter';
import { createExecutor as batchingExecutorFactory } from '@taql/batching';
import deepEqual from 'deep-equal';
import { getLegacySubgraph } from './legacy';
import { makeRemoteExecutor } from '@taql/executors';

export type SchemaDigest = {
  legacyHash: string;
  manifest: string;
};

export type TASchema = {
  schema: GraphQLSchema;
  digest: SchemaDigest;
};

const requestedMaxTimeout = LEGACY_GQL_PARAMS.maxTimeout;

const executorFactory = (config: ExecutorConfig): Executor =>
  config.batching != undefined
    ? batchingExecutorFactory(requestedMaxTimeout, config)
    : makeRemoteExecutor(config.url, requestedMaxTimeout);

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

  if (previous != undefined && deepEqual(digest, previous.digest)) {
    return previous;
  }

  subgraphs.push(legacy.subgraph);

  // TODO load schemas from schema repository, add to subschemas.

  try {
    const stitchResult = await stitch(subgraphs, executorFactory);

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
