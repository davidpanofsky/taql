import { ENABLE_FEATURES, SERVER_PARAMS, WORKER, logger } from '@taql/config';
import { Supergraph, TASchema, overrideSupergraphWithSvco } from '@taql/schema';
import { instrumentedStore, memoryStore } from '@taql/caching';
import { GraphQLSchema } from 'graphql';
import { Request as KoaRequest } from 'koa';
import type { Plugin } from 'graphql-yoga';
import { TaqlState } from '@taql/context';
import promClient from 'prom-client';

const SVCO_SCHEMA_BUILD_HISTOGRAM = new promClient.Histogram({
  name: 'taql_svco_schema_build',
  help: 'Total number of times and duration of new schema builds required to serve an SVCO cookie/header',
  labelNames: ['worker'],
  buckets: [0.5, 1, 2.5, 5, 10],
});

export const useSchema = (
  defaultSupergraph: Supergraph,
  defaultSchema: TASchema
): Plugin => {
  if (!ENABLE_FEATURES.serviceOverrides) {
    // One schema to rule them all, and never think about.
    return {
      onEnveloped({ setSchema }) {
        setSchema(defaultSchema.schema);
      },
    };
  }

  const schemaForSVCOCache = instrumentedStore({
    name: 'svco_schemas',
    store: memoryStore<GraphQLSchema>({
      max: 10,
      ttl: SERVER_PARAMS.svcoSchemaTtl,
      async fetchMethod(legacySVCO): Promise<GraphQLSchema> {
        logger.debug(`Fetching and building schema for SVCO: ${legacySVCO}`);
        const stopTimer =
          SVCO_SCHEMA_BUILD_HISTOGRAM.labels(WORKER).startTimer();
        return overrideSupergraphWithSvco(defaultSupergraph, legacySVCO).then(
          (stitchResult) => {
            stopTimer();
            return stitchResult == undefined || 'error' in stitchResult
              ? defaultSchema.schema
              : 'partial' in stitchResult
                ? stitchResult.partial.schema
                : stitchResult.success.schema;
          }
        );
      },
    }),
  });

  // Schema construction is async so we can't just hook in to onEnveloped, as that
  // stage is synchronous. Instead, we hook into the onRequestParse stage, which
  // allows us to return async methods that will be awaited after parsing and
  // before onEnveloped. This weakmap persists the schema between those stages
  const schemaByRequest = new WeakMap<Request | KoaRequest, GraphQLSchema>();
  return {
    onRequestParse({ request, serverContext }) {
      const context: Partial<TaqlState> = <Partial<TaqlState>>serverContext;
      const keyRequest = context.request ?? request;
      const svco = context.state?.taql.SVCO;

      if (!svco) {
        schemaByRequest.set(keyRequest, defaultSchema.schema);
        // There's no async work to do, so no need for a hook at all.
        return;
      }

      return {
        async onRequestParseDone() {
          logger.debug(`Using schema for SVCO: ${svco}`);
          const schemaForSVCO = await schemaForSVCOCache.lruCache.fetch(svco, {
            allowStale: true,
          });
          schemaByRequest.set(
            keyRequest,
            schemaForSVCO ?? defaultSchema.schema
          );
        },
      };
    },

    onEnveloped({ setSchema, context }) {
      const schema = schemaByRequest.get(context!.request);
      setSchema(schema);
    },
  };
};
