import { Server, createServer as httpServer } from 'http';
import { SERVER_PARAMS } from '@taql/config';
import { SSL_CONFIG } from '@taql/ssl';
import { SchemaPoller } from '@taql/schema';
import { plugins as contextPlugins } from '@taql/context';
import { createYoga } from 'graphql-yoga';
import { createServer as httpsServer } from 'https';
import { plugins as preregPlugins } from '@taql/prereg';

const FIVE_MINUTES_MILLIS = 1000 * 60 * 5;

export async function main() {
  const { port } = SERVER_PARAMS;

  const yogaOptions = {
    // TODO pick a number that matches the current limit in legacy graphql,
    // and draw it from configuration.
    batching: { limit: 200 },
  } as const;

  const schemaPoller = new SchemaPoller({
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
    plugins: [schemaPoller.asPlugin(), ...preregPlugins, ...contextPlugins],
  });

  const server: Server =
    SSL_CONFIG == undefined ? httpServer() : httpsServer(SSL_CONFIG);

  server.addListener('request', yoga);
  console.log('created server');

  console.log(`launching server on port ${port}`);
  server.listen(port, () => {
    console.info('server running');
  });
}

main();
