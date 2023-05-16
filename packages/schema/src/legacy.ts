import { BatchStyle, BatchingStrategy } from '@taql/batching-config';
import { LEGACY_GQL_PARAMS, logger } from '@taql/config';
import { httpAgent, httpsAgent } from '@taql/httpAgent';
import { createExecutor } from '@taql/batching';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { loadSchema } from '@graphql-tools/load';

export type LegacyDebugResponseExtensions = {
  serviceTimings: Record<string, unknown>;
};

export async function fetchLegacySchema(legacySVCO?: string) {
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

    const makeSchema = () => loadSchema(rawSchema, { loaders: [] });
    const makeExecutor = () =>
      createExecutor(batchUrl, {
        style: BatchStyle.Legacy,
        strategy: BatchingStrategy.BatchByUpstreamHeaders,
        maxSize: batchMaxSize,
        wait: {
          queries: batchWaitQueries,
          millis: batchWaitMillis,
        },
      });

    return { makeSchema, makeExecutor, hash };
  } catch (e) {
    logger.error(`error loading legacy schema: ${e}`);
    throw e;
  }
}
