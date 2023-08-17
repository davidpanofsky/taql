import { logger } from './index';
import { readFileSync } from 'fs';

export type Resolver<V = unknown> = (val: string | undefined) => V;

type Named = { property: string | string[] };
type Resolving<V = unknown> = { resolver: Resolver<V> };
type Defaulting<V = unknown> = { defaultTo: Exclude<V, undefined> };

type SimpleEnvVal = string | undefined | Named | (Named & Defaulting<string>);
type EnvVal =
  | SimpleEnvVal
  | (Named & (Resolving | Defaulting | (Resolving & Defaulting)));

type Resolved<T extends EnvVal> = T extends Defaulting<infer D>
  ? T extends Resolving<infer V>
    ? // If there is a default and aresolver, the result will be resolver type
      // unless it resolves to undefined; then it will be the default type.
      D | Exclude<V, undefined>
    : // If no resolver, when a value is defined it will be a string
      D | string
  : T extends Resolving<infer V>
  ? // If there is a resolver and no default, the result type is whatever the env val resolves to.
    V
  : // If there is no resolver or default, the result is string | undefined
    string | undefined;

function resolveSingle<T extends EnvVal>(decl: T): Resolved<T> {
  if (typeof decl === 'object') {
    let resolved: Resolved<T> | undefined = [decl.property]
      .flat()
      .map((prop) => ({ prop, rawVal: process.env[prop] }))
      .map(({ prop, rawVal }) => {
        try {
          return <Resolved<T> | undefined>(
            ('resolver' in decl ? decl.resolver(rawVal) : rawVal)
          );
        } catch (error: unknown) {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore error causes _are_ supported by this minor version of node 16, but ts only cares about the major.
          throw Error(`error resolving property ${prop}`, { cause: error });
        }
      })
      .find((x) => x != undefined);

    if ('defaultTo' in decl && resolved == undefined) {
      // Cannot log while still setting up logger.
      logger &&
        logger.debug(
          `Using default value "${decl.defaultTo}" for environment variable "${decl.property}"`
        );
      resolved = <Resolved<T>>decl.defaultTo;
    }

    return <Resolved<T>>resolved;
  } else {
    return <Resolved<T>>process.env[<string>decl];
  }
}

type ResolvedConfig<T> = {
  [V in keyof T]: T[V] extends string
    ? string | undefined
    : T[V] extends EnvVal
    ? Resolved<T[V]>
    : never;
};

export const resolve = <T extends { [property: string]: EnvVal }>(
  conf: T
): Readonly<ResolvedConfig<T>> =>
  <ResolvedConfig<T>>(
    Object.fromEntries(
      Object.entries(conf).map(([k, v]) => [k, resolveSingle(<EnvVal>v)])
    )
  );

const fileContents = (file?: string | undefined): string | undefined => {
  if (file == undefined) {
    return undefined;
  }
  try {
    return readFileSync(file, 'utf-8');
  } catch (err: unknown) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore error causes _are_ supported by this minor version of node 16, but ts only cares about the major.
    throw new Error(`Cannot read file ${file}`, { cause: err });
  }
};

const nonNegativeInteger = (raw: string | undefined): number | undefined => {
  if (raw == undefined) {
    return undefined;
  }
  const number = Number(raw);
  if (Number.isInteger(number) && number >= 0) {
    return number;
  }
  throw new Error(`"${raw}" is not a non-negative integer`);
};

const booleanFromString = (value: string | undefined): boolean | undefined =>
  value == undefined ? undefined : value.toLowerCase() === 'true';

const urlFromString = (value?: string): undefined | URL =>
  value == undefined ? undefined : new URL(value);

const oidcKindFromString = (
  value: string | undefined
): 'aws' | 'oidc' | undefined =>
  value == 'aws' ? 'aws' : value == 'oidc' ? 'oidc' : undefined;

const options = <T extends string | undefined>(...options: T[]) => {
  const valid: Set<T> = new Set(options);
  return (value?: string): T | undefined => {
    if (valid.has(<T>value)) {
      return <T>value;
    }
    logger.warn(`${value} is not one of ${options}`);
    return undefined;
  };
};

export const resolvers = {
  fileContents,
  nonNegativeInteger,
  booleanFromString,
  urlFromString,
  oidcKindFromString,
  options,
};
