import { DelegationContext, Transform } from '@graphql-tools/delegate';
import { Plugin, handleStreamOrSingleExecutionResult } from '@envelop/core';
import { ExecutionResult } from '@graphql-tools/utils';
import { SERVER_PARAMS } from '@taql/config';

const SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL = Symbol.for(
  'subschemaResponseExtensions'
);

type SubschemaExtensionsContext = {
  [SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL]?: { [key: string]: unknown };
};

/**
 * Envelop plugin which adds server host extension to the response
 */
export const serverHostExtensionPlugin: Plugin = {
  onExecute() {
    return {
      onExecuteDone(payload) {
        return handleStreamOrSingleExecutionResult(
          payload,
          ({ result, setResult }) => {
            setResult({
              ...result,
              extensions: {
                ...(result.extensions || {}),
                serverHost: SERVER_PARAMS.hostname,
              },
            });
          }
        );
      },
    };
  },
};

export class ForwardSubschemaExtensions<T = Record<string, unknown>>
  implements Transform<T, SubschemaExtensionsContext>
{
  constructor(
    private subschemaKey: string,
    private transformExtensions?: (ext: T) => Record<string, unknown>
  ) {}

  public transformResult(
    result: ExecutionResult,
    delegationCtx: DelegationContext<SubschemaExtensionsContext>
  ): ExecutionResult {
    if (result.extensions && delegationCtx.context) {
      const forwardedExtensions = this.transformExtensions
        ? this.transformExtensions(result.extensions)
        : result.extensions;
      delegationCtx.context[SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL] = {
        ...delegationCtx.context[SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL],
        [this.subschemaKey]: {
          ...forwardedExtensions,
        },
      };
    }
    return result;
  }
}

/**
 * Envelop plugin which forwards subschema extensions
 */
export const subschemaExtensionsPlugin: Plugin<SubschemaExtensionsContext> = {
  onExecute() {
    return {
      onExecuteDone(payload) {
        const extensions =
          payload.args.contextValue[SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL];
        if (!extensions) {
          return;
        }
        return handleStreamOrSingleExecutionResult(
          payload,
          ({ result, setResult }) => {
            setResult({
              ...result,
              extensions: {
                ...(result.extensions || {}),
                ...extensions,
              },
            });
          }
        );
      },
    };
  },
};
