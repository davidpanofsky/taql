// lifted from https://github.com/dotansimha/graphql-yoga/blob/266488af2a79358b45a6fb697bf51f34489d95a4/packages/graphql-yoga/src/plugins/use-schema.ts with minor fixes

// The gist of it is that the caching saved the dynamic schema on a weakmap against one request object (that is not necessarily the context request object) - now we use the
// request object in the context for that every time. It is unclear whether this fix is generally applicable/worth upstreaming. Turning this into our own schema caching
// plugin makes it _ok_ that we are using our own knowledge of our context layout to sort it out.

import { GraphQLSchema, isSchema } from 'graphql';
import type {
  GraphQLSchemaWithContext,
  Plugin,
  YogaInitialContext,
} from 'graphql-yoga';
import { PromiseOrValue } from '@envelop/core';

export type YogaSchemaDefinition<TServerContext, TUserContext> =
  | PromiseOrValue<
      GraphQLSchemaWithContext<
        TServerContext & YogaInitialContext & TUserContext
      >
    >
  | ((
      context: TServerContext & { request: YogaInitialContext['request'] }
    ) => PromiseOrValue<
      GraphQLSchemaWithContext<
        TServerContext & YogaInitialContext & TUserContext
      >
    >);

export const useSchema = <
  // eslint-disable-next-line @typescript-eslint/ban-types
  TServerContext = {},
  // eslint-disable-next-line @typescript-eslint/ban-types
  TUserContext = {},
>(
  schemaDef?: YogaSchemaDefinition<TServerContext, TUserContext>
): Plugin<YogaInitialContext & TServerContext> => {
  if (schemaDef == null) {
    return {};
  }
  if (isSchema(schemaDef)) {
    return {
      onPluginInit({ setSchema }) {
        setSchema(schemaDef);
      },
    };
  }
  if ('then' in schemaDef) {
    let schema: GraphQLSchema | undefined;
    return {
      onRequestParse() {
        return {
          async onRequestParseDone() {
            schema ||= await schemaDef;
          },
        };
      },
      onEnveloped({ setSchema }) {
        if (!schema) {
          throw new Error(
            "You provide a promise of a schema but it hasn't been resolved yet. Make sure you use this plugin with GraphQL Yoga."
          );
        }
        setSchema(schema);
      },
    };
  }
  const schemaByRequest = new WeakMap<Request, GraphQLSchema>();
  return {
    onRequestParse({ request, serverContext }) {
      return {
        async onRequestParseDone() {
          const schema = await schemaDef({
            ...(serverContext as TServerContext),
            request,
          });
          schemaByRequest.set(
            (<{ request: Request }>serverContext).request ?? request,
            schema
          );
        },
      };
    },
    onEnveloped({ setSchema, context }) {
      if (context?.request == null) {
        throw new Error(
          'Request object is not available in the context. Make sure you use this plugin with GraphQL Yoga.'
        );
      }
      const schema = schemaByRequest.get(context.request);
      if (schema == null) {
        throw new Error(
          'No schema found for this request. Make sure you use this plugin with GraphQL Yoga.'
        );
      }
      setSchema(schema);
    },
  };
};
