import { GraphQLSchema, defaultFieldResolver } from 'graphql'
import { mapSchema, getDirective, MapperKind } from '@graphql-tools/utils'

import { inspect } from 'util';

export function obfuscateDirective(directiveName: string) {
  return {
    obfuscateDirectiveTypeDefs: `directive @${directiveName} on FIELD`,
    obfuscateDirectiveTransformer: (schema: GraphQLSchema) =>
      mapSchema(schema, {
        [MapperKind.OBJECT_FIELD](fieldConfig) {
          // This is how you would extract a _schema_ directive.
          // const obfuscateDirective = getDirective(schema, fieldConfig, directiveName)?.[0]

          const { resolve = defaultFieldResolver } = fieldConfig
          fieldConfig.resolve = async (source, args, context, info) => {
            // Pull a potential query directive out of `info`

            console.log("info.fieldNodes:");
            console.log(inspect(info.fieldNodes));
            
            const shouldObfuscate = false;
            const value = await resolve(source, args, context, info)

            if (typeof value === 'string' && shouldObfuscate) {
              return obfuscate(value)
            } else {
              return value;
            }
          }
          return fieldConfig
        }
      })
  }
}

function obfuscate(value: string): string {
  return `_${value}_`;
}
