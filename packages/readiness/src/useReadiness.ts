import { ClusterReadiness } from './clusterReadiness';
import type { ParameterizedContext } from 'koa';
import { logger } from '@taql/config';

export const useClusterReadiness =
  (params: {path: string, readiness: ClusterReadiness, readyBody: string, unreadyBody?: string}) => {
    const {path, readiness, readyBody, unreadyBody} = params;
    return async (ctx: ParameterizedContext, next: () => Promise<unknown>) => {
      if (ctx.request.method === 'GET' && ctx.request.path === path) {
        logger.info(`useClusterReadiness: handling ${path}`)
        try {
          if (await readiness.isReady()) {
            logger.info('useClusterReadiness: ready');
            ctx.body = readyBody;
            ctx.status = 200;
          } else {
            logger.info('useClusterReadiness: unready');
            ctx.status = 500;
            if (unreadyBody) {
              ctx.body = unreadyBody;
            }
          }
        } catch (err) {
          logger.info(`useClusterReadiness: error: ${err}`);
          ctx.status = 500;
          if (unreadyBody) {
            ctx.body = unreadyBody;
          }
        }
      } else {
        await next();
      }
    }
  };
