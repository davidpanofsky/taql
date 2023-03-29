import {
  GraphQLResolveInfo,
  GraphQLSchema,
  defaultFieldResolver,
} from 'graphql';
import { MapperKind, mapSchema } from '@graphql-tools/utils';

import RemoveDirective from './RemoveDirective';

function findDirective(directiveName: string, info: GraphQLResolveInfo) {
  const failed = { fieldNodeIndex: -1, directiveIndex: -1 };
  if (!info.fieldNodes) {
    return failed;
  }

  for (
    let fieldNodeIndex = 0;
    fieldNodeIndex < info.fieldNodes.length;
    fieldNodeIndex++
  ) {
    const fieldNode = info.fieldNodes[fieldNodeIndex];
    if (!fieldNode || !fieldNode.directives) {
      return failed;
    }

    for (
      let directiveIndex = 0;
      directiveIndex < fieldNode.directives.length;
      directiveIndex++
    ) {
      if (fieldNode.directives[directiveIndex].name?.value == directiveName) {
        return { fieldNodeIndex, directiveIndex };
      }
    }
  }
  return failed;
}

function hasDirective(
  directiveName: string,
  info: GraphQLResolveInfo
): boolean {
  const { fieldNodeIndex, directiveIndex } = findDirective(directiveName, info);
  return fieldNodeIndex >= 0 && directiveIndex >= 0;
}

export function obfuscateDirective(directiveName: string) {
  return {
    typeDefs: `directive @${directiveName} on FIELD`,
    schemaTransformer: (schema: GraphQLSchema) =>
      mapSchema(schema, {
        [MapperKind.OBJECT_FIELD](fieldConfig) {
          // This is how you would extract a _schema_ directive.
          // const obfuscateDirective = getDirective(schema, fieldConfig, directiveName)?.[0]
          const { resolve = defaultFieldResolver } = fieldConfig;
          fieldConfig.resolve = async (source, args, context, info) => {
            const shouldObfuscate = hasDirective(directiveName, info);
            const value = await resolve(source, args, context, info);

            if (typeof value === 'string' && shouldObfuscate) {
              return obfuscate(value);
            } else {
              return value;
            }
          };
          return fieldConfig;
        },
      }),
    queryTransformer: new RemoveDirective(directiveName),
  };
}

function obfuscate(value: string): string {
  if (!value) {
    return value;
  }
  const head = randomAlphanumeric(3);
  const tail = randomAlphanumeric(3);
  const surrounded = `${head}_${value}_${tail}`;
  return Buffer.from(surrounded, 'utf-8').toString('base64');
}

/**
 * Match roughly the behavior of apache's RandomStringUtils
 * https://commons.apache.org/proper/commons-lang/apidocs/org/apache/commons/lang3/RandomStringUtils.html#randomAlphanumeric-int-
 *
 * This implementation doesn't ever include capital letters, but this seems like a fair tradeoff for it being a compact, noncustom implementation
 */
function randomAlphanumeric(length: number): string {
  return Math.random().toString(36).substr(2, length);
}
