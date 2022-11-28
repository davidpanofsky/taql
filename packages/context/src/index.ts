import { HeadersState, headerMiddleware } from './headers';
import type { Middleware, ParameterizedContext } from 'koa';
import type { Plugin } from '@envelop/core';

export { copyHeaders } from './headers';

export type KoaState = HeadersState;
export type EnvelopContext = Record<string, never>; //for now

export type TaqlContext = ParameterizedContext<KoaState> & EnvelopContext;

/** Envelop plugins required to set up the context. Apply before any other plugins. */
const envelop: (Plugin<TaqlContext> | (() => Plugin<TaqlContext>))[] = [];

/** Koa middlewares used to set up the context. Apply before any other middlewares. */
const middleware: Middleware<KoaState>[] = [headerMiddleware];

export const plugins = {
  envelop,
  koa: middleware,
} as const;
