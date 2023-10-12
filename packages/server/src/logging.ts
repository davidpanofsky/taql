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
            const request = payload.args.contextValue.request;
            const uniqueId = request.headers.get('x-unique-id');
            const requestId = request.headers.get('x-request-id');
            const client =
              request.headers.get('x-app-name') ||
              request.headers.get('user-agent') ||
              'unknown';
            const operationAST = getOperationAST(
              payload.args.document,
              payload.args.operationName
            );
            const operationName = operationAST?.name?.value;
            const operationType = operationAST?.operation;
            result.errors.forEach((err) => {
              logger.warn(err?.message, {
                uniqueId,
                requestId,
                client,
                operationName,
                operationType,
              });
            });
          }
        });
      },
    };
  },
};
