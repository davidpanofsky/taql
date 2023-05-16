import { LegacyContext, TaqlContext, TaqlMiddleware } from './types';
import { forwardableHeaders, getHeaderOrDefault } from './headers';
import { EXECUTION_TIMEOUT_PARAMS } from '@taql/config';
import { Headers as FetchHeaders } from 'node-fetch';
import type { IncomingHttpHeaders } from 'http';

export {
  TaqlMiddleware,
  TaqlState,
  LegacyContext,
  TaqlContext,
  ForwardHeader,
  ForwardHeaderName,
  ForwardableHeaders,
  TaqlYogaPlugin,
} from './types';

type InputHeaders = FetchHeaders | Headers | IncomingHttpHeaders;

/**
 * pull the first client from a value of the 'x-forwarded-for' header
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-For
 */
const clientFromXff = (xff: string | undefined): string | undefined =>
  xff?.split(',').shift()?.trim();

/**
 * build a "LegacyContext" i.e a RequestContext in the terms of legacy "stitched" graphql's api using http headers
 */
const legacyContextFromHeaders = (headers: InputHeaders): LegacyContext => ({
  locale: getHeaderOrDefault(headers, 'x-tripadvisor-locale', 'en-US'),
  debugToolEnabled:
    getHeaderOrDefault(headers, 'x-tripadvisor-graphql-debug', 'false') ===
    'true',
  uniqueId: getHeaderOrDefault(headers, 'x-request-id', undefined),
  userClientIP: clientFromXff(
    getHeaderOrDefault(headers, 'x-forwarded-for', undefined)
  ),
  SVCO: getHeaderOrDefault(headers, 'x-service-overrides', undefined),
});

const deadline = (headers: InputHeaders): number =>
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

const buildContext = (headers: InputHeaders): TaqlContext => ({
  forwardHeaders: forwardableHeaders(headers),
  deadline: deadline(headers),
  legacyContext: legacyContextFromHeaders(headers),
});

export const useTaqlContext: TaqlMiddleware = async (ctx, next) => {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore assign state anyhow here.
  ctx.state.taql = buildContext(ctx.headers);
  await next();
};
