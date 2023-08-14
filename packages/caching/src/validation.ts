import { BiWeakMap, logPrewarm } from './util';
import {
  DocumentNode,
  GraphQLSchema,
  getOperationAST,
  validate,
} from 'graphql';
import { Plugin as YogaPlugin } from 'graphql-yoga';
import promClient from 'prom-client';
import { WORKER as worker } from '@taql/config';

const labelNames = ['worker', 'operationType'];
const buckets = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5];

const UNCACHED_VALIDATE_DURATION_HISTOGRAM = new promClient.Histogram({
  name: 'taql_uncached_validate_duration',
  help: 'Time spent validating the graphql operation against the current schema',
  labelNames,
  buckets,
});

const instrumentedValidate: typeof validate = (...args) => {
  const document: DocumentNode = args[1];
  const stopTimer = UNCACHED_VALIDATE_DURATION_HISTOGRAM.startTimer({ worker });
  const result = validate(...args);
  const operationType = getOperationAST(document)?.operation || 'unknown';
  stopTimer({ operationType });
  return result;
};

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
      this.validationCache.set(
        schema,
        document,
        instrumentedValidate(schema, document)
      );
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
        args.setValidationFn(instrumentedValidate);
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
