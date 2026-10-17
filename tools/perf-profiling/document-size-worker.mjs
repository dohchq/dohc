// Runs the shipping worker handler unchanged, with measurements around its messages.
// This is a harness worker, never installed in the relay service.
import { parentPort, workerData } from 'node:worker_threads';
import { getHeapStatistics, getHeapSpaceStatistics } from 'node:v8';

let started, cpu;
parentPort.on('message', () => {
  started = performance.now();
  cpu = process.threadCpuUsage();
});
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = result => {
  const delta = process.threadCpuUsage(cpu);
  const heap = getHeapStatistics();
  const spaces = getHeapSpaceStatistics();
  post({ result, metrics: { wallMs: performance.now() - started, cpuMs: (delta.user + delta.system) / 1000,
    usedHeapBytes: heap.used_heap_size, oldGenerationBytes: spaces.filter(s => /old|large_object/.test(s.space_name)).reduce((n, s) => n + s.space_used_size, 0),
    externalBytes: heap.external_memory, rssBytes: process.memoryUsage.rss() } });
};
await import(workerData.moduleUrl);
