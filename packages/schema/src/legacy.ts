import { httpAgent, httpsAgent } from '@taql/httpAgent';
import { ENABLE_FEATURES } from '@taql/config';
import { ForwardSubschemaExtensions } from '@taql/debug';
import { Subgraph } from '@ta-graphql-utils/stitch';
import type { Transform } from '@graphql-tools/delegate';
import { createGraphQLError } from '@graphql-tools/utils';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { logger } from '@taql/config';

const subgraphName = 'legacy-graphql';

const legacyHost = (url: URL, legacySVCO?: string): URL => {
  if (legacySVCO == undefined) {
    return url;
  }

  try {
    const legacyOverride =
      legacySVCO
        ?.split('|')
        .filter((line) => line.startsWith('graphql*'))
        .map((override) => override.split('*')[1])
        .map((parts) => parts.split(':'))
        .pop() ?? [];
    const hostname = legacyOverride[0] ?? url.hostname;
    const port = legacyOverride[1] || url.port;
    const protocol = legacyOverride[2] ?? url.protocol;
    return new URL(`${protocol}://${hostname}:${port}`);
  } catch (e) {
    console.debug(`unable to parse svco: ${legacySVCO}`, e);
    return url;
  }
};

const isTransform = <T extends Transform>(
  t: T | boolean | undefined | null | void
): t is T => !!t;

/**
 * Converts legacy graphql errors to GraphQLError objects
 */
const forwardLegacyErrorsTransform: Transform = {
  transformResult(result) {
    if (result.errors?.length) {
      return {
        ...result,
        errors: result.errors.map((e) =>
          createGraphQLError(
            e.message,
            ENABLE_FEATURES.debugExtensions
              ? {
                  extensions: {
                    subgraphName,
                    originalError: e,
                  },
                }
              : undefined
          )
        ),
      };
    }
    return result;
  },
};

export async function getLegacySubgraph(args: {
  url: URL;
  batchMaxSize: number;
  batchWaitQueries: number;
  batchWaitMillis: number;
  legacySVCO?: string;
}): Promise<{ subgraph: Subgraph; digest: string }> {
  const baseUrl = legacyHost(args.url, args.legacySVCO).toString();
  const schemaUrl = new URL(baseUrl);
  schemaUrl.pathname = '/Schema';
  const batchUrl = new URL(baseUrl);
  batchUrl.pathname = '/v1/graphqlBatched';
  try {
    const rawSchemaResponse = await fetch(schemaUrl, {
      agent: httpsAgent || httpAgent,
      headers:
        args.legacySVCO == undefined
          ? undefined
          : { 'X-Service-Overrides': args.legacySVCO },
    });
    const rawSchema = await rawSchemaResponse.text();
    const subgraph: Subgraph = {
      name: subgraphName,
      namespace: 'Global',
      sdl: rawSchema,
      executorConfig: {
        url: batchUrl.toString(),
        batching: {
          style: 'Legacy',
          strategy: 'Headers',
          maxSize: args.batchMaxSize,
          wait: {
            queries: args.batchWaitQueries,
            millis: args.batchWaitMillis,
          },
        },
      },
      transforms: [
        forwardLegacyErrorsTransform,
        ENABLE_FEATURES.debugExtensions &&
          new ForwardSubschemaExtensions(
            subgraphName,
            // Omit mutatedFields since TAQL already provides that
            ({ mutatedFields, ...extensions }) => extensions
          ),
      ].filter(isTransform),
    };
    const digest = crypto.createHash('md5').update(rawSchema).digest('hex');

    return { subgraph, digest };
  } catch (e) {
    logger.error(`error loading legacy schema: ${e}`);
    throw e;
  }
}
