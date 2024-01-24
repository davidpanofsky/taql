import { ExecutionRequest } from '@graphql-tools/utils';
import { TaqlState } from '@taql/context';

const deadlineSymbol = Symbol('deadline');
//const deadlineSymbol = 'deadline';

type Extensions = Record<string, unknown> &
  Partial<Record<typeof deadlineSymbol, number>>;

type ExtensionsReducer<Request = ExecutionRequest> = (
  extensions: Extensions,
  next: Request
) => Extensions;

type DefaultRecord = Record<string, unknown>;

export const getDeadline = <
  Args extends DefaultRecord = DefaultRecord,
  Root = DefaultRecord,
>(
  request: ExecutionRequest<Args, TaqlState, Root, Extensions>
): number | undefined =>
  // Typically, the deadline will be on the context (only), but that can
  // be overridden by a setting on the request extensions. We only support
  // this because when using graphql-tools/utils to merge queries, we can't
  // control the merged context but _can_ control the merged extensions.
  request.extensions?.[deadlineSymbol] ??
  request.context?.state?.taql?.deadline;
const reduceDeadlines = (acc?: number, next?: number): number | undefined =>
  // In pairing any two deadlines, use the most restrictive. If in practice this
  // means sometimes calls upstream fail due to timeouts (when, unbatched, each
  // request would have succeeded), that is a configuration problem, not a taql
  // problem. Affected subgraphs should opt out of batching or use a shorter,
  // more conservative window over which to batch, such that the last queries in
  // a batch will have arrived shortly after the first queries in the batch, so
  // the batch will kick off sooner and the first query will not have wasted much
  // of its limited timeout waiting for the batch to fill.
  acc != undefined && next != undefined ? Math.min(acc, next) : acc || next;

const defaultExtensionsReducer: ExtensionsReducer = (extensions, next) =>
  Object.assign(extensions, next.extensions);

/**
 * Modify an existing request extension reducer to preserve the lowest deadline
 * among the request extensions, regardless the reducer's other behavior.
 *
 * This is necessary to support the single query batching style, which
 * delegates to a request merging function from graphql-tools that does not
 * give us control over the merged request context, but does give us control
 * over extensions. By dumping the deadline to extensions, we leave it
 * somewhere `getDeadline` can find it.
 */
export const wrapReducer =
  <Args extends DefaultRecord = DefaultRecord, Root = DefaultRecord>(
    reducer: ExtensionsReducer = defaultExtensionsReducer
  ): ExtensionsReducer<ExecutionRequest<Args, TaqlState, Root, Extensions>> =>
  (
    extensions: Extensions,
    nextRequest: ExecutionRequest<Args, TaqlState, Root, Extensions>
  ): Extensions => {
    const cur = extensions[deadlineSymbol];
    const next = getDeadline(nextRequest);
    const result = reducer(extensions, nextRequest);
    result[deadlineSymbol] = reduceDeadlines(cur, next);
    return result;
  };

export const pickDeadline = (
  requests: ReadonlyArray<ExecutionRequest>
): number | undefined => requests.map(getDeadline).reduce(reduceDeadlines);
