import {
  DefaultRecord,
  Extensions,
  ExtensionsReducer,
  defaultExtensionsReducer,
} from '@taql/yogaUtils';
import { ExecutionRequest } from '@graphql-tools/utils';
import { TaqlState } from '@taql/context';
import { preregisteredQueryExtensionKey } from '@taql/config';

const getPreregisteredQueryId = <
  Args extends DefaultRecord = DefaultRecord,
  Root = DefaultRecord,
>(
  request: ExecutionRequest<Args, TaqlState, Root, Extensions>
): string | undefined =>
  request.extensions?.[preregisteredQueryExtensionKey] ??
  request.context?.params?.extensions?.[preregisteredQueryExtensionKey];

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

    const nextPreregisteredQueryId = getPreregisteredQueryId(nextRequest);
    nextPreregisteredQueryId &&
      acc[servicingPreregisteredQueryIds]?.push(nextPreregisteredQueryId);

    const nextOperationName = nextRequest.context?.params?.operationName;
    nextOperationName && acc[servicingOperationNames]?.push(nextOperationName);

    const result = reducer(extensions, nextRequest);
    result[servicingExtension] = acc;
    return result;
  };

const preregisteredQueriesServicedHeader =
  'x-taql-servicing-query-ids';
const operationNamesServicedHeader = 'x-taql-servicing-operation-names';

export const upstreamHeadersFromContext = <
  Args extends DefaultRecord = DefaultRecord,
  Root = DefaultRecord,
>(
  request:
    | ExecutionRequest<Args, TaqlState, Root, Extensions>
    | null
    | undefined
): Record<string, string> => {
  const result: Record<string, string> = {};

  const preregisteredQueryId = request && getPreregisteredQueryId(request);

  if (preregisteredQueryId) {
    result[preregisteredQueriesServicedHeader] = preregisteredQueryId;
  }

  const operationName = request?.context?.params?.operationName;
  if (operationName) {
    result[operationNamesServicedHeader] = operationName;
  }
  return result;
};

export const extensionsFromContext = (
  context: TaqlState | undefined
): Extensions => ({
  servicing: {
    preregisteredQueryIds: [
      context?.params?.extensions?.[preregisteredQueryExtensionKey] ?? 'N/A',
    ],
    operationNames: [context?.params?.operationName ?? 'unknown'],
  },
});

export const mergeUpstreamHeaders = (
  requests: ReadonlyArray<ExecutionRequest>
): Record<string, string> => {
  const deduplicated: Record<string, Set<string>> = requests
    .map(upstreamHeadersFromContext)
    .reduce(
      (acc, current) => {
        Object.entries(current).forEach((entry) => {
          if (!(entry[0] in acc)) {
            acc[entry[0]] = new Set<string>();
          }
          acc[entry[0]].add(entry[1]);
        });
        return acc;
      },
      <Record<string, Set<string>>>{}
    );

  return Object.entries(deduplicated).reduce(
    (acc, entry) => {
      acc[entry[0]] = Array.from(entry[1]).join(',');
      return acc;
    },
    <Record<string, string>>{}
  );
};
