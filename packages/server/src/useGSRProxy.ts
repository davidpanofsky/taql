import { SCHEMA, logger } from '@taql/config';
import type { ComposeSubgraphsRequest } from '@gsr/api.endpoints.compose-subgraphs';
import { IncomingMessage } from 'http';
import { ParameterizedContext } from 'koa';
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

export function createGSRProxy(): TaqlMiddleware {
  const manager = authManager(SCHEMA.oidcLiteAuthorizationDomain);
  const gsrClient = makeClient(SCHEMA, manager);

  async function handleGSRReponse(
    ctx: ParameterizedContext,
    gsrPromise: ReturnType<(typeof gsrClient)[keyof typeof gsrClient]>
  ) {
    try {
      const result = await gsrPromise;
      ctx.status = parseInt(result.statusCode);
      if ('body' in result) {
        ctx.body = JSON.stringify(result.body);
      }
    } catch (err) {
      logger.error(err);
      ctx.status = 500;
      ctx.body = err?.toString();
    }
  }

  return async function useGSRProxy(ctx, next) {
    if (ctx.request.method === 'POST' && ctx.request.path === '/compose') {
      await handleGSRReponse(
        ctx,
        gsrClient.compose({
          body: await parseBody(ctx.req),
          method: 'POST',
          query: { environment: SCHEMA.environment },
        })
      );
    } else if (
      ctx.request.method === 'GET' &&
      ctx.request.path === '/supergraph'
    ) {
      await handleGSRReponse(
        ctx,
        gsrClient.supergraph({
          method: 'GET',
          query: {
            environment: SCHEMA.environment,
          },
        })
      );
    } else {
      await next();
    }
  };
}
