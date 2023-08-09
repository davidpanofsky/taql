export * from './useReadiness';
import { ClusterReadiness } from './clusterReadiness';
import { logger } from '@taql/config';

// IPC message listeners are set up by the constructor of ClusterReadiness.
// TODO(smitchell): The worker listener needs to know what callback(s) each worker needs to make to determine readiness, and listener setup only happens once.
//                  This is confusing to be associated with instantiation of an object, both because multiple instantiations won't change the listeners as implemented,
//                  and because both workers and primary need to instantiate it.
export const CLUSTER_READINESS = new ClusterReadiness(
  200 // If a worker can't respond in 200ms, consider it unready
);

export function readinessStage(stage: string) {
  let ready = false;
  let start = Date.now();
  return {
    check: () => ready,
    ready() {
      logger.info(
        `Completed readiness stage "${stage}" after ${Date.now() - start}ms`
      );
      ready = true;
    },
    unready() {
      logger.info(`Readiness stage "${stage}" invalidated`);
      ready = false;
      start = Date.now();
    },
    stage,
  };
}

export const unifiedCachesPrewarmed = readinessStage('documentCache');
//CLUSTER_READINESS.addReadinessStage(unifiedCachesPrewarmed);

export const serverListening = readinessStage('serverListening');
CLUSTER_READINESS.addReadinessStage(serverListening);
