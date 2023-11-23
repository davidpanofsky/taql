import { ClusterReadiness } from './clusterReadiness';
import type { ParameterizedContext } from 'koa';
import { logger } from '@taql/config';

export const useClusterReadiness = (params: {
  path: string;
  preStopPath: string;
  readiness: ClusterReadiness;
  readyBody: string;
  unreadyBody?: string;
}) => {
  const { path, preStopPath, readiness, readyBody, unreadyBody } = params;

  let shuttingDown = false;

  logger.info(`useClusterReadiness: handling ${path}`);

  function unready(ctx: ParameterizedContext) {
    ctx.status = 500;
    if (unreadyBody) {
      ctx.body = unreadyBody;
    }
  }

  function ready(ctx: ParameterizedContext) {
    ctx.body = readyBody;
    ctx.status = 200;
  }

  return async (ctx: ParameterizedContext, next: () => Promise<unknown>) => {
    if (ctx.request.method === 'GET' && ctx.request.path === path) {
      try {
        if (!shuttingDown && (await readiness.isReady())) {
          logger.debug('useClusterReadiness: ready');
          ready(ctx);
        } else {
          logger.debug('useClusterReadiness: unready');
          unready(ctx);
        }
      } catch (err) {
        unready(ctx);
      }
    } else if (ctx.request.method === 'GET' && ctx.request.path === preStopPath) {
      logger.info('useClusterReadiness: preStop hook called');
      shuttingDown = true;
      await new Promise((resolve) => setTimeout(resolve, 20000)); // hardcode to 20s - will make it configurable later
      ctx.body = '';
      ctx.status = 200;
    } else {
      await next();
    }
  };
};
