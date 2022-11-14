import { LegacyConfig, makeLegacySchema } from './legacy';
import { EventEmitter } from 'events';
import { GraphQLSchema } from 'graphql';
import { Plugin } from '@envelop/core';
import TypedEmitter from 'typed-emitter';
import deepEqual from 'deep-equal';
import { stitchSchemas } from '@graphql-tools/stitch';

export type Options = Readonly<{
  legacy?: LegacyConfig;
}>;

export type SchemaDigest = {
  legacyHash: string;
  manifest: string;
};

export type TASchema = {
  schema: GraphQLSchema;
  digest: SchemaDigest;
};

export async function makeSchema(
  options: Options,
  previous?: TASchema
): Promise<TASchema | undefined> {
  const subschemas = [];
  let legacyHash = '';
  const manifest = '';

  // load legacy schema;
  if (options.legacy != undefined) {
    const legacy = await makeLegacySchema(options.legacy).catch(
      () => undefined
    );
    if (legacy != undefined) {
      legacyHash = legacy.hash;
      subschemas.push(legacy.schema);
    }
  } else {
    console.log('legacy graphql will not be stitched');
  }

  // TODO load manifest from schema repository

  const digest: SchemaDigest = {
    manifest,
    legacyHash,
  };

  if (previous != undefined && deepEqual(digest, previous.digest)) {
    return previous;
  }

  // TODO load schemas from schema repository, add to subschemas.

  try {
    const schema = stitchSchemas({ subschemas });
    if (
      schema.__validationErrors == undefined ||
      schema.__validationErrors.length === 0
    ) {
      return {
        schema,
        digest,
      };
    }
    console.error(
      `Schema failed to validate: [${schema.__validationErrors?.join('; ')}]`
    );
  } catch (err: unknown) {
    console.error(`Error stitching schemas: ${err}`);
  }
  return undefined;
}

type SchemaEvents = {
  schema: (schema: GraphQLSchema) => void;
};

export class SchemaPoller extends (EventEmitter as new () => TypedEmitter<SchemaEvents>) {
  private readonly options: Options;

  private _schema: undefined | TASchema | Promise<TASchema | undefined>;

  constructor(args: { options: Options; interval: number }) {
    super();
    const { options, interval } = args;
    this.options = options;
    this._schema = makeSchema(this.options);
    setInterval(this.tryUpdate.bind(this), interval);
  }

  private async tryUpdate() {
    const prev = await this._schema;
    const next = await makeSchema(this.options, prev);
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

  public asPlugin(): Plugin {
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
