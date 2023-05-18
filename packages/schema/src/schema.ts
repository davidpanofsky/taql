import { LegacyDebugResponseExtensions, fetchLegacySchema } from './legacy';
import { SubschemaConfig, Transform } from '@graphql-tools/delegate';
import { ENABLE_FEATURES } from '@taql/config';
import { EventEmitter } from 'events';
import { ForwardSubschemaExtensions } from '@taql/debug';
import { GraphQLSchema } from 'graphql';
import type { TaqlYogaPlugin } from '@taql/context';
import TypedEmitter from 'typed-emitter';
import deepEqual from 'deep-equal';
import { logger } from '@taql/config';
import { obfuscateDirective } from './directives';
import { stitchSchemas } from '@graphql-tools/stitch';

export type SchemaDigest = {
  legacyHash: string;
  manifest: string;
};

export type TASchema = {
  schema: GraphQLSchema;
  digest: SchemaDigest;
};

const queryDirectives = [
  obfuscateDirective('encode'),
  obfuscateDirective('obfuscate'),
];

export async function makeSchema({
  previous,
  legacySVCO,
}: {
  previous?: TASchema;
  legacySVCO?: string;
} = {}): Promise<TASchema | undefined> {
  const subschemas: SubschemaConfig[] = [];

  // TODO load manifest from schema repository

  const legacy = await fetchLegacySchema(legacySVCO).catch(() => undefined);
  const digest: SchemaDigest = { manifest: '', legacyHash: legacy?.hash || '' };

  if (previous != undefined && deepEqual(digest, previous.digest)) {
    return previous;
  }

  if (legacy != undefined) {
    subschemas.push({
      schema: await legacy.makeSchema(),
      executor: legacy.makeExecutor(),
      transforms: [
        ...queryDirectives.map((directive) => directive.queryTransformer),
        ...(ENABLE_FEATURES.debugExtensions
          ? [
              new ForwardSubschemaExtensions<LegacyDebugResponseExtensions>(
                'legacy-graphql',
                ({ serviceTimings }) => ({ serviceTimings })
              ),
            ]
          : []),
      ] as Transform[],
    });
  }

  // TODO load schemas from schema repository, add to subschemas.

  try {
    let schema = stitchSchemas({
      subschemas,
      mergeDirectives: true,
      typeDefs: queryDirectives.map((directive) => directive.typeDefs),
    });

    // Apply directive transformations to the schema
    schema = queryDirectives.reduce(
      (curSchema, directive) => directive.schemaTransformer(curSchema),
      schema
    );

    if (
      schema.__validationErrors == undefined ||
      schema.__validationErrors.length === 0
    ) {
      return {
        schema,
        digest,
      };
    }
    logger.error(
      `Schema failed to validate: [${schema.__validationErrors?.join('; ')}]`
    );
  } catch (err: unknown) {
    logger.error(`Error stitching schemas: ${err}`);
  }
  return undefined;
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
