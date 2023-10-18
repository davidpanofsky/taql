import { DocumentNode, GraphQLSchema } from 'graphql';
import { CompilerOptions } from 'graphql-jit';
import { DocumentCache } from './documents';
import { JitCache } from './jit';
import { ValidationCache } from './validation';
import { Plugin as YogaPlugin } from 'graphql-yoga';
import { addClusterReadinessStage } from '@taql/readiness';
import { logPrewarm } from './util';
import { prewarmExecutionCache } from './execution';

const unifiedCachesPrewarmed = addClusterReadinessStage(
  'unifiedCachesPrewarmed'
);

export async function useUnifiedCaching(options: {
  maxCacheSize: number;
  useJit?: false | { jitOptions: Partial<CompilerOptions> };
  prewarm?: {
    schema: GraphQLSchema;
    preregistered?: { id: string; query: string }[];
    persisted?: { id: string; query: string }[];
    queries?: [];
  };
}): Promise<YogaPlugin> {
  unifiedCachesPrewarmed.unready();
  const { maxCacheSize, useJit, prewarm } = options;

  const documentCache = new DocumentCache(maxCacheSize);
  const validationCache = new ValidationCache();
  const jitCache = useJit ? new JitCache(useJit.jitOptions) : undefined;

  if (prewarm) {
    const documents: DocumentNode[] = [];
    await logPrewarm(
      'caches',
      [
        () => documentCache.prewarm(prewarm, documents),
        () => validationCache.prewarm(prewarm.schema, documents),
        () => jitCache?.prewarm(prewarm.schema, documents),
        () => prewarmExecutionCache(prewarm.schema, documents),
      ],
      (fun) => fun()
    );
  }

  // This is a dangerous way to merge these because they can clobber each
  // other, but we happen to know there's no overlap.
  const plugin: YogaPlugin = {
    ...documentCache.plugin,
    ...validationCache.plugin,
    ...jitCache?.plugin,
  };
  unifiedCachesPrewarmed.ready();
  return plugin;
}
