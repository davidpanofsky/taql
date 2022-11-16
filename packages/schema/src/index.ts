import { makeSchema as _makeSchema } from './schema';

export { SchemaPoller } from './schema';
export const makeSchema = () => _makeSchema().then((s) => s?.schema);
