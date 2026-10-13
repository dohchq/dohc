// Appends one labelled measurement of the local Compose baseline to a JSONL file:
// container memory and CPU, per-process memory inside sync-relay, and storage sizes.
// Usage: node trial/measure/snapshot.mjs <label> <output.jsonl>
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [label, output] = process.argv.slice(2);
if (!label || !output) throw new Error('Usage: snapshot.mjs <label> <output.jsonl>');
const project = process.env.PROJECT ?? 'dohc-cf-trial';
const run = (args, input) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const ids = run(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`]).split(/\s+/);
// cgroup counters: memory.current includes page cache; anon is the process-owned share.
const containers = ids.map(id => {
  const name = run(['inspect', '-f', '{{.Name}}', id]).replace(`/${project}-`, '').replace(/-1$/, '');
  const read = path => run(['exec', id, 'cat', path]);
  const cpu = Number(/usage_usec (\d+)/.exec(read('/sys/fs/cgroup/cpu.stat'))[1]) / 1e6;
  const anon = Number(/^anon (\d+)/m.exec(read('/sys/fs/cgroup/memory.stat'))[1]);
  return { name, cpuSeconds: +cpu.toFixed(2), memoryMiB: +(Number(read('/sys/fs/cgroup/memory.current')) / 1048576).toFixed(1), anonMiB: +(anon / 1048576).toFixed(1) };
});
const relay = `${project}-sync-relay-1`;
const processes = JSON.parse(run(['exec', '-i', relay, 'node', '-'], readFileSync(fileURLToPath(new URL('./procs.cjs', import.meta.url)), 'utf8'))).processes;
const sizes = JSON.parse(run(['exec', '-i', relay, 'node', '-'], `
  const fs = require('node:fs');
  const size = path => { let total = 0; for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
    const full = path + '/' + entry.name; total += entry.isDirectory() ? size(full) : fs.statSync(full).size; } return total; };
  console.log(JSON.stringify(Object.fromEntries(['/data', '/continuity', '/host-data'].map(path => [path, size(path)]))));`));
const postgres = Number(run(['exec', `${project}-postgres-1`, 'psql', '-U', 'dohc', '-d', 'dohc', '-tAc', 'select pg_database_size(current_database())']));
const row = { at: new Date().toISOString(), label, containers, relayProcesses: processes, bytes: { ...sizes, postgres } };
appendFileSync(output, JSON.stringify(row) + '\n');
const mib = value => (value / 1048576).toFixed(1);
console.log(label, containers.map(row => `${row.name}=${row.anonMiB}MiB/${row.cpuSeconds}s`).join(' '),
  '| relay', processes.filter(row => !row.command.includes('health.mjs')).map(row => `${row.pid}:${row.command.includes('engine') ? 'engine' : 'node'}=${row.rssMiB}MiB/${row.cpuSeconds}s`).join(' '),
  `| data=${mib(sizes['/data'])}MiB host=${mib(sizes['/host-data'])}MiB pg=${mib(postgres)}MiB`);
