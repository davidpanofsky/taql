import { makeSchema as _makeSchema } from './schema';

export { SchemaDigest, SchemaPoller } from './schema';
export const makeSchema = (legacySVCO?: string) =>
  _makeSchema({ legacySVCO }).then((s) => s?.schema);

export const makeSchemaWithDigest = (legacySVCO?: string) =>
  _makeSchema({ legacySVCO });
