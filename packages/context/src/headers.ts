import type { Middleware, ParameterizedContext } from 'koa';
import { Headers as FetchHeaders } from 'node-fetch';
import type { IncomingHttpHeaders } from 'http';
import { KoaState } from './index';

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

type HeaderPredicate = (key: string, val: string | undefined) => val is string;

function forwardable(key: string, val: string | undefined): val is string {
  return ForwardHeader[<ForwardHeaderName>key] != undefined && val != undefined;
}

function exists(key: string, val: string | undefined): val is string {
  return val != undefined;
}

export const copyHeaders = (
  headers: IncomingHttpHeaders | Headers | FetchHeaders | undefined,
  filterPredicate: HeaderPredicate = exists
): FetchHeaders => {
  const copy = new FetchHeaders();
  if (headers == undefined) {
    return copy;
  }
  if (typeof headers.forEach === 'function') {
    // We have FetchHeaders or Headers
    headers.forEach((val, key) => {
      if (filterPredicate(key, val)) {
        copy.append(key, val);
      }
    });
  } else {
    // We have IncomingHttpHeaders
    for (const key in headers) {
      [(<IncomingHttpHeaders>headers)[key]].flat().forEach((val) => {
        if (filterPredicate(key, val)) {
          copy.append(key, val);
        }
      });
    }
  }
  return copy;
};

const deriveHeaders = (
  context: ParameterizedContext<KoaState>
): FetchHeaders => {
  const headers = copyHeaders(context.headers, forwardable);

  return headers;
};

/*
 * Retrieves a header value or returns the default of type T
 * @param headers one of several header types with unique ways of access
 * @param key the header to retrieve
 * @param defaultV the default value to return
 *
 * @return the header value, or the provided default
 */
const getHeaderOrDefault = <T>(
  headers: IncomingHttpHeaders | Headers | FetchHeaders | undefined,
  key: string,
  defaultV: T
): string | T => {
  if (headers == undefined) {
    return defaultV;
  }
  let val: string | null | undefined = null;
  if (typeof headers.get === 'function') {
    val = headers.get(key);
  } else {
    // IncomingHttpHeaders
    if ((key as keyof IncomingHttpHeaders) in <IncomingHttpHeaders>headers) {
      val = [(<IncomingHttpHeaders>headers)[key as keyof IncomingHttpHeaders]]
        .flat()
        .find((i) => i);
    }
  }
  return val || defaultV;
};

/**
 * pull the first client from a value of the 'x-forwarded-for' header
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-For
 */
const clientFromXff = (xff: string | undefined): string | undefined => {
  if (!xff) {
    return xff;
  }
  const client = xff.split(',').shift();
  return client && client.trim();
};

/**
 * build a "LegacyContext" i.e a RequestContext in the terms of legacy "stitched" graphql's api using http headers
 */
const legacyContextFromHeaders = (
  headers: IncomingHttpHeaders | Headers | FetchHeaders | undefined
): LegacyContext => ({
  locale: getHeaderOrDefault(headers, 'x-tripadvisor-locale', 'en-US'),
  debugToolEnabled:
    getHeaderOrDefault(headers, 'x-tripadvisor-graphql-debug', 'false') ===
    'true',
  uniqueId: getHeaderOrDefault(headers, 'x-request-id', undefined),
  userClientIP: clientFromXff(
    getHeaderOrDefault(headers, 'x-forwarded-for', undefined)
  ),
});

/*
 * See:
 * https://grok.dev.tripadvisor.com/xref/dplat__graphql/src/main/resources/exports/com/tripadvisor/service/graphql/graphql.swagger?r=279bef78#188
 */
export type LegacyContext = {
  readonly locale: string;
  readonly debugToolEnabled: boolean;
  readonly uniqueId: string | undefined;
  readonly userClientIP: string | undefined;
};

export type HeadersState = {
  readonly forwardHeaders: FetchHeaders;
  readonly legacyContext: LegacyContext;
};

export const headerMiddleware: Middleware<KoaState> = async (ctx, next) => {
  ctx.state = {
    ...ctx.state,
    forwardHeaders: deriveHeaders(ctx),
    legacyContext: legacyContextFromHeaders(ctx.headers),
  };
  await next();
};
