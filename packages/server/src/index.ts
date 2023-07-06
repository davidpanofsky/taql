import { ENABLE_FEATURES, SERVER_PARAMS, logger } from '@taql/config';
import { Server, createServer as httpServer } from 'http';
import cluster, { Worker } from 'node:cluster';
import { useHttpStatusTracking, useMetricsEndpoint } from './observability';
import Koa from 'koa';
import { SSL_CONFIG } from '@taql/ssl';
import { createServer as httpsServer } from 'https';
import process from 'node:process';
import promClient from 'prom-client';
import { useTaqlContext } from '@taql/context';
import { useYoga } from './useYoga';

const workerStartup = async () => {
  const port = SERVER_PARAMS.svcoWorker
    ? SERVER_PARAMS.port - 1
    : SERVER_PARAMS.port;

  const koa = new Koa();

  koa.use(useHttpStatusTracking({ logger }));

  //Initialize taql state.
  koa.use(useTaqlContext);

  koa.use(await useYoga());

  const server: Server =
    SSL_CONFIG == undefined ? httpServer() : httpsServer(SSL_CONFIG);

  server.addListener('request', koa.callback());
  logger.info('created server');

  logger.info(`launching server on port ${port}`);
  server.listen(port, () => {
    logger.info('server running');
  });

  // a long http keepalive timeout should help keep SVCO on same worker.
  //server.keepAliveTimeout = 60_000;

  cluster.worker?.on('disconnect', () => {
    server.removeAllListeners();
    server.closeAllConnections();
  });
};

const primaryStartup = async () => {
  const { port } = SERVER_PARAMS;

  const koa = new Koa();

  // add prom metrics endpoint
  koa.use(useMetricsEndpoint);
  const server: Server =
    SSL_CONFIG == undefined ? httpServer() : httpsServer(SSL_CONFIG);

  server.addListener('request', koa.callback());
  logger.info('created server');

  logger.info(`launching server on port ${port + 1}`);
  server.listen(port + 1, () => {
    logger.info('server running');
  });

  logger.info(`Primary process (${process.pid}) is running`);

  const forkCount = new promClient.Counter({
    name: 'taql_worker_forks',
    help: 'Count of workers forked with clustering',
  });

  const workersStarted = new promClient.Counter({
    name: 'taql_workers_started',
    help: 'Count of workers started cleanly',
  });

  const workersExited = new promClient.Counter({
    name: 'taql_workers_exited',
    help: 'count of workers exited',
    labelNames: ['kind'] as const,
  });

  const environments = new WeakMap<
    Worker,
    Record<string, string> | undefined
  >();
  const fork = (env?: Record<string, string>) => {
    forkCount.inc();
    environments.set(cluster.fork(env), env);
  };

  let sucessfulInitialization = false;
  cluster.on('listening', () => {
    sucessfulInitialization = true;
  });

  // create one worker for svco on port - 1 if enabled.
  ENABLE_FEATURES.serviceOverrides && fork({ SVCO_WORKER: 'true' });
  const clusterParallelism = ENABLE_FEATURES.serviceOverrides
    ? Math.max(SERVER_PARAMS.clusterParallelism - 1, 1)
    : SERVER_PARAMS.clusterParallelism;
  for (let i = 0; i < clusterParallelism; i++) {
    fork({ SVCO_WORKER: 'false' });
    // A small delay between forks seems to help keep external dependencies happy.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  cluster.on('online', (worker) => {
    workersStarted.inc();
    logger.info('online', { pid: worker.process.pid });
  });

  cluster.on('exit', (worker, code, signal) => {
    if (worker.exitedAfterDisconnect === true) {
      logger.info('worker shutdown gracefully', { pid: worker.process.pid });
      workersExited.inc({ kind: 'graceful' });
    } else {
      if (signal) {
        logger.warn(`worker was killed by signal: ${signal}`, {
          pid: worker.process.pid,
        });
        workersExited.inc({ kind: 'killed' });
      } else if (code !== 0) {
        logger.warn(`worker exited with error code: ${code}`, {
          pid: worker.process.pid,
        });
        workersExited.inc({ kind: 'error' });
      }
      if (sucessfulInitialization) {
        logger.info(`replacing worker ${worker.id}...`);
        fork(environments.get(worker));
      } else {
        logger.warn(
          'worker died before any sucessfull initialization. Shutting down cluster to prevent crashlooping'
        );
        cluster.disconnect(process.exit(1));
      }
    }
  });
};

cluster.isPrimary ? primaryStartup() : workerStartup();
