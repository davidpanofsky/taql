import { makeSchema as _makeSchema } from './schema';

export { SchemaPoller } from './schema';
export const makeSchema = (legacySVCO?: string) =>
  _makeSchema({ legacySVCO }).then((s) => s?.schema);
