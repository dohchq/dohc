import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export class DocumentValidationPool {
  constructor(checkout, signal) {
    this.signal = signal;
    this.waiters = [];
    this.busy = 0;
    this.peakBusy = 0;
    this.busyMs = 0;
    this.started = performance.now();
    this.closed = false;
    const require = createRequire(join(checkout, 'services/sync-relay/package.json'));
    this.slots = Array.from({ length: 2 }, () => {
      const worker = new Worker(new URL('./document-size-worker.mjs', import.meta.url), {
        execArgv: ['--import', pathToFileURL(require.resolve('tsx')).href],
        workerData: {
          moduleUrl: pathToFileURL(join(checkout, 'services/sync-relay/src/liveValidationWorker.ts')).href,
        },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      const slot = { worker, busy: false, error: null };
      worker.on('error', (error) => {
        slot.error = error;
        this.wake();
      });
      worker.on('exit', (code) => {
        slot.error ??= Error('Relay worker exited: ' + code);
        this.wake();
      });
      return slot;
    });
  }
  wake() {
    for (const wake of this.waiters.splice(0)) wake();
  }
  async submit(work) {
    if (this.closed) throw Error('Relay pool closed');
    if (this.slots.some((s) => s.error)) throw this.slots.find((s) => s.error).error;
    const queued = performance.now();
    let slot;
    while (!(slot = this.slots.find((s) => !s.busy && !s.error))) {
      this.signal?.throwIfAborted();
      if (this.closed) throw Error('Relay pool closed');
      if (this.slots.some((s) => s.error)) throw this.slots.find((s) => s.error).error;
      await new Promise((resolve, reject) => {
        const wake = () => {
          this.signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          this.waiters = this.waiters.filter((w) => w !== wake);
          reject(this.signal.reason);
        };
        this.waiters.push(wake);
        this.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (this.closed) throw Error('Relay pool closed');
    this.signal?.throwIfAborted();
    slot.busy = true;
    this.busy++;
    this.peakBusy = Math.max(this.peakBusy, this.busy);
    const started = performance.now();
    let sampledUsedHeapPeakBytes = 0,
      heapSamples = 0,
      sampling,
      occupiedMs;
    const sample = () =>
      (sampling ??= slot.worker
        .getHeapStatistics()
        .then((heap) => {
          sampledUsedHeapPeakBytes = Math.max(sampledUsedHeapPeakBytes, heap.used_heap_size);
          heapSamples++;
        })
        .finally(() => {
          sampling = null;
        }));
    const monitor = setInterval(() => {
      void sample().catch(() => {});
    }, 25);
    monitor.unref();
    try {
      const value = await new Promise((resolve, reject) => {
        const clean = () => {
          slot.worker.off('message', done);
          slot.worker.off('error', fail);
          slot.worker.off('exit', exit);
          this.signal?.removeEventListener('abort', abort);
        };
        const done = (value) => {
          clean();
          resolve(value);
        };
        const fail = (error) => {
          clean();
          reject(error);
        };
        const exit = (code) => fail(Error('Relay worker crashed: ' + code));
        const abort = () => fail(this.signal.reason);
        slot.worker.once('message', done);
        slot.worker.once('error', fail);
        slot.worker.once('exit', exit);
        this.signal?.addEventListener('abort', abort, { once: true });
        try {
          slot.worker.postMessage(work);
        } catch (error) {
          fail(error);
        }
      });
      const slotMs = performance.now() - started;
      occupiedMs = slotMs;
      await sampling;
      await sample();
      return {
        ...value,
        metrics: { ...value.metrics, sampledUsedHeapPeakBytes, heapSamples },
        waitMs: started - queued,
        slotMs,
      };
    } finally {
      clearInterval(monitor);
      await sampling?.catch(() => {});
      this.busyMs += occupiedMs ?? performance.now() - started;
      slot.busy = false;
      this.busy--;
      this.wake();
    }
  }
  resetUsage() {
    this.peakBusy = 0;
    this.busyMs = 0;
    this.started = performance.now();
  }
  usage() {
    return { peakBusy: this.peakBusy, occupancy: this.busyMs / (2 * (performance.now() - this.started)) };
  }
  async close() {
    this.closed = true;
    this.wake();
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}
