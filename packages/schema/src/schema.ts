import { LegacyConfig, makeLegacySchema } from './legacy';
import { GraphQLSchema } from 'graphql';
import deepEqual from 'deep-equal';
import { stitchSchemas } from '@graphql-tools/stitch';

export type Options = {
  legacy?: LegacyConfig;
};

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
): Promise<TASchema> {
  const subschemas = [];
  let legacyHash = '';
  const manifest = '';

  // load legacy schema;
  if (options.legacy != undefined) {
    const legacy = await makeLegacySchema(options.legacy);
    legacyHash = legacy.hash;
    subschemas.push(legacy.schema);
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

  const schema = stitchSchemas({ subschemas });

  return {
    schema,
    digest,
  };
}

export async function pollSchema(
  options: Options,
  interval: number,
  callback: (schema: TASchema) => void
) {
  let last = await makeSchema(options);
  const sendSchema = async () => {
    makeSchema(options, last).then((schema) => {
      if (schema != last) {
        last = schema;
        callback(schema);
      }
    });
  };
  setInterval(sendSchema, interval);
  return last;
}
