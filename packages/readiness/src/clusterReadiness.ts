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

const checks: (() => boolean)[] = [];

let listenersAdded = false;
// idempotently add listeners for IPC messages
function addListeners() {
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
          // Since we shortcircuit
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
        const readiness = checks.every((check) => check());
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
  constructor(maxWaitMs: number) {
    this.maxWaitMs = maxWaitMs;
    addListeners();
  }

  addReadinessStage(readiness: { check: () => boolean; stage: string }) {
    logger.info(`Asserting readiness of ${readiness.stage}`);
    checks.push(readiness.check);
  }

  addCheck(check: () => boolean) {
    checks.push(check);
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
    });
  }
}
