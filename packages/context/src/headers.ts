import { Headers as FetchHeaders } from 'node-fetch';
import type { IncomingHttpHeaders } from 'http';
import { copyHeaders } from '@taql/headers';

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
  'x-trip-iat',

  // testing & debug headers
  'lt',
  'x-test-fields',
  'x-loadtest',
  'x-swedwig-feed-viewer',
  'x-tripadvisor-graphql-debug',
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

export const forwardableHeaders = (
  headers: FetchHeaders | Headers | IncomingHttpHeaders
): ForwardableHeaders => copyHeaders(headers, forwardable);
