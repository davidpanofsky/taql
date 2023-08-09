import type { ParameterizedContext } from 'koa';
import { logger } from '@taql/config';
import { ClusterReadiness } from './clusterReadiness'

export const useClusterReadiness =  
  (path: string, readiness: ClusterReadiness) => {
    // Initializing cluster readiness sets up all the listeners
    return async (ctx: ParameterizedContext, next: () => Promise<unknown>) => {
      if (ctx.request.method === 'GET' && ctx.request.path === path) {
        try {
          logger.info(`intercepted readiness call to ${path}`);
          if (await readiness.clusterReadiness()) {
            ctx.body = '<NotImplemented/>\n';
            ctx.status = 200;
          } else {
            ctx.body = '<NotReady/>\n'
            ctx.status = 500;
          }
        } catch (err) {
          ctx.status = 500;
          ctx.body = err;
        }
      } else {
        await next();
      }
    }
  };
