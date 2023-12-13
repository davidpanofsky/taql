import { SCHEMA, logger } from '@taql/config';
import type { ComposeSubgraphsRequest } from '@gsr/api.endpoints.compose-subgraphs';
import { IncomingMessage } from 'http';
import { TaqlMiddleware } from '@taql/context';
import { authManager } from '@taql/executors';
import { makeClient } from '@gsr/client';

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
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
  });
}

export function createComposeEndpoint(): TaqlMiddleware {
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
        ctx.body = JSON.stringify(result.body);
      } catch (err) {
        logger.error(err);
        ctx.status = 500;
        ctx.body = err?.toString();
      }
    } else {
      await next();
    }
  };
}
