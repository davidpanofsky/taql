import type { Headers as FetchHeaders } from 'node-fetch';
import type { IncomingHttpHeaders } from 'http';

export type TaqlHeaders<T extends HeaderKey = HeaderKey> = Partial<
  Record<T, string[]>
>;
export type GenericHeaders =
  | FetchHeaders
  | Headers
  | IncomingHttpHeaders
  | TaqlHeaders;

type HeaderKey = string | number | symbol;
export type TaqlHeaderPair<T extends HeaderKey> = [key: T, val: string];
type RawHeaderPair = readonly [
  key: string | undefined,
  val: string | undefined
];
type HeaderFilter<T extends HeaderKey> = (
  pair: RawHeaderPair | TaqlHeaderPair<T>
) => pair is TaqlHeaderPair<T>;

const merge = <T extends HeaderKey = HeaderKey>(
  existing: TaqlHeaders<T>,
  pair: TaqlHeaderPair<T>
) => {
  const list = (existing[pair[0]] = existing[pair[0]] ?? []);
  list.push(pair[1]);
  return existing;
};

export const copyHeaders = <T extends HeaderKey>(
  headers: GenericHeaders | undefined,
  filter: HeaderFilter<T>
): TaqlHeaders<T> => {
  const copy: TaqlHeaders<T> = {};
  if (headers != undefined) {
    if ('forEach' in headers && typeof headers.forEach === 'function') {
      headers.forEach((val, key) => {
        const pair = [key, val] as const;
        if (filter(pair)) {
          merge(copy, pair);
        }
      });
    } else {
      // We have IncomingHttpHeaders
      for (const key in headers) {
        [(<IncomingHttpHeaders>headers)[key]].flat().forEach((val) => {
          const pair = [key, val] as const;
          if (filter(pair)) {
            merge(copy, pair);
          }
        });
      }
    }
  }
  return copy;
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
  headers: GenericHeaders | TaqlHeaders,
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
