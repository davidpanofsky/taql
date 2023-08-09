import { ClusterReadiness } from './clusterReadiness';
import type { ParameterizedContext } from 'koa';
import { logger } from '@taql/config';

export const useClusterReadiness =
  (params: {path: string, readiness: ClusterReadiness, readyBody: string, unreadyBody?: string}) => {
    const {path, readiness, readyBody, unreadyBody} = params;

    logger.info(`useClusterReadiness: handling ${path}`)

    function unready(ctx: ParameterizedContext) {
      ctx.status = 500;
      if (unreadyBody) {
        ctx.body = unreadyBody
      }
    }

    function ready(ctx: ParameterizedContext) {
      ctx.body = readyBody;
      ctx.status = 200;
    }

    return async (ctx: ParameterizedContext, next: () => Promise<unknown>) => {
      if (ctx.request.method === 'GET' && ctx.request.path === path) {
        try {
          if (await readiness.isReady()) {
            ready(ctx);
          } else {
            unready(ctx);
          }
        } catch (err) {
          unready(ctx);
        }
      } else {
        await next();
      }
    }
  };
