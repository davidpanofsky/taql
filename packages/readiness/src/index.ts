export * from './useReadiness';
import { ClusterReadiness } from './clusterReadiness';
import { logger } from '@taql/config';

// IPC message listeners are set up by the constructor of ClusterReadiness.
export const CLUSTER_READINESS = new ClusterReadiness(
  200 // If a worker can't respond in 200ms, consider it unready
);

export type ReadinessStage = {
  check: () => boolean;
  ready: () => void;
  unready: () => void;
  name: string;
};

/**
 * Set up callbacks to mark a logical stage of readiness as either ready or unready
 */
export function readinessStage(name: string): ReadinessStage {
  let ready = false;
  let start = Date.now();
  return {
    check: () => ready,
    ready() {
      logger.info(
        `Completed readiness stage "${name}" after ${Date.now() - start}ms`
      );
      ready = true;
    },
    unready() {
      if (ready) {
        // reset the timer if and only if the state is changing
        start = Date.now();
        logger.info(`Readiness stage "${name}" invalidated`);
      }
      ready = false;
    },
    name,
  };
}

export function addClusterReadinessStage(
  stage: ReadinessStage | string
): ReadinessStage {
  if (typeof stage === 'string') {
    stage = readinessStage(stage);
    CLUSTER_READINESS.addReadinessStage(stage);
  } else {
    CLUSTER_READINESS.addReadinessStage(stage);
  }
  return stage;
}

export function addClusterReadinessCheck(check: () => boolean) {
  CLUSTER_READINESS.addCheck(check);
  return check;
}
