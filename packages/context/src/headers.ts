import { Headers as FetchHeaders } from 'node-fetch';
import type { IncomingHttpHeaders } from 'http';

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

type ForwardHeaderPair = [key: ForwardHeaderName, val: string];

function forwardable(
  pair: readonly [key: string | undefined, val: string | undefined]
): pair is ForwardHeaderPair {
  return (
    ForwardHeader[<ForwardHeaderName>pair[0]] != undefined &&
    pair[1] != undefined
  );
}

const merge = (existing: ForwardableHeaders, pair: ForwardHeaderPair) => {
  const list = (existing[pair[0]] = existing[pair[0]] ?? []);
  list.push(pair[1]);
  return existing;
};

export const forwardableHeaders = (
  headers: FetchHeaders | Headers | IncomingHttpHeaders
): ForwardableHeaders => {
  const forward: ForwardableHeaders = {};
  if (headers != undefined) {
    if (typeof headers.forEach === 'function') {
      headers.forEach((val, key) => {
        const pair = [key, val] as const;
        if (forwardable(pair)) {
          merge(forward, pair);
        }
      });
    } else {
      // We have IncomingHttpHeaders
      for (const key in headers) {
        [(<IncomingHttpHeaders>headers)[key]].flat().forEach((val) => {
          const pair = [key, val] as const;
          if (forwardable(pair)) {
            merge(forward, pair);
          }
        });
      }
    }
  }

  return forward;
};

/*
 * Retrieves a header value or returns the default of type T
 * @param headers one of several header types with unique ways of access
 * @param key the header to retrieve
 * @param defaultV the default value to return
 *
 * @return the header value, or the provided default
 */
export const getHeaderOrDefault = <T>(
  headers: IncomingHttpHeaders | Headers | FetchHeaders | undefined,
  key: string,
  defaultV: T
): string | T => {
  if (headers == undefined) {
    return defaultV;
  }
  let val: string | undefined | null;
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
