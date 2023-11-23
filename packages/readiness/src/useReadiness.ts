import { ClusterReadiness } from './clusterReadiness';
import type { ParameterizedContext } from 'koa';
import { logger } from '@taql/config';

export const useClusterReadiness = (params: {
  path: string;
  readiness: ClusterReadiness;
  readyBody: string;
  unreadyBody?: string;
}) => {
  const { path, readiness, readyBody, unreadyBody } = params;

  let shuttingDown = false;
  // Listen on signals to stop and fail the readiness check
  // so that we stop sending traffic to a pod that's shutting down
  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
      logger.debug(`Received ${signal} - will start failing readiness checks`);
      shuttingDown = true;
    });
  });

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
          logger.info(`useClusterReadiness: ready`);
          ready(ctx);
        } else {
          logger.info(`useClusterReadiness: unready`);
          unready(ctx);
        }
      } catch (err) {
        unready(ctx);
      }
    } else {
      await next();
    }
  };
};
