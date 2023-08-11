import { DocumentNode, GraphQLSchema, parse as graphqlParse } from 'graphql';
import { ENABLE_FEATURES, logger } from '@taql/config';
import { YogaInitialContext, Plugin as YogaPlugin } from 'graphql-yoga';
import { instrumentedStore, memoryStore } from './stores';
import type { Store } from 'cache-manager';
import { logPrewarm } from './util';

type DocumentStore = Store<DocumentNode | Error>;

const parse = (query: string) =>
  graphqlParse(query, {
    noLocation: !ENABLE_FEATURES.astLocationInfo,
  });

export class DocumentCache {
  private readonly preregisteredDocuments: DocumentStore;
  private readonly persistedDocuments: DocumentStore;
  private readonly defaultDocuments: DocumentStore;

  constructor(maxCacheSize: number) {
    const cacheConfig = {
      max: maxCacheSize,
    };
    this.preregisteredDocuments = instrumentedStore({
      store: memoryStore<DocumentNode | Error>(cacheConfig),
      name: 'preregistered_documents',
    });
    this.persistedDocuments = instrumentedStore({
      store: memoryStore<DocumentNode | Error>(cacheConfig),
      name: 'persisted_documents',
    });
    this.defaultDocuments = instrumentedStore({
      store: memoryStore<DocumentNode | Error>(cacheConfig),
      name: 'default_documents',
    });
  }
  /**
   * Given the request context, pick the appropriate document cache and they key to use
   * for access and updates to that cache.
   */
  private pickDocumentCache(
    context: YogaInitialContext,
    defaultId: string
  ): [key: string, cache: DocumentStore] {
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
    const parseDocument = (cache: DocumentStore, id: string, query: string) => {
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
      if (cached instanceof Promise) {
        // At the moment envelop doesn't support async functions in parse / validate hooks
        // That will change in the future and we will be able to use redis and similar stores there
        // https://github.com/graphql/graphql-js/issues/3421
        // Until that happens fail hard if anyone tries to use anything other than memory store
        logger.error('Trying to use unsupported store for parse cache', cache);
        throw new Error('Could not parse document. Unsupported cache type.');
      }
      if (cached) {
        if (cached instanceof Error) {
          throw cached;
        }
        args.setParsedDocument(cached);
        return;
      } else {
        args.setParseFn(parse);
        return ({ result }) => cache.set(key, result);
      }
    },
  };
}
