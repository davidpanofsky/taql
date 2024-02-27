import {
  DefaultRecord,
  Extensions,
  ExtensionsReducer,
  defaultExtensionsReducer,
} from '@taql/yogaUtils';
import { logger, preregisteredQueryExtensionKey  } from '@taql/config';
import { ExecutionRequest } from '@graphql-tools/utils';
import { TaqlState } from '@taql/context';
import { inspect } from 'util';


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
  'x-servicing-preregistered-query-ids';
const operationNamesServicedHeader = 'x-servicing-operation-names';

export const upstreamHeadersFromContext = <
  Args extends DefaultRecord = DefaultRecord,
  Root = DefaultRecord,
>(
  request:
    | ExecutionRequest<Args, TaqlState, Root, Extensions>
    | null
    | undefined
): Record<string, string> => {
  if (!request?.context?.isDummyRequest) {
    logger.debug(`upstreamHeadersFromContext - request : ${inspect(request)}`);
    logger.debug(
      `upstreamHeadersFromContext - request.context : ${inspect(request?.context)}`
    );
  }
  const result: Record<string, string> = {};

  const preregisteredQueryId = request && getPreregisteredQueryId(request);

  if (preregisteredQueryId) {
    result[preregisteredQueriesServicedHeader] = preregisteredQueryId;
  }

  const operationName = request?.context?.params?.operationName;
  if (operationName) {
    result[operationNamesServicedHeader] = operationName;
  }
  if (!request?.context?.isDummyRequest) {
    logger.debug(`upstreamHeadersFromContext - result: ${inspect(result)}`);
  }
  return result;
};

export const extensionsFromContext = (
  context: TaqlState | undefined
): Extensions => {
  if (context && !context.isDummyRequest) {
    logger.debug(
      `extensionsFromContext - context.params: ${inspect(context.params)}`
    );
  }

  return {
    servicing: {
      preregisteredQueryIds: [
        context?.params?.extensions?.[preregisteredQueryExtensionKey] ?? 'N/A',
      ],
      operationNames: [context?.params?.operationName ?? 'unknown'],
    },
  };
};

export const mergeUpstreamHeaders = (
  requests: ReadonlyArray<ExecutionRequest>
): Record<string, string> =>
  requests.map(upstreamHeadersFromContext).reduce((acc, current) => {
    Object.entries(current).forEach((entry) => {
      acc[entry[0]] = acc[entry[0]]
        ? [acc[entry[0]], entry[1]].join(',')
        : entry[1];
    });
    return acc;
  }, {});
