import type { Plugin } from 'graphql-yoga';
import { getOperationAST } from 'graphql';
import { handleStreamOrSingleExecutionResult } from '@envelop/core';
import { logger } from '@taql/config';

export const useErrorLogging: Plugin = {
  onExecute() {
    return {
      onExecuteDone(payload) {
        return handleStreamOrSingleExecutionResult(payload, ({ result }) => {
          if (result.errors) {
            const uniqueId =
              payload.args.contextValue.request.headers.get('x-unique-id');
            const requestId =
              payload.args.contextValue.request.headers.get('x-request-id');
            const operationAST = getOperationAST(
              payload.args.document,
              payload.args.operationName
            );
            const operationName = operationAST?.name?.value;
            result.errors.forEach((err) => {
              logger.error(err?.message, {
                uniqueId,
                requestId,
                operationName,
              });
            });
          }
        });
      },
    };
  },
};
