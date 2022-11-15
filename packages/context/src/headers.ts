import { Headers as FetchHeaders } from 'node-fetch';
import { Plugin } from '@envelop/core';
import { YogaInitialContext } from 'graphql-yoga';

export const copyHeaders = (
  headers: Headers | FetchHeaders | undefined,
  filterPredicate?: (val: string, key: string) => boolean
): FetchHeaders => {
  const copy = new FetchHeaders();
  headers?.forEach((val, key) => {
    if (filterPredicate == undefined || filterPredicate(val, key)) {
      copy.append(key, val);
    }
  });
  return copy;
};

// extremely lazy header forwarding. all our custom
// headers start with x-, and I guess we should do cookies too.
// Cookie forwarding ought to be a subject of debate, though.
// Cut everything else for now.
// TODO develop allow-list list of headers to forward
const deriveHeaders = (
  context: YogaInitialContext & HeadersContext
): FetchHeaders =>
  copyHeaders(
    context.request.headers,
    (val, key) => key.startsWith('x-') || key === 'cookie'
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
