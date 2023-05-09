import { Plugin, handleStreamOrSingleExecutionResult } from '@envelop/core';
import { hostname } from 'os';

const serverHost = hostname();

/**
 * Envelop plugin which adds server host extension to the response 
 */
const serverHostExtension: Plugin = {
  onExecute({ args }) {
    return {
      onExecuteDone(payload) {
        return handleStreamOrSingleExecutionResult(
          payload,
          ({ result, setResult }) => {
            setResult({
              ...result,
              extensions: {
                ...(result.extensions || {}),
                serverHost,
              },
            });
          }
        );
      },
    };
  },
};

export const plugins: (Plugin | (() => Plugin))[] = [
  serverHostExtension,
];
