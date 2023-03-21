import {
  DirectiveNode,
  GraphQLResolveInfo,
  GraphQLSchema,
  defaultFieldResolver,
} from 'graphql';
import { MapperKind, mapSchema } from '@graphql-tools/utils';

import { inspect } from 'util';

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function hasDirective(
  directiveName: string,
  info: GraphQLResolveInfo
): boolean {
  const { fieldNodeIndex, directiveIndex } = findDirective(directiveName, info);
  return fieldNodeIndex >= 0 && directiveIndex >= 0;
}

function stripDirective(
  info: GraphQLResolveInfo,
  fieldNodeIndex: number,
  directiveIndex: number
): GraphQLResolveInfo {
  if (!info.fieldNodes[fieldNodeIndex].directives) {
    return info;
  }
  const newDirectives = [
    ...(info.fieldNodes[fieldNodeIndex].directives as DirectiveNode[]),
  ];
  // Remove the directive
  newDirectives.splice(directiveIndex, 1);
  const newFieldNode = {
    ...info.fieldNodes[fieldNodeIndex],
    directives: newDirectives,
  };

  const newFieldNodes = [...info.fieldNodes];
  newFieldNodes.splice(fieldNodeIndex, 1, newFieldNode);
  return {
    ...info,
    fieldNodes: newFieldNodes,
  };
}

export function obfuscateDirective(directiveName: string) {
  return {
    typeDefs: `directive @${directiveName} on FIELD`,
    transformer: (schema: GraphQLSchema) =>
      mapSchema(schema, {
        [MapperKind.OBJECT_FIELD](fieldConfig) {
          // This is how you would extract a _schema_ directive.
          // const obfuscateDirective = getDirective(schema, fieldConfig, directiveName)?.[0]
          const { resolve = defaultFieldResolver } = fieldConfig;
          fieldConfig.resolve = async (source, args, context, info) => {
            // Pull a potential query directive out of `info`
            const { fieldNodeIndex, directiveIndex } = findDirective(
              directiveName,
              info
            );
            const shouldObfuscate = fieldNodeIndex >= 0 && directiveIndex >= 0;

            // We will double obfuscate if the upstream graphql that resolves the field also supports it.
            // Therefore we should modify the info object passed to the inner resolve to _not_ include the directive
            // that we are handling.
            // TODO: above
            let newInfo = info;
            if (shouldObfuscate) {
              newInfo = stripDirective(info, fieldNodeIndex, directiveIndex);
            }

            console.log(`source: ${inspect(source)}`);
            console.log(`args: ${inspect(args)}`);
            console.log(`context: ${inspect(context)}`);
            console.log(`(new)Info: ${inspect(newInfo)}`);

            const value = await resolve(source, args, context, newInfo);

            if (typeof value === 'string' && shouldObfuscate) {
              return obfuscate(value);
            } else {
              return value;
            }
          };
          return fieldConfig;
        },
      }),
  };
}

function obfuscate(value: string): string {
  return `_${value}_`;
}
