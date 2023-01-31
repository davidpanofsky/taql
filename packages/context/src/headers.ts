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
  'x-tripadvisor-locale',
  'x-txip',
  'authorization',

  // testing & debug headers
  'lt',
  'x-loadtest',
  'x-swedwig-feed-viewer',

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

const legacyContextFromHeaders = (
  headers: IncomingHttpHeaders | Headers | FetchHeaders | undefined
): LegacyContext => ({
  locale: getHeaderOrDefault(headers, 'x-tripadvisor-locale', 'en-US'),
  debugToolEnabled:
    getHeaderOrDefault(headers, 'x-tripadvisor-graphql-debug', 'false') ===
    'true',
  uniqueId: getHeaderOrDefault(headers, 'x-request-id', null),
  userClientIP: getHeaderOrDefault(headers, 'x-forwarded-for', null),
});

export type LegacyContext = {
  readonly locale: string;
  readonly debugToolEnabled: boolean;
  readonly uniqueId: string | null;
  readonly userClientIP: string | null;
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
