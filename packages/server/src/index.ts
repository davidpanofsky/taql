import { Server, createServer as httpServer } from 'http';
import { createYoga } from 'graphql-yoga';
import { createServer as httpsServer } from 'https';
import { makeSchema } from '@taql/schema';
import { readFileSync } from 'fs';

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

const rfs = (file?: string): string | undefined => {
  if (file == undefined) {
    return undefined;
  }
  return readFileSync(file, 'utf-8');
};

type SslConfig = {
  cert: string;
  key: string;
  ca?: string;
};

const makeSslConfig = (): SslConfig | undefined => {
  const cert = rfs(process.env.CLIENT_CERT_PATH);
  const key = rfs(process.env.CLIENT_KEY_PATH);
  const ca = rfs(process.env.CLIENT_CERT_CA_PATH);

  if (cert == undefined || key == undefined) {
    if ((cert == undefined) !== (key == undefined)) {
      console.error(
        'If CLIENT_CERT_PATH is set, CLIENT_KEY_PATH must also be set, and vice versa'
      );
    }
    return undefined;
  }

  return { cert, key, ca } as const;
};

export function main() {
  const sslConfig = makeSslConfig;
  const legacy = makeLegacyConfig();

  const yoga = createYoga({
    schema: makeSchema({ legacy }),
    //TODO pick a number that matches the current limit in legacy graphql.
    batching: { limit: 20 },
  });

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
    server = httpsServer({ ...sslConfig }, yoga);
    console.log(`launching https server on port ${port}`);
  } else {
    server = httpServer(yoga);
    console.log(`launching http server on port ${port}`);
  }
  server.listen(port, () => {
    console.info('server running');
  });
}

main();
