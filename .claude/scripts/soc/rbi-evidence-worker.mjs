// Fixed-task offline worker: receives a bounded worksheet and returns evidence gaps and reviewer decisions.
import { parentPort, workerData } from 'node:worker_threads';
import { reviewEvidence } from './rbi-review-model.mjs';
try {
  parentPort.postMessage({ worksheet: reviewEvidence(workerData.previous, workerData.edits, workerData.finalize) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
