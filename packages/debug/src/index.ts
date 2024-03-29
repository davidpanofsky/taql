import {
  OnExecuteDoneHookResultOnNextHook,
  Plugin,
  handleStreamOrSingleExecutionResult,
} from '@envelop/core';
import {
  SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL,
  SubschemaExtensionsContext,
} from './ForwardSubschemaExtensions';
import { SERVER_PARAMS } from '@taql/config';

export { ForwardSubschemaExtensions } from './ForwardSubschemaExtensions';

const createExtendResultFunction = <ContextType>(
  extensions: Record<string, unknown>
): OnExecuteDoneHookResultOnNextHook<ContextType> =>
  function extendResult({ result, setResult }) {
    setResult({
      ...result,
      extensions: {
        ...(result.extensions || {}),
        ...extensions,
      },
    });
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
          createExtendResultFunction({
            serverHost: SERVER_PARAMS.hostname,
          })
        );
      },
    };
  },
};

/**
 * Envelop plugin which forwards subschema extensions
 */
export const subschemaExtensionsPlugin: Plugin<SubschemaExtensionsContext> = {
  onContextBuilding({ extendContext }) {
    // set forwarded extensions to an empty object so that we don't lose a
    // reference to it once subsequent extendContext calls update the context
    extendContext({ [SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL]: {} });
  },
  onExecute() {
    return {
      onExecuteDone(payload) {
        const extensions =
          payload.args.contextValue[SUBSCHEMA_RESPONSE_EXTENSIONS_SYMBOL];
        if (!extensions || Object.keys(extensions).length === 0) {
          return;
        }
        return handleStreamOrSingleExecutionResult(
          payload,
          createExtendResultFunction(extensions)
        );
      },
    };
  },
};
