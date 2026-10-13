// Measures write+fsync latency for 4 KiB appends, the shape of a WAL commit
// under synchronous=FULL. Usage: node - <directory> (piped via docker exec).
const fs = require("node:fs");
const directory = process.argv[2] ?? "/host-data";
const path = `${directory}/.trial-fsync-probe`;
const fd = fs.openSync(path, "w");
const buffer = Buffer.alloc(4096, 1), samples = [];
try {
  for (let index = 0; index < 200; index++) {
    const start = process.hrtime.bigint();
    fs.writeSync(fd, buffer);
    fs.fsyncSync(fd);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
} finally {
  fs.closeSync(fd);
  fs.rmSync(path);
}
samples.sort((a, b) => a - b);
const at = p => +samples[Math.floor(p * (samples.length - 1))].toFixed(3);
console.log(JSON.stringify({ directory, count: samples.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: at(1) }));
