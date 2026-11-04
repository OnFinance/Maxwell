import { setTimeout as sleep } from 'node:timers/promises';

// Injectable wait makes scheduling/recovery testable without sleeping or contacting providers.
export async function watchMicrosoft({ poller, signal, onResult, onFailure, wait = (ms, signal) => sleep(ms, undefined, { signal }) }) {
  let failures = 0;
  while (!signal.aborted) {
    let result;
    try { result = await poller.poll({ signal }); failures = 0; }
    catch (error) {
      if (signal.aborted) break;
      failures++;
      await onFailure({ status: 'failed', consecutiveWorkerFailures: failures });
    }
    if (result) await onResult(result);
    if (signal.aborted) break;
    try { await wait(Math.min(300000, 60000 * 2 ** Math.min(failures, 3)), signal); }
    catch { if (!signal.aborted) throw new Error('scheduler wait failed'); }
  }
}
