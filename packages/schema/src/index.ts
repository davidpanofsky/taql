import { LegacyConfig, makeLegacySchema } from './legacy';
import { stitchSchemas } from '@graphql-tools/stitch';

export type Options = {
  legacy?: LegacyConfig;
};

export async function makeSchema(options: Options) {
  const subschemas = [];
  if (options.legacy != undefined) {
    subschemas.push(await makeLegacySchema(options.legacy));
  } else {
    console.log('legacy graphql will not be stitched');
  }
  //TODO: generic loading for every other schema.
  // build the combined schema
  return stitchSchemas({
    subschemas,
  });
}
