import type { Plugin as Envelop } from '@envelop/core';
import type { Middleware } from 'koa';
import type { Plugin as Yoga } from 'graphql-yoga';

type MaybeList<T> = ReadonlyArray<T> | T;

type MiddlewarePlugin = {
  koa: MaybeList<Middleware>;
};

type EnvelopPlugin = {
  envelop: MaybeList<Envelop | (() => Envelop)>;
};

type YogaPlugin = {
  yoga: MaybeList<Yoga>;
};

type EitherOrBoth<T1, T2> = T1 | T2 | (T1 & T2);
export type TaqlPlugin = EitherOrBoth<
  EitherOrBoth<MiddlewarePlugin, EnvelopPlugin>,
  YogaPlugin
>;

export class TaqlPlugins {
  readonly koa: () => ReadonlyArray<Middleware>;
  readonly envelop: () => (Envelop | (() => Envelop))[];
  readonly yoga: () => ReadonlyArray<Yoga>;
  constructor(...plugins: TaqlPlugin[]) {
    this.koa = () => plugins.map((p) => ('koa' in p ? p.koa : [])).flat();
    this.envelop = () =>
      plugins.map((p) => ('envelop' in p ? p.envelop : [])).flat();
    this.yoga = () => plugins.map((p) => ('yoga' in p ? p.yoga : [])).flat();
  }
}
