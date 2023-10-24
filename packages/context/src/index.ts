import { ForwardableHeaders, forwardableHeaders } from './headers';
import { GenericHeaders, getHeaderOrDefault } from '@taql/headers';
import type { Middleware, ParameterizedContext } from 'koa';
import { EXECUTION_TIMEOUT_PARAMS } from '@taql/config';
import type { Plugin as Yoga } from 'graphql-yoga';

export {
  ForwardHeader,
  ForwardHeaderName,
  ForwardableHeaders,
} from './headers';

/*
 * See:
 * https://grok.dev.tripadvisor.com/xref/dplat__graphql/src/main/resources/exports/com/tripadvisor/service/graphql/graphql.swagger?r=279bef78#188
 *
 * This is actually sent to legacy graphql on every request and should conform
 * to the RequestContext legacy graphql defines for itself.
 * https://jira.tamg.io/browse/DM-459 identified the locale, debugToolEnabled,
 * uniqueId, and userClientIP fields as the only ones actually consumed by
 * legacy graphql, so they are the only ones we'll send.
 */
export type LegacyContext = Readonly<{
  locale: string;
  debugToolEnabled: boolean;
  uniqueId: string | undefined;
  userClientIP: string | undefined;
}>;

export type TaqlContext = Readonly<{
  forwardHeaders: ForwardableHeaders;
  deadline: number;
  legacyContext: LegacyContext;
  SVCO?: string;
  client: string;
}>;

type RawState = Readonly<{ taql: TaqlContext }>;
export type TaqlState = ParameterizedContext<RawState>;

type MaybeSupplier<T> = T | (() => T);

export type TaqlMiddleware = Middleware<RawState>;
export type TaqlYogaPlugin = MaybeSupplier<Yoga<TaqlState>>;

/**
 * pull the first client from a value of the 'x-forwarded-for' header
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-For
 */
const clientFromXff = (xff: string | undefined): string | undefined =>
  xff?.split(',').shift()?.trim();

/**
 * build a "LegacyContext" i.e a RequestContext in the terms of legacy "stitched" graphql's api using http headers
 */
const legacyContextFromHeaders = (headers: GenericHeaders): LegacyContext => ({
  locale: getHeaderOrDefault(headers, 'x-tripadvisor-locale', 'en-US'),
  debugToolEnabled:
    getHeaderOrDefault(headers, 'x-tripadvisor-graphql-debug', 'false') ===
    'true',
  uniqueId: getHeaderOrDefault(headers, 'x-unique-id', undefined),
  userClientIP: clientFromXff(
    getHeaderOrDefault(headers, 'x-forwarded-for', undefined)
  ),
});

const deadline = (headers: GenericHeaders): number =>
  Date.now() +
  Math.min(
    parseInt(
      getHeaderOrDefault(
        headers,
        'x-timeout',
        `${EXECUTION_TIMEOUT_PARAMS.defaultExecutionTimeoutMillis}`
      )
    ),
    EXECUTION_TIMEOUT_PARAMS.maxExecutionTimeoutMillis
  );

export const timeRemaining = (context: TaqlContext): number =>
  context.deadline - Date.now();

const svco = (headers: GenericHeaders): string | undefined =>
  getHeaderOrDefault(headers, 'x-service-overrides', undefined);

const getClientName = (headers: GenericHeaders): string =>
  getHeaderOrDefault(headers, 'x-app-name', undefined) ||
  getHeaderOrDefault(headers, 'user-agent', 'unknown');

const buildContext = (headers: GenericHeaders): TaqlContext => ({
  forwardHeaders: forwardableHeaders(headers),
  deadline: deadline(headers),
  legacyContext: legacyContextFromHeaders(headers),
  SVCO: svco(headers),
  client: getClientName(headers),
});

export const useTaqlContext: TaqlMiddleware = async (ctx, next) => {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore assign state anyhow here.
  ctx.state.taql = buildContext(ctx.headers);
  await next();
};
