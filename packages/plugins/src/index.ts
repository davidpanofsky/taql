import type { Middleware } from 'koa';
import type { Plugin } from '@envelop/core';

type MaybeList<T> = ReadonlyArray<T> | T;

type MiddlewarePlugin = {
  koa: MaybeList<Middleware>;
};

type EnvelopPlugin = {
  envelop: MaybeList<Plugin | (() => Plugin)>;
};

export type TaqlPlugin =
  | MiddlewarePlugin
  | EnvelopPlugin
  | (MiddlewarePlugin & EnvelopPlugin);

export class TaqlPlugins {
  readonly koa: () => ReadonlyArray<Middleware>;
  readonly envelop: () => (Plugin | (() => Plugin))[];
  constructor(...plugins: TaqlPlugin[]) {
    this.koa = () => plugins.map((p) => ('koa' in p ? p.koa : [])).flat();
    this.envelop = () =>
      plugins.map((p) => ('envelop' in p ? p.envelop : [])).flat();
  }
}
