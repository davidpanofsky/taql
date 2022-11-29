import { httpAgent, httpsAgent } from '@taql/httpAgent';
import { LEGACY_GQL_PARAMS } from '@taql/config';
import { createExecutor } from '@taql/batching';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { loadSchema } from '@graphql-tools/load';
import { wrapSchema } from '@graphql-tools/wrap';

export async function makeLegacySchema() {
  const { host, httpPort, httpsPort } = LEGACY_GQL_PARAMS;
  LEGACY_GQL_PARAMS.host;
  const protocol = httpsAgent == undefined ? 'http' : 'https';
  const port = protocol == 'http' ? httpPort : httpsPort;
  try {
    const rootUrl = `${protocol}://${host}:${port}`;
    const batchUrl = `${rootUrl}/v1/graphqlBatched`;
    const rawSchemaResponse = await fetch(`${rootUrl}/Schema`, {
      agent: httpsAgent || httpAgent,
    });
    const rawSchema = await rawSchemaResponse.text();
    const schema = await loadSchema(rawSchema, { loaders: [] });
    const executor = createExecutor(batchUrl, {
      style: 'Legacy',
      strategy: 'BatchByUpstreamHeaders',
      //strategy: 'InsecurelyBatchIndiscriminately',
      //strategy: 'BatchByInboundRequest',
      dataLoaderOptions: {
        maxBatchSize: 100,
        //buffer up to 10ms for more queries.
        batchScheduleFn: (callback) => setTimeout(callback, 100),
      },
    });

    const wrappedSchema = wrapSchema({ schema, executor });
    const hash = crypto.createHash('md5').update(rawSchema).digest('hex');
    return { schema: wrappedSchema, hash };
  } catch (e) {
    console.error(`error loading legacy schema: ${e}`);
    throw e;
  }
}
