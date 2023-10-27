import {
  CLUSTER_READINESS,
  addClusterReadinessStage,
  addPrimaryReadinessStage,
  useClusterReadiness,
} from '@taql/readiness';
import {
  ENABLE_FEATURES,
  SCHEMA,
  SERVER_PARAMS,
  appMeta,
  logger,
} from '@taql/config';
import { Server, createServer as httpServer } from 'http';
import cluster, { Worker } from 'node:cluster';
import {
  createHttpTrackingMiddleware,
  useMetricsEndpoint,
} from '@taql/observability';
import Koa from 'koa';
import { SSL_CONFIG } from '@taql/ssl';
import { createSvcoMiddleware } from './useSvco';
import { createYogaMiddleware } from './useYoga';
import { createServer as httpsServer } from 'https';
import { loadSupergraph } from '@taql/schema';
import process from 'node:process';
import promClient from 'prom-client';
import { promises } from 'fs';
import { useTaqlContext } from '@taql/context';

const serverListening = addClusterReadinessStage('serverListening');
const workersForked = addPrimaryReadinessStage('allWorkersForked');

const unhandledErrors = new promClient.Counter({
  name: 'taql_koa_unhandled_errors',
  help: 'count of unhandled koa errors',
  labelNames: ['code', 'name', 'reason'] as const,
});

const shutdownMessage = 'taql:shutdown';
let shuttingDown = false;

const workerStartup = async () => {
  const koa = new Koa();

  koa.on('error', function errorHandler(error) {
    unhandledErrors.inc({
      code: error?.code || 'Unknown',
      name: error?.name || 'Error',
      reason: error?.reason || 'Unknown',
    });
    logger.error('Unhandled koa error', error);
  });

  const supergraph = await loadSupergraph();

  // The order in which middleware is registered matters
  //  - We first parse headers and convert them to taql context, as we'll likely use that in other middlewares
  //  - We also handle svcos if they are enabled, and forward the request to correct worker if necessary
  //  - Request/response tracking comes after forwarding, so that we don't track same request twice (but before doing actual work)
  //  - And finally we hand off the request to yoga server
  koa.use(useTaqlContext);
  if (ENABLE_FEATURES.serviceOverrides) {
    koa.use(createSvcoMiddleware(supergraph));
  }
  koa.use(createHttpTrackingMiddleware({ logger }));
  koa.use(await createYogaMiddleware(supergraph));

  const server: Server =
    SSL_CONFIG == undefined ? httpServer() : httpsServer(SSL_CONFIG);

  server.addListener('request', koa.callback());

  server.listen(SERVER_PARAMS.port, () => {
    serverListening.ready();
    logger.info(`server listening on port ${SERVER_PARAMS.port}`);
  });

  if (ENABLE_FEATURES.serviceOverrides) {
    const svcoPort = SERVER_PARAMS.port - (cluster.worker?.id || 1);
    server.listen(svcoPort, () => {
      serverListening.ready();
      logger.info(`server listening on port ${svcoPort}`);
    });
  }

  // a long http keepalive timeout should help keep SVCO on same worker.
  //server.keepAliveTimeout = 60_000;
  process.on('message', async (message: unknown) => {
    if (message === shutdownMessage) {
      // clean up the server
      server.close(() => {
        cluster.worker?.disconnect();
      });
    }
  });

  cluster.worker?.on('disconnect', async () => {
    // Stop accepting connections and terminate any idle connections. Connections still writing/reading will continue to exist
    // During shutdown this will already have been called, but it's idempotent.
    server.close();
    // Wait for in flight requests to finish
    await new Promise((resolve) =>
      setTimeout(resolve, SERVER_PARAMS.workerDrainMs)
    );
    server.removeAllListeners();
    server.closeAllConnections();
  });
};

const primaryStartup = async () => {
  const { port } = SERVER_PARAMS;

  ['SIGINT', 'SIGTERM'].forEach((signal) =>
    process.on(signal, async (signal) => {
      shuttingDown = true;
      logger.info(
        `Primary received ${signal}, initiating shutdown after ${SERVER_PARAMS.primaryDrainDelayMs}ms`
      );

      // By the time that we have been given a signal to stop, we will have been removed from the endpoints list.
      // Before we stop, give callers time to have that change to DNS propagate
      await new Promise((resolve) =>
        setTimeout(resolve, SERVER_PARAMS.primaryDrainDelayMs)
      );

      let workersDraining = 0;
      for (const workerId in cluster.workers) {
        if (cluster.workers[workerId]?.isConnected()) {
          // Initiate shutdown
          cluster.workers[workerId]?.send(shutdownMessage);
          workersDraining++;
        }
      }
      // Give workers a chance to clean up before terminating them
      if (workersDraining > 0) {
        logger.info(`Draining ${workersDraining} workers`);
        await new Promise((resolve) =>
          setTimeout(resolve, SERVER_PARAMS.primaryDrainMs)
        );
        logger.info(
          `exiting after drain window (${SERVER_PARAMS.primaryDrainMs}ms)`
        );
      } else {
        logger.info('No workers to drain. Exiting');
      }

      for (const workerId in cluster.workers) {
        cluster.workers[workerId]?.kill(signal);
      }
      process.exit(128 + signal);
    })
  );

  const schemaFile = SCHEMA.schemaFile ?? './supergraph.json';
  if (SCHEMA.source == 'gsr') {
    const supergraph = await loadSupergraph();
    await promises.writeFile(schemaFile, JSON.stringify(supergraph));
    logger.info(`serialized supergraph from GSR to ${schemaFile}`);
  }

  const koa = new Koa();

  koa.use(
    useClusterReadiness({
      path: '/NotImplemented',
      readyBody: '<NotImplemented/>\n',
      unreadyBody: '<NotReady/>\n',
      readiness: CLUSTER_READINESS,
    })
  );
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
    labelNames: ['version'] as const,
  }).labels({ version: appMeta.version });

  const workersStarted = new promClient.Counter({
    name: 'taql_workers_started',
    help: 'Count of workers started cleanly',
    labelNames: ['version'] as const,
  }).labels({ version: appMeta.version });

  const workersExited = new promClient.Counter({
    name: 'taql_workers_exited',
    help: 'count of workers exited',
    labelNames: ['kind', 'version'] as const,
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

  const schemaEnv = {
    SCHEMA_FILE: schemaFile,
    SCHEMA_SOURCE: 'file',
  };

  for (let i = 0; i < SERVER_PARAMS.clusterParallelism; i++) {
    fork(schemaEnv);
    // A small delay between forks seems to help keep external dependencies happy.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }

  workersForked.ready();

  cluster.on('online', (worker) => {
    workersStarted.inc();
    logger.info('online', { pid: worker.process.pid });
  });

  cluster.on('exit', (worker, code, signal) => {
    if (worker.exitedAfterDisconnect === true) {
      logger.info('worker shutdown gracefully', { pid: worker.process.pid });
      workersExited.inc({ kind: 'graceful', version: appMeta.version });
    } else if (!shuttingDown) {
      if (signal) {
        logger.warn(`worker was killed by signal: ${signal}`, {
          pid: worker.process.pid,
        });
        workersExited.inc({ kind: 'killed', version: appMeta.version });
      } else if (code !== 0) {
        logger.warn(`worker ${worker.id} exited with error code: ${code}`, {
          pid: worker.process.pid,
        });
        workersExited.inc({ kind: 'error', version: appMeta.version });
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
