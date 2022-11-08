import { createServer } from 'node:http';
import { createYoga } from 'graphql-yoga';
import { makeSchema } from '@taql/schema';

const makeLegacyConfig = () => {
  const host = process.env.LEGACY_GQL_HOST;
  if (host == undefined) {
    return undefined;
  }
  return {
    host,
    httpPort: process.env.LEGACY_GQL_HTTP_PORT || '80',
    httpsPort: process.env.LEGACY_GQL_HTTPS_PORT || '443',
  };
};

export function main() {
  const legacy = makeLegacyConfig();
  const yoga = createYoga({
    schema: makeSchema({ legacy }),
    batching: { limit: 20 },
  });
  const server = createServer(yoga);
  server.listen(4000, () => {
    console.info('server running');
  });
}

main();
