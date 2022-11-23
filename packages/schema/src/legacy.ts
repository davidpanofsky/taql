import { httpAgent, httpsAgent } from '@taql/httpAgent';
import { makeLegacyGqlExecutor, makeRemoteExecutor } from '@taql/executors';
import { LEGACY_GQL_PARAMS } from '@taql/config';
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
    const singleUrl = `${rootUrl}/v1/graphqlUnwrapped`;
    const batchUrl = `${rootUrl}/v1/graphqlBatched`;
    const rawSchemaResponse = await fetch(`${rootUrl}/Schema`, {
      agent: httpsAgent || httpAgent,
    });
    const rawSchema = await rawSchemaResponse.text();
    const schema = await loadSchema(rawSchema, { loaders: [] });
    const executor = makeRemoteExecutor(singleUrl);
    // TODO refactor stuff so the request & response transformations managed by
    // makeLegacyGqlExecutor are specified here and a generic method is called.
    // Our batching logic shouldn't need to know about legacy-specific
    // transformations at all.
    // TODO specify subBatchIdFn so graphql requests from different users are
    // not batched together.
    const batchExecutor = makeLegacyGqlExecutor(batchUrl, executor, {
      maxBatchSize: 100,
      //buffer up to 10ms for more queries.
      batchScheduleFn: (callback) => setTimeout(callback, 10),
    });
    const wrappedSchema = wrapSchema({ schema, executor: batchExecutor });
    const hash = crypto.createHash('md5').update(rawSchema).digest('hex');
    return { schema: wrappedSchema, hash };
  } catch (e) {
    console.error(`error loading legacy schema: ${e}`);
    throw e;
  }
}
