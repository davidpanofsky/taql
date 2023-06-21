import type { Plugin } from 'graphql-yoga';
import { handleStreamOrSingleExecutionResult } from '@envelop/core';
import { logger } from '@taql/config';

export const useErrorLogging: Plugin = {
  onExecute() {
    return {
      onExecuteDone(payload) {
        return handleStreamOrSingleExecutionResult(payload, ({ result }) => {
          if (result.errors) {
            logger.error(result.errors);
          }
        });
      },
    };
  },
};
