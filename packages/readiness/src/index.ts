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
      if (ready) {
        // reset the timer if and only if the state is changing
        start = Date.now();
      }
      ready = false;
    },
    stage,
  };
}


// Readiness stages.  Exported so the related initialization sequences can import them and mark them when appropriate
export const unifiedCachesPrewarmed = readinessStage('unifiedCachesPrewarmed');
export const preregisteredQueriesPlugin = readinessStage('preregisteredQueriesPlugin');
export const serverListening = readinessStage('serverListening');

export const stages = [unifiedCachesPrewarmed, preregisteredQueriesPlugin, serverListening]
stages.forEach(CLUSTER_READINESS.addReadinessStage);

export function globalUnready() {
  stages.forEach((stage) => stage.unready());
}
