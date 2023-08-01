import { BiWeakMap, logPrewarm } from './util';
import {
  CompiledQuery,
  CompilerOptions,
  compileQuery,
  isCompiledQuery,
} from 'graphql-jit';
import {
  DocumentNode,
  ExecutionArgs,
  ExecutionResult,
  GraphQLSchema,
  getOperationAST,
} from 'graphql';
import {
  OnExecuteEventPayload,
  OnSubscribeEventPayload,
  makeExecute,
  makeSubscribe,
} from '@envelop/core';
import { YogaInitialContext, Plugin as YogaPlugin } from 'graphql-yoga';
import { logger, WORKER as worker } from '@taql/config';
import promClient from 'prom-client';

const GRAPHQL_JIT_CACHE_COUNTER = new promClient.Counter({
  name: 'graphql_jit_cache',
  help: 'Tracks access to graphql jit cache(s)',
  labelNames: ['operationName', 'event', 'worker'],
});
const GRAPHQL_JIT_CACHE_TIMING = new promClient.Counter({
  name: 'graphql_jit_cache_compile_time',
  help: 'Time spent compiling graphql queries in milliseconds',
  labelNames: ['operationName', 'worker'],
});

const COMPILING = Symbol('compiling');
export class JitCache {
  private options: Partial<CompilerOptions>;
  private compiledQueryCache = new BiWeakMap<
    GraphQLSchema,
    DocumentNode,
    CompiledQuery | ExecutionResult | typeof COMPILING
  >();
  constructor(options: Partial<CompilerOptions>) {
    this.options = options;
  }

  // A method to compile queries and add the results to the cache
  private compile(args: ExecutionArgs): void {
    const start = Date.now();
    const operationName = args.operationName ?? 'unknown';
    const compileStart = Date.now();
    const query = compileQuery(
      args.schema,
      args.document,
      args.operationName ?? undefined,
      this.options
    );
    logger.debug(`compiled ${operationName} in ${Date.now() - start}ms`);
    GRAPHQL_JIT_CACHE_TIMING.inc(
      { operationName, worker },
      Date.now() - compileStart
    );
    GRAPHQL_JIT_CACHE_COUNTER.inc({ operationName, worker, event: 'compiled' });
    this.compiledQueryCache.set(args.schema, args.document, query);
  }

  // Compile and cache in the background.
  private lazyCompile(args: ExecutionArgs): void {
    setTimeout(() => this.compile(args));
  }

  // Prewarm the cache with the provided documents in the context of the
  // provided schema.
  prewarm(schema: GraphQLSchema, documents: DocumentNode[]): Promise<void> {
    let compileCount = 0;
    return logPrewarm('jit', documents, (document) => {
      this.compile({
        document,
        schema,
        operationName: getOperationAST(document)?.name?.value,
      });
      ++compileCount % 100 == 0 &&
        logger.info(`compiled ${compileCount} queries`);
    });
  }

  readonly plugin: YogaPlugin = {
    onExecute: (args: OnExecuteEventPayload<YogaInitialContext>) => {
      const cached = this.compiledQueryCache.get(
        args.args.schema,
        args.args.document
      );
      const operationName = args.args.operationName ?? 'unknown';
      if (cached) {
        if (cached === COMPILING) {
          GRAPHQL_JIT_CACHE_COUNTER.inc({
            operationName,
            event: 'still_compiling',
            worker,
          });
        } else {
          GRAPHQL_JIT_CACHE_COUNTER.inc({
            operationName,
            event: 'hit',
            worker,
          });

          args.setExecuteFn(
            makeExecute((args) =>
              isCompiledQuery(cached)
                ? cached.query(
                    args.rootValue,
                    args.contextValue,
                    args.variableValues
                  )
                : () => cached
            )
          );
        }
        return;
      } else {
        this.compiledQueryCache.set(
          args.args.schema,
          args.args.document,
          COMPILING
        );

        // wait for current execution to end, then kick off background compilation.
        return {
          onExecuteDone: () => this.lazyCompile(args.args),
        };
      }
    },

    onSubscribe: (args: OnSubscribeEventPayload<YogaInitialContext>) => {
      const cached = this.compiledQueryCache.get(
        args.args.schema,
        args.args.document
      );
      const operationName = args.args.operationName ?? 'unknown';
      if (cached) {
        if (cached === COMPILING) {
          GRAPHQL_JIT_CACHE_COUNTER.inc({
            operationName,
            worker,
            event: 'still_compiling',
          });
        } else {
          GRAPHQL_JIT_CACHE_COUNTER.inc({
            operationName,
            worker,
            event: 'hit',
          });

          args.setSubscribeFn(
            makeSubscribe((args) =>
              isCompiledQuery(cached)
                ? (cached.subscribe ?? cached.query)(
                    args.rootValue,
                    args.contextValue,
                    args.variableValues
                  )
                : () => cached
            )
          );
        }
        return;
      } else {
        this.compiledQueryCache.set(
          args.args.schema,
          args.args.document,
          COMPILING
        );

        // wait for current execution to end, then kick off background compilation.
        return {
          onSubscribeError: () => this.lazyCompile(args.args),
          onSubscribeResult: () => this.lazyCompile(args.args),
        };
      }
    },
  };
}
