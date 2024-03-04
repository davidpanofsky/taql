import { ExecutionRequest } from '@graphql-tools/utils';

export const deadlineSymbol = Symbol('deadline');
export type Extensions = Record<string, unknown> &
  Partial<Record<symbol, number>>;

export type ExtensionsReducer<Request = ExecutionRequest> = (
  extensions: Extensions,
  next: Request
) => Extensions;

export type DefaultRecord = Record<string, unknown>;

export const defaultExtensionsReducer: ExtensionsReducer = (extensions, next) =>
  Object.assign(extensions, next.extensions);
