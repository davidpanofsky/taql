import { Server, createServer as httpServer } from 'http';
import { SchemaPoller } from '@taql/schema';
import { createYoga } from 'graphql-yoga';
import { createServer as httpsServer } from 'https';
import { plugins } from '@taql/context';
import { sslConfig } from '@taql/ssl';

const FIVE_MINUTES_MILLIS = 1000 * 60 * 5;

const makeLegacyConfig = () => {
  const host = process.env.LEGACY_GQL_HOST;
  if (host == undefined) {
    return undefined;
  }
  return {
    host,
    httpPort: process.env.LEGACY_GQL_HTTP_PORT || '80',
    httpsPort: process.env.LEGACY_GQL_HTTPS_PORT || '443',
  } as const;
};

export async function main() {
  const legacy = makeLegacyConfig();

  let port = Number(process.env.SERVER_PORT);
  if (port == undefined || isNaN(port)) {
    console.log(
      `unable to read port (SERVER_PORT) from environment${
        process.env.SERVER_PORT != undefined
          ? ` (${process.env.SERVER_PORT})`
          : ''
      }`
    );
    port = 4000;
  }

  const yogaOptions = {
    // TODO pick a number that matches the current limit in legacy graphql,
    // and draw it from configuration.
    batching: { limit: 200 },
  } as const;

  const schemaPoller = new SchemaPoller({
    options: { legacy },
    interval: FIVE_MINUTES_MILLIS,
  });

  const schema = await schemaPoller.schema;
  if (schema == undefined) {
    throw new Error('failed to load initial schema');
  }
  console.log('created initial schema');

  const yoga = createYoga({
    schema,
    ...yogaOptions,
    plugins: [schemaPoller.asPlugin(), ...plugins],
  });

  const server: Server =
    sslConfig == undefined ? httpServer() : httpsServer(sslConfig);

  server.addListener('request', yoga);
  console.log('created server');

  console.log(`launching server on port ${port}`);
  server.listen(port, () => {
    console.info('server running');
  });
}

main();
