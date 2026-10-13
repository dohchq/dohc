// Appends one labelled measurement of the Cloudflare cell to a JSONL file, in the
// same row shape as snapshot.mjs. The whole cell is one container named "cell".
// Usage: DOHC_ORIGIN=... DOHC_TRIAL_KEY=... node trial/measure/cf-snapshot.mjs <label> <output.jsonl>
import { appendFileSync } from 'node:fs';

const [label, output] = process.argv.slice(2);
if (!label || !output) throw new Error('Usage: cf-snapshot.mjs <label> <output.jsonl>');
const response = await fetch(`${process.env.DOHC_ORIGIN}/__trial/stats`, { headers: { 'x-dohc-trial-key': process.env.DOHC_TRIAL_KEY } });
if (!response.ok) throw new Error(`Stats failed with ${response.status}.`);
const stats = await response.json();
const counter = (lines, name) => Number(lines.find(line => line.startsWith(`${name} `))?.split(' ')[1]);
const cell = { name: 'cell', cpuSeconds: +(counter(stats.cgroup.cpuStat, 'usage_usec') / 1e6).toFixed(2),
  memoryMiB: +(Number(stats.cgroup.memoryCurrent) / 1048576).toFixed(1), anonMiB: +(counter(stats.cgroup.memoryStat, 'anon') / 1048576).toFixed(1) };
const row = { at: new Date().toISOString(), label, uptimeMs: stats.uptimeMs, containers: [cell], relayProcesses: stats.processes, bytes: stats.bytes };
appendFileSync(output, JSON.stringify(row) + '\n');
const mib = value => (value / 1048576).toFixed(1);
console.log(label, `cell=${cell.anonMiB}MiB/${cell.cpuSeconds}s uptime=${Math.round(stats.uptimeMs / 1000)}s`,
  '| procs', stats.processes.filter(entry => !entry.command.includes('health.mjs') && entry.rssMiB > 5)
    .map(entry => `${entry.pid}:${entry.command.includes('engine') ? 'engine' : entry.command.split(' ').at(-1)}=${entry.rssMiB}MiB/${entry.cpuSeconds}s`).join(' '),
  `| data=${mib(stats.bytes['/data'])}MiB host=${mib(stats.bytes['/host-data'])}MiB`);
