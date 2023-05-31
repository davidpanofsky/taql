import {
  BatchStyle,
  BatchingStrategy,
  Subgraph,
} from '@ta-graphql-utils/stitch';
import { LEGACY_GQL_PARAMS, logger } from '@taql/config';
import { httpAgent, httpsAgent } from '@taql/httpAgent';
import { ENABLE_FEATURES } from '@taql/config';
import { ForwardSubschemaExtensions } from '@taql/debug';
import crypto from 'crypto';
import fetch from 'node-fetch';

const subgraphName = 'legacy-graphql';

const defaultLegacyScheme = httpsAgent == undefined ? 'http' : 'https';
const defaultLegacyPort =
  defaultLegacyScheme == 'http'
    ? LEGACY_GQL_PARAMS.httpPort
    : LEGACY_GQL_PARAMS.httpsPort;
const defaultLegacyHost = LEGACY_GQL_PARAMS.host;
const defaultLegacy = {
  host: defaultLegacyHost,
  scheme: defaultLegacyScheme,
  port: defaultLegacyPort,
};

const legacyHost = (
  legacySVCO?: string
): { host: string; port: number; scheme: string } => {
  if (legacySVCO == undefined) {
    return defaultLegacy;
  }

  try {
    const legacyOverride =
      legacySVCO
        ?.split('|')
        .filter((line) => line.startsWith('graphql*'))
        .map((override) => override.split('*')[1])
        .map((parts) => parts.split(':'))
        .pop() ?? [];
    return {
      host: legacyOverride[0] ?? defaultLegacyHost,
      port:
        (legacyOverride[1] && parseInt(legacyOverride[1])) || defaultLegacyPort,
      scheme: legacyOverride[2] ?? defaultLegacyScheme,
    };
  } catch (e) {
    console.debug(`unable to parse svco: ${legacySVCO}`, e);
    return defaultLegacy;
  }
};

export async function getLegacySubgraph(
  legacySVCO?: string
): Promise<{ subgraph: Subgraph; hash: string }> {
  const { batchMaxSize, batchWaitQueries, batchWaitMillis } = LEGACY_GQL_PARAMS;
  const { scheme, host, port } = legacyHost(legacySVCO);
  const rootUrl = `${scheme}://${host}:${port}`;
  const batchUrl = `${rootUrl}/v1/graphqlBatched`;
  try {
    const rawSchemaResponse = await fetch(`${rootUrl}/Schema`, {
      agent: httpsAgent || httpAgent,
      headers:
        legacySVCO == undefined
          ? undefined
          : { 'X-Service-Overrides': legacySVCO },
    });
    const rawSchema = await rawSchemaResponse.text();
    const hash = crypto.createHash('md5').update(rawSchema).digest('hex');
    const subgraph: Subgraph = {
      name: subgraphName,
      namespace: 'Global',
      sdl: rawSchema,
      executorConfig: {
        url: batchUrl,
        batching: {
          style: BatchStyle.Legacy,
          strategy: BatchingStrategy.BatchByUpstreamHeaders,
          maxSize: batchMaxSize,
          wait: {
            queries: batchWaitQueries,
            millis: batchWaitMillis,
          },
        },
      },
      transforms: ENABLE_FEATURES.debugExtensions
        ? [
            new ForwardSubschemaExtensions(
              subgraphName,
              // Omit mutatedFields since TAQL already provides that
              ({ mutatedFields, ...extensions }) => extensions
            ),
          ]
        : undefined,
    };

    return { subgraph, hash };
  } catch (e) {
    logger.error(`error loading legacy schema: ${e}`);
    throw e;
  }
}
