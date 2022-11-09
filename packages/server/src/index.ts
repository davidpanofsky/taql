import { Server, createServer as httpServer } from 'http';
import { GraphQLSchema } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { createServer as httpsServer } from 'https';
import { pollSchema } from '@taql/schema';
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

  let server: Server;
  if (sslConfig != undefined) {
    server = httpsServer({ ...sslConfig });
    console.log(`launching https server on port ${port}`);
  } else {
    server = httpServer();
    console.log(`launching http server on port ${port}`);
  }

  const yogaOptions = {
    // TODO pick a number that matches the current limit in legacy graphql,
    // and draw it from configuration.
    batching: { limit: 200 },
  } as const;

  type YogaServer = ReturnType<typeof createYoga>;
  let yoga: YogaServer;

  const reloadYoga = (schema: GraphQLSchema) => {
    const next = createYoga({ schema, ...yogaOptions });
    server.removeListener('request', yoga);
    yoga = next;
    server.addListener('request', yoga);
    console.log('schema reloaded');
  };

  console.log('loading schema');
  const initialSchema = await pollSchema(
    { legacy },
    FIVE_MINUTES_MILLIS,
    reloadYoga
  );
  console.log('created initial schema');
  yoga = createYoga({ schema: initialSchema, ...yogaOptions });
  server.addListener('request', yoga);
  console.log('creating server');

  server.listen(port, () => {
    console.info('server running');
  });
}

main();
