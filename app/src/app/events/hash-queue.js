import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export class HashQueueOverflowError extends Error {
  constructor(message = "Hash queue overflow") {
    super(message);
    this.name = "HashQueueOverflowError";
    this.code = "HASH_QUEUE_OVERFLOW";
  }
}

export class HashQueueCancelledError extends Error {
  constructor(message = "Hash queue cancelled") {
    super(message);
    this.name = "HashQueueCancelledError";
    this.code = "HASH_QUEUE_CANCELLED";
  }
}

/**
 * Stream a file through SHA-256 without buffering the whole attachment in memory.
 */
export async function hashFileStream(absolutePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(absolutePath);
  for await (const chunk of stream) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Bound global hash/stat concurrency and pending work (including per-path queued tasks).
 * clear()/cancel settles every outstanding promise so callers never hang.
 */
export function createHashQueue({ maxConcurrency = 4, maxPending = 256 } = {}) {
  const concurrency = Math.max(1, Math.floor(Number(maxConcurrency) || 1));
  const pendingLimit = Math.max(concurrency, Number(maxPending) || concurrency);
  const waiting = [];
  const active = new Set();
  const busyPaths = new Set();
  const idleWaiters = [];

  function pump() {
    while (active.size < concurrency) {
      const index = waiting.findIndex(job => !busyPaths.has(job.key));
      if (index < 0) break;
      const job = waiting.splice(index, 1)[0];
      active.add(job);
      busyPaths.add(job.key);
      Promise.resolve().then(async () => {
        try {
          if (job.cancelled) throw new HashQueueCancelledError();
          const value = await job.task();
          job.resolve(value);
        } catch (error) {
          job.reject(error);
        } finally {
          active.delete(job);
          busyPaths.delete(job.key);
          pump();
        }
      });
    }
    if (!waiting.length && !active.size) for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function enqueuePath(key, task) {
    if (active.size + waiting.length >= pendingLimit) return Promise.reject(new HashQueueOverflowError());
    return new Promise((resolve, reject) => {
      waiting.push({ key, task, resolve, reject, cancelled: false });
      pump();
    });
  }

  function clear() {
    const error = new HashQueueCancelledError();
    for (const job of waiting.splice(0)) job.reject(error);
    // Reject callers immediately, but do not pretend uncancellable disk I/O has ended.
    // Slots and same-path ordering are released only by each running task's finally.
    for (const job of active) { job.cancelled = true; job.reject(error); }
    pump();
  }

  return {
    enqueuePath, clear,
    whenIdle() { return !waiting.length && !active.size ? Promise.resolve() : new Promise(resolve => idleWaiters.push(resolve)); },
    get inFlight() { return active.size; },
    get pendingJobs() { return active.size + waiting.length; },
    get pendingPaths() { return new Set([...busyPaths, ...waiting.map(job => job.key)]).size; },
    get maxPending() { return pendingLimit; },
    get maxConcurrency() { return concurrency; },
  };
}
