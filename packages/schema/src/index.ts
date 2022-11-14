import { Options, makeSchema as _makeSchema } from './schema';

export { SchemaPoller } from './schema';
export const makeSchema = (options: Options) =>
  _makeSchema(options).then((s) => s?.schema);
