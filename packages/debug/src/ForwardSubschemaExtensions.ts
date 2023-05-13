import { DelegationContext, Transform } from '@graphql-tools/delegate';
import { ExecutionResult } from '@graphql-tools/utils';

export const SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL = Symbol.for(
  'subschemaResponseExtensions'
);

export type SubschemaExtensionsContext = {
  [SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL]?: { [key: string]: unknown };
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
