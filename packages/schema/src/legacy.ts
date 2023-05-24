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

export type LegacyDebugResponseExtensions = {
  serviceTimings: Record<string, unknown>;
};

export async function getLegacySubgraph(
  legacySVCO?: string
): Promise<{ subgraph: Subgraph; hash: string }> {
  const {
    host,
    httpPort,
    httpsPort,
    batchMaxSize,
    batchWaitQueries,
    batchWaitMillis,
  } = LEGACY_GQL_PARAMS;
  LEGACY_GQL_PARAMS.host;
  const protocol = httpsAgent == undefined ? 'http' : 'https';
  const port = protocol == 'http' ? httpPort : httpsPort;
  try {
    const rootUrl = `${protocol}://${host}:${port}`;
    const batchUrl = `${rootUrl}/v1/graphqlBatched`;
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
            new ForwardSubschemaExtensions<LegacyDebugResponseExtensions>(
              subgraphName,
              ({ serviceTimings }) => ({ serviceTimings })
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ) as any, // FIXME(jdujic): Fix types
          ]
        : undefined,
    };

    return { subgraph, hash };
  } catch (e) {
    logger.error(`error loading legacy schema: ${e}`);
    throw e;
  }
}
