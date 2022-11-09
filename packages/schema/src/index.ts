import {
  Options,
  makeSchema as _makeSchema,
  pollSchema as _pollSchema,
} from './schema';
import { GraphQLSchema } from 'graphql';

export const pollSchema = (
  options: Options,
  interval: number,
  callback: (schema: GraphQLSchema) => void
) =>
  _pollSchema(options, interval, (schema) => callback(schema.schema)).then(
    (taSchema) => taSchema.schema
  );
export const makeSchema = (options: Options) =>
  _makeSchema(options).then((s) => s.schema);
