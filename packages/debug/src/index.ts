import { Plugin, handleStreamOrSingleExecutionResult } from '@envelop/core';
import { SERVER_PARAMS } from '@taql/config';

/**
 * Envelop plugin which adds server host extension to the response
 */
const serverHostExtension: Plugin = {
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

export const plugins: (Plugin | (() => Plugin))[] = [serverHostExtension];
