import { Headers as FetchHeaders } from 'node-fetch';
import { Plugin } from '@envelop/core';
import { YogaInitialContext } from 'graphql-yoga';

// Note: we never want to forward x-tripadvisor-locale, x-tripadvisor-currency,
// or the like. If the response depends on locale, it must be included in the
// query parameters, end of story.

export enum ForwardHeader {
  'x-guid',
  'x-request-id',
  'x-unique-id',
  'x-ta-unique-dec',
  'x-ua',
  'user-agent',
  'cookie',
  'x-service-overrides',
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

const FORWARD_HEADERS: ReadonlySet<keyof typeof ForwardHeader> = new Set(
  <(keyof typeof ForwardHeader)[]>Object.keys(ForwardHeader)
);

export const copyHeaders = (
  headers: Headers | FetchHeaders | undefined,
  filterPredicate?: (args: { val: string; key: string }) => boolean
): FetchHeaders => {
  const copy = new FetchHeaders();
  headers?.forEach((val, key) => {
    if (filterPredicate == undefined || filterPredicate({ val, key })) {
      copy.append(key, val);
    }
  });
  return copy;
};

FORWARD_HEADERS;

const deriveHeaders = (
  context: YogaInitialContext & HeadersContext
): FetchHeaders =>
  copyHeaders(context.request.headers, ({ key }) =>
    FORWARD_HEADERS.has(<keyof typeof ForwardHeader>(<unknown>key))
  );

export type HeadersContext = {
  forwardHeaders: FetchHeaders;
};

export const headerPlugin: Plugin<YogaInitialContext & HeadersContext> = {
  onContextBuilding({ context, extendContext }) {
    let forwardHeaders: FetchHeaders | undefined = undefined;
    extendContext({
      get forwardHeaders() {
        if (forwardHeaders == undefined) {
          forwardHeaders = deriveHeaders(context);
        }
        return forwardHeaders;
      },
    });
  },
};
