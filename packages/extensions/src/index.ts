import {
  DefaultRecord,
  Extensions,
  ExtensionsReducer,
  defaultExtensionsReducer,
} from '@taql/yogaUtils';

import { ExecutionRequest } from '@graphql-tools/utils';
import { TaqlState } from '@taql/context';

const servicingExtension = 'servicing';
const servicingPreregisteredQueryIds = 'preregisteredQueries';
const servicingOperationNames = 'operationNames';

export const wrapReducer =
  <Args extends DefaultRecord = DefaultRecord, Root = DefaultRecord>(
    reducer: ExtensionsReducer = defaultExtensionsReducer
  ): ExtensionsReducer<ExecutionRequest<Args, TaqlState, Root, Extensions>> =>
  (
    extensions: Extensions,
    nextRequest: ExecutionRequest<Args, TaqlState, Root, Extensions>
  ): Extensions => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let acc: any = extensions[servicingExtension] ?? {
      [servicingPreregisteredQueryIds]: [],
      [servicingOperationNames]: [],
    };

    // Be completely overly defensive of what's in the `servicing` extension
    if (!(typeof acc === 'object')) {
      acc = {};
    }

    if (!Array.isArray(acc[servicingPreregisteredQueryIds])) {
      acc[servicingPreregisteredQueryIds] = [];
    }

    if (!Array.isArray(acc[servicingOperationNames])) {
      acc[servicingOperationNames] = [];
    }

    const nextPreregisteredQueryId =
      nextRequest.extensions?.['preregisteredQueryId'];
    nextPreregisteredQueryId &&
      acc[servicingPreregisteredQueryIds]?.push(nextPreregisteredQueryId);

    const nextOperationId = nextRequest.context?.params?.operationName;
    nextOperationId && acc[servicingOperationNames]?.push(nextOperationId);

    const result = reducer(extensions, nextRequest);
    result[servicingExtension] = acc;
    return result;
  };

const preregisteredQueriesServicedHeader =
  'x-servicing-preregistered-query-ids';
const operationNamesServicedHeader = 'x-servicing-operation-names';

export const upstreamHeadersFromExtensions = <
  Args extends DefaultRecord = DefaultRecord,
  Root = DefaultRecord,
>(
  request:
    | ExecutionRequest<Args, TaqlState, Root, Extensions>
    | null
    | undefined
): Record<string, string> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const servicing: any = request?.extensions?.[servicingExtension];
  const result: Record<string, string> = {};
  if (!servicing) {
    return result;
  }

  const preregisteredQueries = servicing[servicingPreregisteredQueryIds];
  if (Array.isArray(preregisteredQueries)) {
    result[preregisteredQueriesServicedHeader] = preregisteredQueries.join(',');
  }

  const operationNames = servicing[servicingOperationNames];
  if (Array.isArray(operationNames)) {
    result[operationNamesServicedHeader] = operationNames.join(',');
  }
  return result;
};

export const extensionsFromContext = (
  context: TaqlState | undefined
): Extensions => ({
  servicing: {
    preregisteredQueryIds: [
      context?.params?.extensions?.preregisteredQueryId ?? 'N/A',
    ],
    operationNames: [context?.params?.operationName ?? 'unknown'],
  },
});

export const mergeUpstreamHeaders = (
  requests: ReadonlyArray<ExecutionRequest>
): Record<string, string> =>
  requests.map(upstreamHeadersFromExtensions).reduce((acc, current) => {
    Object.entries(current).forEach((entry) => {
      acc[entry[0]] = [acc[entry[0]] ?? '', entry[1]].join(',');
    });
    return acc;
  }, {});
