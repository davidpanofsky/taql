import { BiWeakMap, logPrewarm } from './util';
import { DocumentNode, GraphQLSchema, validate } from 'graphql';
import { Plugin as YogaPlugin } from 'graphql-yoga';

export class ValidationCache {
  private readonly validationCache = new BiWeakMap<
    GraphQLSchema,
    DocumentNode,
    readonly unknown[]
  >();

  readonly prewarm = (
    schema: GraphQLSchema,
    documents: DocumentNode[]
  ): Promise<void> =>
    logPrewarm('validation', documents, (document) => {
      this.validationCache.set(schema, document, validate(schema, document));
    });

  readonly plugin: YogaPlugin = {
    onValidate: (args) => {
      const cached = this.validationCache.get(
        args.params.schema,
        args.params.documentAST
      );
      if (cached) {
        args.setResult(cached);
        return;
      } else {
        return ({ result }) =>
          this.validationCache.set(
            args.params.schema,
            args.params.documentAST,
            result
          );
      }
    },
  };
}
