import type { Plugin } from 'graphql-yoga';
import { getHeaderOrDefault } from '@taql/headers';
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
            const headers = request.headers;
            const uniqueId = getHeaderOrDefault(
              headers,
              'x-unique-id',
              undefined
            );
            const requestId = getHeaderOrDefault(
              headers,
              'x-request-id',
              undefined
            );
            const client =
              getHeaderOrDefault(headers, 'x-app-name', undefined) ||
              getHeaderOrDefault(headers, 'user-agent', 'unknown');
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
