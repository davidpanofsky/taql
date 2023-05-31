import { DelegationContext, Transform } from '@graphql-tools/delegate';
import { ExecutionResult } from '@graphql-tools/utils';

export const SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL = Symbol.for(
  'subschemaResponseExtensions'
);

export type SubschemaExtensionsContext = {
  [SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL]: { [key: string]: unknown[] };
};

export class ForwardSubschemaExtensions<T = Record<string, unknown>>
  implements Transform
{
  constructor(
    private subschemaKey: string,
    private transformExtensions?: (ext: T) => Record<string, unknown>
  ) {}

  public transformResult(
    result: ExecutionResult,
    delegationCtx: DelegationContext
  ): ExecutionResult {
    if (result.extensions && delegationCtx.context) {
      const forwardedExtensions = this.transformExtensions
        ? this.transformExtensions(result.extensions)
        : result.extensions;
      if (!(SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL in delegationCtx.context)) {
        // this transform should only be used alongside subschemaExtensionsPlugin
        // if this object is missing, it means the plugin is not enabled
        throw new Error('subschemaExtensionsPlugin is not present');
      }
      const context = delegationCtx.context as SubschemaExtensionsContext;
      const extensionsList =
        context[SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL][this.subschemaKey] || [];
      Object.assign(context[SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL], {
        [this.subschemaKey]: [...extensionsList, forwardedExtensions],
      });
    }
    return result;
  }
}
