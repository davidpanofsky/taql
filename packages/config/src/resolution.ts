import { readFileSync } from 'fs';

type Error = { errorMessage: string };

type Resolver<V = unknown> = (val: string | undefined) => V;

type Defaulting<V> = { defaultTo: V };
type Named = { property: string | string[] };
type Resolvable<V> = { resolver: Resolver<V> };

type SimpleEnvVal = string | Named | (Named & Defaulting<string>);

type ExtractedEnvVal<V, K> = Named &
  (Resolvable<V> | (Resolvable<V | undefined> & Defaulting<K>));

type EnvVal<V = unknown> = ExtractedEnvVal<unknown, V> | SimpleEnvVal;

type Resolved<T> = T extends Defaulting<infer V>
  ? V
  : T extends Resolvable<infer V>
  ? Error extends V
    ? Exclude<V | undefined, Error>
    : V
  : T extends SimpleEnvVal
  ? string | undefined
  : never;

function resolveSingle<T extends EnvVal>(decl: T): Resolved<T> {
  if (typeof decl === 'object') {
    let resolved: Resolved<T> | Error | undefined = undefined;
    [decl.property]
      .flat()
      .map((prop) => process.env[prop])
      .forEach((rawVal) => {
        resolved = <Resolved<T> | Error | undefined>(
          ('resolver' in decl ? decl.resolver(rawVal) : rawVal)
        );
        if (
          resolved != undefined &&
          typeof resolved === 'object' &&
          'errorMessage' in resolved
        ) {
          console.error(
            `Unable to process value "${rawVal}" for environment variable "${decl.property}": ${resolved.errorMessage}`
          );
          resolved = undefined;
        }
      });

    if ('defaultTo' in decl && resolved == undefined) {
      console.log(
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

const fileContents = (
  file?: string | undefined
): string | undefined | Error => {
  if (file == undefined) {
    return undefined;
  }
  try {
    return readFileSync(file, 'utf-8');
  } catch (err: unknown) {
    return { errorMessage: `Cannot read file ${file}: ${err}` };
  }
};

const nonNegativeInteger = (raw: string | undefined): number | Error => {
  const number = Number(raw);
  if (Number.isInteger(number) && number >= 0) {
    return number;
  }
  return { errorMessage: `"${raw}" is not a non-negative integer` };
};

const booleanFromString = (value: string | undefined): boolean | undefined =>
  value == undefined ? undefined : value.toLowerCase() === 'true';

export const resolvers = {
  fileContents,
  nonNegativeInteger,
  booleanFromString,
};
