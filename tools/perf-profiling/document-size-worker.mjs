// Runs the shipping child handler unchanged, with measurements around its messages.
// This is a harness worker, never installed in the relay service. It stands in for the
// relay's IPC channel: the handler sends through `process.send` and reads `process` messages.
import { parentPort, workerData } from 'node:worker_threads';
import { getHeapStatistics, getHeapSpaceStatistics } from 'node:v8';

let started, cpu;
process.send = (result) => {
  const delta = process.threadCpuUsage(cpu);
  const heap = getHeapStatistics();
  const spaces = getHeapSpaceStatistics();
  parentPort.postMessage({ result, metrics: { wallMs: performance.now() - started, cpuMs: (delta.user + delta.system) / 1000,
    usedHeapBytes: heap.used_heap_size, oldGenerationBytes: spaces.filter(s => /old|large_object/.test(s.space_name)).reduce((n, s) => n + s.space_used_size, 0),
    externalBytes: heap.external_memory, rssBytes: process.memoryUsage.rss() } });
  return true;
};
await import(workerData.moduleUrl);
parentPort.on('message', (work) => {
  started = performance.now();
  cpu = process.threadCpuUsage();
  process.emit('message', work);
});
