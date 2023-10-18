import {
  DocumentNode,
  GraphQLSchema,
  Kind,
  NamedTypeNode,
  TypeNode,
  VariableDefinitionNode,
  execute,
} from 'graphql';
import { logPrewarm } from './util';
import { logger } from '@taql/config';

const getDummyVariableForNamedType = (
  schema: GraphQLSchema,
  type: NamedTypeNode
) => {
  switch (type.name.value) {
    case 'String':
    case 'ID':
      return 'dummy';
    case 'Int':
    case 'Long': // TA specific
    case 'Float':
      return 1;
    case 'Boolean':
      return true;
    default: {
      const schemaType = schema.getType(type.name.value);
      if (!schemaType || !schemaType.astNode) {
        logger.warn(`Could not find type defition for ${type.name.value}`);
        return undefined;
      }
      switch (schemaType.astNode.kind) {
        case Kind.ENUM_TYPE_DEFINITION:
          return schemaType.astNode.values?.[0].name.value;
        case Kind.INPUT_OBJECT_TYPE_DEFINITION:
          return Object.fromEntries(
            schemaType.astNode.fields?.map((def) => [
              def.name.value,
              getDummyVariable(schema, def.type),
            ]) || []
          );
        case Kind.SCALAR_TYPE_DEFINITION:
          return 1;
        default:
          throw new Error(`Unsupported type definition ${schemaType.astNode}`);
      }
    }
  }
};

const getDummyVariable = (
  schema: GraphQLSchema,
  type: TypeNode
): string | number | boolean | [] | Record<string, unknown> | undefined => {
  switch (type.kind) {
    case Kind.NON_NULL_TYPE:
      return getDummyVariable(schema, type.type);
    case Kind.LIST_TYPE:
      return [];
    case Kind.NAMED_TYPE:
      return getDummyVariableForNamedType(schema, type);
    default:
      throw new Error('Unsupported variable type', type);
  }
};

const getVariableDefinitions = (
  document: DocumentNode
): VariableDefinitionNode[] =>
  document.definitions.flatMap(
    (def) =>
      (def.kind === Kind.OPERATION_DEFINITION && def.variableDefinitions) || []
  );

/**
 * Prewarms the print cache and all the memoized document transformations that happen prior to printing
 * by executing all the queries using dummy variables.
 */
export async function prewarmExecutionCache(
  schema: GraphQLSchema,
  documents: DocumentNode[]
) {
  await logPrewarm('execute', documents, async (document) => {
    const variableValues = Object.fromEntries(
      getVariableDefinitions(document).map((def) => [
        def.variable.name.value,
        getDummyVariable(schema, def.type),
      ])
    );
    const result = await execute({
      schema,
      document,
      variableValues,
      contextValue: {
        isDummyRequest: true,
      },
    });
    if (
      result.errors &&
      result.errors.some((err) => err.message !== 'NullQuery')
    ) {
      logger.error('Error while prewarming execute cache', result.errors);
    }
  });
}
