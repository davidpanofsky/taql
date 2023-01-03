import { Server, createServer as httpServer } from 'http';
import { TaqlContext, plugins as contextPlugins } from '@taql/context';
import Koa from 'koa';
import { SERVER_PARAMS } from '@taql/config';
import { SSL_CONFIG } from '@taql/ssl';
import { SchemaPoller } from '@taql/schema';
import { TaqlPlugins } from '@taql/plugins';
import { plugins as batchingPlugins } from '@taql/batching';
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

  const plugins: TaqlPlugins = new TaqlPlugins(
    schemaPoller.asPlugin(),
    contextPlugins,
    batchingPlugins,
    { envelop: preregPlugins }
  );

  const yoga = createYoga<TaqlContext>({
    schema,
    ...yogaOptions,
    plugins: plugins.envelop(),
  });

  const koa = new Koa();
  plugins.koa().forEach((mw) => koa.use(mw));

  koa.use(async (ctx) => {
    // Second parameter adds Koa's context into GraphQL Context
    const response = await yoga.handleNodeRequest(ctx.req, ctx);

    // Set status code
    ctx.status = response.status;

    // Set headers
    response.headers.forEach((value, key) => {
      ctx.append(key, value);
    });

    // Converts ReadableStream to a NodeJS Stream
    ctx.body = response.body;
  });

  const server: Server =
    SSL_CONFIG == undefined ? httpServer() : httpsServer(SSL_CONFIG);

  server.addListener('request', koa.callback());
  console.log('created server');

  console.log(`launching server on port ${port}`);
  server.listen(port, () => {
    console.info('server running');
  });
}

main();
