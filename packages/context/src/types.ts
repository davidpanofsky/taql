import type { Middleware, ParameterizedContext } from 'koa';
import type { Plugin as Yoga } from 'graphql-yoga';

/*
 * See:
 * https://grok.dev.tripadvisor.com/xref/dplat__graphql/src/main/resources/exports/com/tripadvisor/service/graphql/graphql.swagger?r=279bef78#188
 */
export type LegacyContext = Readonly<{
  locale: string;
  debugToolEnabled: boolean;
  SVCO: string | undefined;
  uniqueId: string | undefined;
  userClientIP: string | undefined;
}>;

export type TaqlContext = Readonly<{
  forwardHeaders: ForwardableHeaders;
  legacyContext: LegacyContext;
}>;

// Note: we never want to forward x-tripadvisor-locale, x-tripadvisor-currency,
// or the like. If the response depends on locale, it must be included in the
// query parameters, end of story.

export enum ForwardHeader {
  'x-guid',
  'x-request-id',
  'x-unique-id',
  'x-ta-unique-dec',
  'x-ua',
  'x-service-overrides',
  'x-txip',
  'authorization',

  // testing & debug headers
  'lt',
  'x-loadtest',
  'x-swedwig-feed-viewer',
  'x-tripadvisor-graphql-debug',

  // tracing headers
  'x-b3-traceid',
  'x-b3-spanid',
  'x-b3-parentspanid',
  'x-b3-flags',
  'x-b3-sampled',
  'b3',
}
export type ForwardHeaderName = keyof typeof ForwardHeader;
export type ForwardableHeaders = { [K in ForwardHeaderName]?: string[] };

type RawState = Readonly<{ taql: TaqlContext }>;
export type TaqlState = ParameterizedContext<RawState>;

type MaybeSupplier<T> = T | (() => T);

export type TaqlMiddleware = Middleware<RawState>;
export type TaqlYogaPlugin = MaybeSupplier<Yoga<TaqlState>>;
