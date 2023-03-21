import { BatchStyle, BatchingStrategy } from '@taql/batching-config';
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

    // For test: Strip 'directive @encode on FIELD' from schema
    //console.log("Legacy Schema:");
    //console.log(rawSchema);
    const encodeDecl = /".*"\ndirective @encode on FIELD\n\n/;
    const queryDirectiveStrippedSchema = rawSchema.replace(encodeDecl, '');
    if (queryDirectiveStrippedSchema != rawSchema) {
      console.log('successfully stripped query directive from schema');
    } else {
      console.log('did not remove query directive from legacy schema');
    }

    const schema = await loadSchema(queryDirectiveStrippedSchema, {
      loaders: [],
    });
    const executor = createExecutor(batchUrl, {
      style: BatchStyle.Legacy,
      strategy: BatchingStrategy.BatchByUpstreamHeaders,
      maxSize: 100,
      wait: {
        queries: 200,
        millis: 20,
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
