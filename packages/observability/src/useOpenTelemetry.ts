import * as opentelemetry from '@opentelemetry/api';
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { OnExecuteHookResult, Plugin, isAsyncIterable } from '@envelop/core';
import { SpanAttributes, SpanKind, TracerProvider } from '@opentelemetry/api';
import { getOperationAST } from 'graphql';
import { useOnResolve } from '@envelop/on-resolve';

export enum AttributeName {
  RESOLVER_EXCEPTION = 'graphql.resolver.exception',
  RESOLVER_FIELD_NAME = 'graphql.resolver.fieldName',
  RESOLVER_TYPE_NAME = 'graphql.resolver.typeName',
  RESOLVER_RESULT_TYPE = 'graphql.resolver.resultType',
  RESOLVER_ARGS = 'graphql.resolver.args',
  EXECUTION_ERROR = 'graphql.execute.error',
  EXECUTION_RESULT = 'graphql.execute.result',
  EXECUTION_OPERATION_NAME = 'graphql.execute.operationName',
  EXECUTION_VARIABLES = 'graphql.execute.variables',
  VALIDATION_OPERATION_NAME = 'graphql.validate.operationName',
  VALIDATION_ERROR = 'graphql.validate.error',
  VALIDATION_RESULT = 'graphql.validate.result',
  PARSE_OPERATION_NAME = 'graphql.parse.operationName',
  PARSE_ERROR = 'graphql.parse.error',
}

const tracingSpanSymbol = Symbol('OPEN_TELEMETRY_GRAPHQL');

export type TracingOptions = {
  resolvers: boolean;
  variables: boolean;
  result: boolean;
};

type PluginContext = {
  [tracingSpanSymbol]: opentelemetry.Span;
};

export const useOpenTelemetry = (
  options: TracingOptions,
  tracingProvider?: TracerProvider,
  spanKind: SpanKind = SpanKind.SERVER,
  spanAdditionalAttributes: SpanAttributes = {},
  serviceName = 'taql'
): Plugin<PluginContext> => {
  if (!tracingProvider) {
    const basicTraceProvider = new BasicTracerProvider();
    basicTraceProvider.addSpanProcessor(
      new SimpleSpanProcessor(new ConsoleSpanExporter())
    );
    basicTraceProvider.register();
    tracingProvider = basicTraceProvider;
  }

  const tracer = tracingProvider.getTracer(serviceName);

  return {
    onPluginInit({ addPlugin }) {
      if (options.resolvers) {
        addPlugin(
          useOnResolve(({ info, context, args }) => {
            if (
              context &&
              typeof context === 'object' &&
              context[tracingSpanSymbol]
            ) {
              const ctx = opentelemetry.trace.setSpan(
                opentelemetry.context.active(),
                context[tracingSpanSymbol]
              );
              const { fieldName, returnType, parentType } = info;

              const resolverSpan = tracer.startSpan(
                `resolve - ${parentType.name}.${fieldName}`,
                {
                  attributes: {
                    [AttributeName.RESOLVER_FIELD_NAME]: fieldName,
                    [AttributeName.RESOLVER_TYPE_NAME]: parentType.toString(),
                    [AttributeName.RESOLVER_RESULT_TYPE]: returnType.toString(),
                    [AttributeName.RESOLVER_ARGS]: JSON.stringify(args || {}),
                  },
                },
                ctx
              );

              return ({ result }) => {
                if (result instanceof Error) {
                  resolverSpan.recordException({
                    name: AttributeName.RESOLVER_EXCEPTION,
                    message: JSON.stringify(result),
                  });
                }
                resolverSpan.end();
              };
            }

            // eslint-disable-next-line @typescript-eslint/no-empty-function
            return () => {};
          })
        );
      }
    },

    onParse() {
      const parseSpan = tracer.startSpan('parse - Anonymous Operation', {
        kind: spanKind,
        attributes: {
          ...spanAdditionalAttributes,
        },
      });

      return function afterParse({ result }) {
        if (result instanceof Error) {
          parseSpan.recordException({
            name: AttributeName.PARSE_ERROR,
            message: JSON.stringify(result),
          });
        } else {
          const operationAST = getOperationAST(result);
          const operationName = operationAST?.name?.value;
          parseSpan.updateName(
            `parse  - ${operationName || 'Anonymous Operation'}`
          );
          if (operationName) {
            parseSpan.setAttribute(
              AttributeName.PARSE_OPERATION_NAME,
              operationName
            );
          }
        }
        parseSpan.end();
      };
    },

    onValidate({ params }) {
      const operationAST = getOperationAST(params.documentAST);
      const operationName = operationAST?.name?.value;
      const validationSpan = tracer.startSpan(
        `validate - ${operationName || 'Anonymous Operation'}`,
        {
          kind: spanKind,
          attributes: {
            ...spanAdditionalAttributes,
            [AttributeName.VALIDATION_OPERATION_NAME]: operationName,
          },
        }
      );

      return function afterValidation({ result: errors, valid }) {
        validationSpan.setAttribute(AttributeName.VALIDATION_RESULT, valid);

        if (errors && errors.length > 0) {
          validationSpan.recordException({
            name: AttributeName.VALIDATION_ERROR,
            message: JSON.stringify(errors),
          });
        }

        validationSpan.end();
      };
    },

    onExecute({ args, extendContext }) {
      const operationAST = getOperationAST(args.document, args.operationName);
      const operationName = operationAST?.name?.value;
      const executionSpan = tracer.startSpan(
        `execute - ${operationName || 'Anonymous Operation'}`,
        {
          kind: spanKind,
          attributes: {
            ...spanAdditionalAttributes,
            [AttributeName.EXECUTION_OPERATION_NAME]: operationName,
            ...(options.variables
              ? {
                  [AttributeName.EXECUTION_VARIABLES]: JSON.stringify(
                    args.variableValues ?? {}
                  ),
                }
              : {}),
          },
        }
      );

      const resultCbs: OnExecuteHookResult<PluginContext> = {
        onExecuteDone({ result }) {
          if (isAsyncIterable(result)) {
            executionSpan.end();
            // eslint-disable-next-line no-console
            console.warn(
              'Plugin "opentelemetry" encountered an AsyncIterator which is not supported yet, so tracing data is not available for the operation.'
            );
            return;
          }

          if (result.data && options.result) {
            executionSpan.setAttribute(
              AttributeName.EXECUTION_RESULT,
              JSON.stringify(result)
            );
          }

          if (result.errors && result.errors.length > 0) {
            executionSpan.recordException({
              name: AttributeName.EXECUTION_ERROR,
              message: JSON.stringify(result.errors),
            });
          }

          executionSpan.end();
        },
      };

      if (options.resolvers) {
        extendContext({
          [tracingSpanSymbol]: executionSpan,
        });
      }

      return resultCbs;
    },
  };
};
