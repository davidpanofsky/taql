import cluster from 'node:cluster';
import { logger } from '@taql/config';

// Set up message names
const GET_READINESS_REQ = 'taql-readiness:getReadinessReq';
const GET_READINESS_RES = 'taql-readiness:getReadinessRes';

// What amounts to an id sequence per primary process so it can keep track of concurrent readiness checks.
let requestIdSeq = 0;

type ReadinessRequest = {
  responses: boolean[];
  pending: number;
  done: (result: boolean | null, error: unknown) => void;
  errorTimeout: ReturnType<typeof setTimeout>;
};

const requests = new Map<number, ReadinessRequest>();

const workerChecks: (() => boolean)[] = [];
const primaryChecks: (() => boolean)[] = [];

function evaluateChecks(checks: (() => boolean)[], def: boolean): boolean {
  return checks.length > 0 ? checks.every((check) => check()) : def;
}

let listenersAdded = false;
// idempotently add listeners for IPC messages
function addListeners(workerDefaultReadiness: boolean) {
  if (listenersAdded) {
    return;
  }
  listenersAdded = true;

  if (cluster.isPrimary) {
    cluster.on('message', (worker, message) => {
      if (message.type === GET_READINESS_RES) {
        // process response from worker
        const request = requests.get(message.requestId);
        if (!request) {
          logger.error(
            `Readiness request for requestId ${message.requestId} not found during processing`
          );
          return;
        }

        if (message.error) {
          request.done(null, new Error(message.error));
          request.responses.push(false);
        } else {
          request.responses.push(message.readiness);

          if (!message.readiness) {
            request.done(false, null);
          }
        }
        request.pending--;

        if (request.pending === 0) {
          // clean up
          requests.delete(message.requestId);
          clearTimeout(request.errorTimeout);
          // Compute readiness. We might have already shortcircuited due to a failed check.
          const readiness = request.responses.every((response) => response);
          request.done(readiness, null);
        }
      }
    });
  }

  if (cluster.isWorker) {
    process.on('message', (message: { type?: string; requestId?: number }) => {
      if (message.type === GET_READINESS_REQ) {
        // Send readiness response to primary (master)
        // Compute this worker's readiness
        const readiness = evaluateChecks(workerChecks, workerDefaultReadiness);
        process.send?.({
          type: GET_READINESS_RES,
          requestId: message.requestId,
          readiness,
        });
      }
    });
  }
}

export class ClusterReadiness {
  private readonly maxWaitMs: number;
  private readonly primaryDefaultReadiness: boolean;
  constructor(options: {
    maxWaitMs: number;
    workerDefaultReadiness?: boolean;
    primaryDefaultReadiness?: boolean;
  }) {
    const {
      maxWaitMs,
      workerDefaultReadiness = false,
      primaryDefaultReadiness = false,
    } = options;
    this.maxWaitMs = maxWaitMs;
    this.primaryDefaultReadiness = primaryDefaultReadiness;
    addListeners(workerDefaultReadiness);
  }

  addClusterReadinessStage(readiness: { check: () => boolean; name: string }) {
    if (cluster.isWorker) {
      logger.info(`Asserting readiness of ${readiness.name}`);
    }
    workerChecks.push(readiness.check);
    return readiness;
  }

  addPrimaryReadinessStage(readiness: { check: () => boolean; name: string }) {
    logger.info(`Asserting readiness of ${readiness.name} in primary`);
    primaryChecks.push(readiness.check);
    return readiness;
  }

  addWorkerCheck(check: () => boolean) {
    workerChecks.push(check);
    return check;
  }

  addPrimaryCheck(check: () => boolean) {
    primaryChecks.push(check);
    return check;
  }

  isReady(): Promise<boolean> {
    const requestId = requestIdSeq++;
    return new Promise((resolve, reject) => {
      let settled = false;
      function done(result: boolean | null, error: unknown) {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve(!!result);
        }
      }

      const request: ReadinessRequest = {
        responses: [],
        pending: 0,
        done,
        errorTimeout: setTimeout(() => {
          const error = new Error(
            `Cluster readiness timed out after ${this.maxWaitMs}ms`
          );
          request.done(null, error);
        }, this.maxWaitMs),
      };

      requests.set(requestId, request);
      const message = {
        type: GET_READINESS_REQ,
        requestId,
      };

      for (const workerId in cluster.workers) {
        if (cluster.workers[workerId]?.isConnected()) {
          cluster.workers[workerId]?.send(message);
          request.pending++;
        }
      }

      if (request.pending === 0) {
        // No workers were connected
        clearTimeout(request.errorTimeout);
        process.nextTick(() => done(false, null));
      }
    }).then(
      (workerReadiness) =>
        workerReadiness === true &&
        evaluateChecks(primaryChecks, this.primaryDefaultReadiness)
    );
  }
}
