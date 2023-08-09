import { ClusterReadiness } from './clusterReadiness';
import type { ParameterizedContext } from 'koa';

export const useClusterReadiness =
  (path: string, readiness: ClusterReadiness) =>
  // Initializing cluster readiness sets up all the listeners
  async (ctx: ParameterizedContext, next: () => Promise<unknown>) => {
    if (ctx.request.method === 'GET' && ctx.request.path === path) {
      try {
        if (await readiness.isReady()) {
          ctx.body = '<NotImplemented/>\n';
          ctx.status = 200;
        } else {
          ctx.body = '<NotReady/>\n';
          ctx.status = 500;
        }
      } catch (err) {
        ctx.status = 500;
        ctx.body = err;
      }
    } else {
      await next();
    }
  };
