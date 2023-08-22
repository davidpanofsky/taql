import { ENABLE_FEATURES, logger } from '@taql/config';
import { Subgraph, normalizeSdl } from '@ta-graphql-utils/stitch';
import fetch, { FetchError, Headers } from 'node-fetch';
import { httpAgent, httpsAgent } from '@taql/httpAgent';
import { ForwardSubschemaExtensions } from '@taql/debug';
import type { Transform } from '@graphql-tools/delegate';
import { URL } from 'node:url';
import { createGraphQLError } from '@graphql-tools/utils';
import crypto from 'crypto';
import { loadSchema } from '@graphql-tools/load';
import path from 'node:path';
import { subgraphAuthProvider } from '@taql/executors';

const subgraphName = 'legacy-graphql';

const normalizeLegacySchema = async (rawSchema: string): Promise<string> => {
  const legacySchema = await loadSchema(rawSchema, {
    loaders: [],
    noLocation: !ENABLE_FEATURES.astLocationInfo,
  });
  return normalizeSdl(legacySchema, {
    noDescription: !ENABLE_FEATURES.astDescription,
  });
};

const legacyHostOverride = (url: URL, legacySVCO: string): URL => {
  try {
    const legacyOverride =
      legacySVCO
        .split('|')
        .filter((line) => line.startsWith('graphql*'))
        .map((override) => override.split('*')[1])
        .map((parts) => parts.split(':'))
        .pop() ?? [];
    const legacySvcoUrl = new URL(url.href);
    legacySvcoUrl.hostname = legacyOverride[0] ?? legacySvcoUrl.hostname;
    legacySvcoUrl.port = legacyOverride[1] ?? legacySvcoUrl.port;
    legacySvcoUrl.protocol = legacyOverride[2]
      ? `${legacyOverride[2]}:`
      : legacySvcoUrl.protocol;
    legacySvcoUrl.pathname = '';
    return legacySvcoUrl;
  } catch (e) {
    console.debug(`unable to parse svco: ${legacySVCO}`, e);
  }
  return url;
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

export const legacyTransforms = [
  forwardLegacyErrorsTransform,
  ENABLE_FEATURES.debugExtensions &&
    new ForwardSubschemaExtensions(
      subgraphName,
      // Omit mutatedFields since TAQL already provides that
      ({ mutatedFields, ...extensions }) => extensions
    ),
].filter(isTransform);

export async function getLegacySubgraph(args: {
  url: URL;
  oidcLiteAuthorizationDomain?: string;
  batchMaxSize: number;
  batchWaitQueries: number;
  batchWaitMillis: number;
  legacySVCO?: string;
}): Promise<{ subgraph: Subgraph; digest: string }> {
  const rootUrl = args.legacySVCO
    ? legacyHostOverride(args.url, args.legacySVCO)
    : args.url;
  const schemaUrl = new URL(path.join(rootUrl.href, 'Schema'));
  const batchUrl = new URL(path.join(rootUrl.href, 'v1/graphqlBatched'));

  const legacyAuthProvider = subgraphAuthProvider(
    args.url,
    args.oidcLiteAuthorizationDomain
  );
  const headers = new Headers();
  const token = (await legacyAuthProvider?.getAuth())?.accessToken;
  token != undefined &&
    headers.append('x-oidc-authorization', `Bearer ${token}`);
  args.legacySVCO != undefined &&
    headers.append('x-service-overrides', args.legacySVCO);
  const agent = schemaUrl.protocol == 'https:' ? httpsAgent : httpAgent;
  try {
    const rawSchemaResponse = await fetch(schemaUrl, {
      agent,
      headers,
    });
    const rawSchema = await rawSchemaResponse.text();
    if (!rawSchemaResponse.ok) {
      throw createGraphQLError(`Error loading schema: ${rawSchema}`);
    }
    const subgraph: Subgraph = {
      name: subgraphName,
      namespace: 'Global',
      sdl: await normalizeLegacySchema(rawSchema),
      executorConfig: {
        url: batchUrl,
        oidcLiteAuthorizationDomain: args.oidcLiteAuthorizationDomain,
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
      transforms: legacyTransforms,
    };
    const digest = crypto.createHash('md5').update(rawSchema).digest('hex');

    return { subgraph, digest };
  } catch (e) {
    if (
      e instanceof FetchError &&
      e.type == 'system' &&
      e.errno == 'EPROTO' &&
      e.message.includes('alert bad certificate')
    ) {
      throw new Error(
        "SSL error while fetching from schema. (This probably happened because you are trying to use https, but don't have mTLS or oidc configured. See @taql/config or the project README for more information)"
      );
    }
    logger.error(`error loading legacy schema: ${e}`);
    throw e;
  }
}
