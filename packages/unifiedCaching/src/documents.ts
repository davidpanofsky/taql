import { DocumentNode, GraphQLSchema, parse } from 'graphql';
import { YogaInitialContext, Plugin as YogaPlugin } from 'graphql-yoga';
import { InstrumentedCache } from '@taql/metrics';
import { LRUCache } from 'lru-cache';
import { logPrewarm } from './util';

type Cache<K extends NonNullable<unknown> = NonNullable<unknown>> = LRUCache<
  K,
  DocumentNode | Error
>;

export class DocumentCache {
  private readonly preregisteredDocuments: Cache<string>;
  private readonly persistedDocuments: Cache<string>;
  private readonly defaultDocuments: Cache<string>;

  constructor(maxCacheSize: number) {
    const cacheConfig = {
      max: maxCacheSize,
    };
    this.preregisteredDocuments = new InstrumentedCache<
      string,
      DocumentNode | Error
    >('preregistered_documents', cacheConfig);
    this.persistedDocuments = new InstrumentedCache<
      string,
      DocumentNode | Error
    >('persisted_documents', cacheConfig);
    this.defaultDocuments = new InstrumentedCache<string, DocumentNode | Error>(
      'default_documents',
      cacheConfig
    );
  }
  /**
   * Given the request context, pick the appropriate document cache and they key to use
   * for access and updates to that cache.
   */
  private pickDocumentCache(
    context: YogaInitialContext,
    defaultId: string
  ): [key: string, cache: LRUCache<string, DocumentNode | Error>] {
    const preregisteredId: string | undefined =
      context.params.extensions?.['preRegisteredQueryId'];
    if (preregisteredId != undefined) {
      return [preregisteredId, this.preregisteredDocuments];
    }
    const persistedId =
      context.params.extensions?.['persistedQuery']?.['sha256Hash'];
    if (persistedId != undefined) {
      return [persistedId, this.persistedDocuments];
    }
    return [defaultId, this.defaultDocuments];
  }

  readonly prewarm = (
    prewarm: {
      schema: GraphQLSchema;
      preregistered?: { id: string; query: string }[];
      persisted?: { id: string; query: string }[];
      queries?: [];
    },
    parsedDocuments?: DocumentNode[]
  ) => {
    const parseDocument = (
      cache: LRUCache<string, DocumentNode | Error>,
      id: string,
      query: string
    ) => {
      try {
        const document = parse(query);
        parsedDocuments?.push(document);
        cache.set(id, document);
      } catch (error) {
        if (error instanceof Error) {
          cache.set(id, error);
        } else {
          throw error;
        }
      }
    };

    return logPrewarm(
      'documents',
      [
        () =>
          logPrewarm(
            'preregistered queries',
            prewarm.preregistered,
            ({ id, query }) =>
              parseDocument(this.preregisteredDocuments, id, query)
          ),
        () =>
          logPrewarm('persisted queries', prewarm.persisted, ({ id, query }) =>
            parseDocument(this.persistedDocuments, id, query)
          ),
        () =>
          logPrewarm('other queries', prewarm.queries, (query) =>
            parseDocument(this.defaultDocuments, query, query)
          ),
      ],
      (fun) => fun()
    );
  };

  readonly plugin: YogaPlugin = {
    onParse: (args) => {
      const [key, cache] = this.pickDocumentCache(
        args.context,
        args.params.source.toString()
      );
      const cached = cache.get(key);
      if (cached) {
        if (cached instanceof Error) {
          throw cached;
        }
        args.setParsedDocument(cached);
        return;
      } else {
        return ({ result }) => cache.set(key, result);
      }
    },
  };
}
