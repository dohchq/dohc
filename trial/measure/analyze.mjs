// Derives per-unit costs from snapshot.mjs output.
// Usage: node trial/measure/analyze.mjs <baseline.jsonl>
import { readFileSync } from 'node:fs';

const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(line => JSON.parse(line));
const by = label => {
  const row = rows.find(entry => entry.label === label);
  if (!row) throw new Error(`Missing snapshot ${label}`);
  return row;
};
const container = (row, name) => row.containers.find(entry => entry.name === name);
const real = row => row.relayProcesses.filter(entry => !entry.command.includes('health.mjs'));
// The session host daemon is the engine with the most memory; the automation daemon stays near 9 MiB.
const host = row => real(row).filter(entry => entry.command.includes('engine')).sort((a, b) => b.rssMiB - a.rssMiB)[0];
const relayNode = row => real(row).find(entry => entry.command.includes('entrypoint.mjs sync-relay') && !entry.command.startsWith('/sbin'));
const seconds = (a, b) => (Date.parse(b.at) - Date.parse(a.at)) / 1000;
const mib = bytes => +(bytes / 1048576).toFixed(2);
const round = value => +value.toFixed(3);

const out = {};
for (const window of ['I0 1ws-2live', 'L4 4ws-14live', 'L8 8ws-30live', 'L16 16ws-62live']) {
  const start = rows.find(entry => entry.label === `${window} idle-start`), end = rows.find(entry => entry.label === `${window} idle-end`);
  if (!start || !end) continue;
  const elapsed = seconds(start, end);
  out[`idle ${window}`] = {
    seconds: elapsed,
    cpuCoresByContainer: Object.fromEntries(end.containers.map(entry => [entry.name, round((entry.cpuSeconds - container(start, entry.name).cpuSeconds) / elapsed)])),
    sessionHost: { rssMiB: host(end)?.rssMiB, cpuCores: host(start) && host(end) && host(start).pid === host(end).pid ? round((host(end).cpuSeconds - host(start).cpuSeconds) / elapsed) : 'restarted' },
    relayNode: { rssMiB: relayNode(end).rssMiB, cpuCores: round((relayNode(end).cpuSeconds - relayNode(start).cpuSeconds) / elapsed) },
    anonMiB: Object.fromEntries(end.containers.map(entry => [entry.name, entry.anonMiB])),
  };
}
const sync16 = by('S16 sync-only'), sync32 = by('S32 sync-only'), first = by('I0 1ws-2live idle-end');
out['per synced workspace (16 -> 32, 20 files x 4 KiB)'] = {
  relayNodeRssMiB: round((relayNode(sync32).rssMiB - relayNode(sync16).rssMiB) / 16),
  relayAnonMiB: round((container(sync32, 'sync-relay').anonMiB - container(sync16, 'sync-relay').anonMiB) / 16),
  dataMiB: round(mib(sync32.bytes['/data'] - sync16.bytes['/data']) / 16),
  postgresMiB: round(mib(sync32.bytes.postgres - sync16.bytes.postgres) / 16),
  fromFirstWorkspace: { relayNodeRssMiB: round((relayNode(sync32).rssMiB - relayNode(first).rssMiB) / 31), dataMiB: round(mib(sync32.bytes['/data'] - first.bytes['/data']) / 31) },
};
const live = [['I0 1ws-2live idle-end', 2], ['L4 4ws-14live idle-end', 14], ['L8 8ws-30live idle-end', 30], ['L16 16ws-62live idle-end', 62]]
  .filter(([label]) => rows.some(entry => entry.label === label))
  .map(([label, documents]) => { const row = by(label); return { documents, sessionHostRssMiB: host(row).rssMiB, relayNodeRssMiB: relayNode(row).rssMiB, hostDataMiB: mib(row.bytes['/host-data']) }; });
out['live documents'] = live;
if (live.length > 1) {
  const a = live[0], b = live.at(-1), span = b.documents - a.documents;
  out['per live document'] = { sessionHostRssMiB: round((b.sessionHostRssMiB - a.sessionHostRssMiB) / span),
    relayNodeRssMiB: round((b.relayNodeRssMiB - a.relayNodeRssMiB) / span), hostDataMiB: round((b.hostDataMiB - a.hostDataMiB) / span) };
}
for (const sessions of [8, 16, 32]) {
  const start = rows.find(entry => entry.label === `E${sessions} start`), end = rows.find(entry => entry.label === `E${sessions} end`);
  if (!start || !end) continue;
  const elapsed = seconds(start, end);
  const cores = Object.fromEntries(end.containers.map(entry => [entry.name, round((entry.cpuSeconds - container(start, entry.name).cpuSeconds) / elapsed)]));
  // Net of the idle rate with the same documents hosted, so polling is not charged to editors.
  const idle = out['idle L16 16ws-62live']?.cpuCoresByContainer ?? {};
  const server = ['sync-relay', 'share-web', 'workspace-api', 'postgres', 'gateway'];
  out[`editors ${sessions}`] = { seconds: elapsed, cpuCores: cores,
    serverCoresPerEditor: round(server.reduce((sum, name) => sum + cores[name] - (idle[name] ?? 0), 0) / sessions),
    sessionHostRssMiB: host(end).rssMiB, relayNodeRssMiB: relayNode(end).rssMiB };
}
console.log(JSON.stringify(out, null, 2));
