import { SERVER_PARAMS, logger } from '@taql/config';
import { httpAgent, httpsAgent } from '@taql/httpAgent';
import HttpProxy from 'http-proxy';
import { ParameterizedContext } from 'koa';
import { Supergraph } from '@taql/schema';
import { TaqlMiddleware } from '@taql/context';
import cluster from 'node:cluster';
import { getHeaderOrDefault } from '@taql/headers';

function getNonStitchedRoles(supergraph: Supergraph) {
  const legacySubgraph = supergraph.manifest
    .filter((sg) => sg.name == 'legacy-graphql')
    .pop();

  if (!legacySubgraph) {
    return undefined;
  }

  // We know these roles do not affect the stitched schema. This list is not
  // intended to be exhaustive, and an exhaustive list is not desirable: services
  // may _become_ stitched, unless there is some special property or use case
  // around the service that makes that extremely unlikely.
  const legacyUrl = new URL(legacySubgraph.executorConfig.url);
  const legacyPort =
    legacyUrl.port || (legacyUrl.protocol == 'http:' ? 80 : 443);
  return [
    // the components svc only consumes the schema - it's probably what called us
    'components*',
    'componentsweb*',
    // taql _is_ us
    'taql*',
    `graphql*${legacyUrl.hostname}:${legacyPort}:${legacyUrl.protocol}`,
  ];
}

function isOverriddenBy(svco: string, nonstitchedRoles: string[]) {
  return (
    svco
      .split('|')
      .filter((role) => role.trim() !== '')
      .find(
        (role) =>
          // The role is not non-stitched, so it _may_ be stitched.
          nonstitchedRoles.find((nonStitched) =>
            role.startsWith(nonStitched)
          ) == undefined
      ) != undefined
  );
}

export function createSvcoMiddleware(supergraph: Supergraph): TaqlMiddleware {
  const nonstitchedRoles = getNonStitchedRoles(supergraph);

  if (!nonstitchedRoles) {
    return function noop(_, next) {
      return next();
    };
  }

  const proxy = new HttpProxy();
  const proxyRequest = (target: string, ctx: ParameterizedContext) =>
    new Promise<void>((resolve, reject) => {
      const agent = ctx.request.protocol === 'https' ? httpsAgent : httpAgent;
      proxy.web(ctx.req, ctx.res, { target, agent }, (err) => {
        err ? reject(err) : resolve();
      });
    });

  return async function useSvco(ctx, next) {
    const svco = getHeaderOrDefault(
      ctx.headers,
      'x-service-overrides',
      undefined
    );
    if (svco && isOverriddenBy(svco, nonstitchedRoles)) {
      // Naively forward svco requests to same worker based on the length of svco
      const expectedWorkerId =
        (svco.length % SERVER_PARAMS.clusterParallelism) + 1;
      if (expectedWorkerId !== cluster.worker?.id) {
        logger.debug(
          `SVCO cookie set, but I'm not the correct worker... forwarding request from worker ${cluster.worker?.id} to worker ${expectedWorkerId}. SVCO: ${svco}`
        );
        // When deployed in a container, we must use the container's lo (loopback) interface to avoid colliding
        // with other containers that might use the same non-cluster IPs associated with our hostname
        const target = `${ctx.request.protocol}://127.0.0.1:${
          SERVER_PARAMS.port - expectedWorkerId
        }${ctx.request.url}`;
        await proxyRequest(target, ctx);
        await next();
      } else {
        // This is the correct svco worker
        // Only now we add svco to taql state since we know we'll use it
        Object.assign(ctx.state.taql, { SVCO: svco });
      }
    }
    await next();
  };
}
