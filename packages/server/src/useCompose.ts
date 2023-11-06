import { makeClient } from '@gsr/client';
import { ComposeSubgraphsRequest } from '@gsr/api.endpoints.compose-subgraphs';
import { IncomingMessage } from 'http';
import { SCHEMA } from '@taql/config';
import { TaqlMiddleware } from '@taql/context';
import { authManager } from '@taql/executors';

function parseBody(req: IncomingMessage) {
  return new Promise<ComposeSubgraphsRequest['body']>((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('error', (err) => {
      reject(err);
    });
    req.on('end', () => {
      resolve(JSON.parse(data));
    });
  });
}

export function createComposeMiddleware(): TaqlMiddleware {
  const manager = authManager(SCHEMA.oidcLiteAuthorizationDomain);
  const gsrClient = makeClient(SCHEMA, manager);

  return async function useCompose(ctx, next) {
    if (ctx.request.method === 'POST' && ctx.request.path === '/compose') {
      try {
        const result = await gsrClient.compose({
          body: await parseBody(ctx.req),
          method: 'POST',
          query: { environment: SCHEMA.environment },
        });
        ctx.status = parseInt(result.statusCode);
        ctx.body =
          result.statusCode === '200'
            ? result.body.supergraph
            : result.body.compositionError;
      } catch (err) {
        ctx.status = 500;
        ctx.body = err;
      }
    } else {
      await next();
    }
  };
}
