// Monthly cost per 1,000 accounts for options A, B (two shapes), and C, from
// published prices (fetched 2026-10-13) and the trial's measurements.
// Usage: node trial/measure/cost.mjs [measurements.json]   (defaults are the trial's measured values)
import { readFileSync } from 'node:fs';

const MONTH_S = 30 * 86400;
const price = {
  // Cloudflare Workers Paid, https://developers.cloudflare.com/containers/platform/pricing/ and siblings.
  plan: 5,
  containerMemGiBs: 0.0000025, containerVcpuS: 0.000020, containerDiskGBs: 0.00000007,
  includedMemGiBs: 25 * 3600, includedVcpuS: 375 * 60, includedDiskGBs: 200 * 3600,
  workerRequestsPerM: 0.30, includedWorkerRequests: 10e6,
  doRequestsPerM: 0.15, includedDoRequests: 1e6,
  doGBs: 12.5 / 1e6, includedDoGBs: 400_000, doMemGB: 0.128,
  doSqlGBMonth: 0.20, includedDoSqlGB: 5, doRowsWrittenPerM: 1.0, includedRowsWritten: 50e6,
  r2GBMonth: 0.015, includedR2GB: 10, r2ClassAPerM: 4.5, r2ClassBPerM: 0.36,
  // Hetzner CPX32 (4 vCPU, 8 GB) after the 2026-06-15 price change, from the handoff.
  hetznerCpx32: 41.99,
  instances: { lite: [1 / 16, 0.25, 2], basic: [0.25, 1, 4], 'standard-1': [0.5, 4, 8], 'standard-2': [1, 6, 12], 'standard-3': [2, 8, 16], 'standard-4': [4, 12, 20] },
};

const measured = {
  // Local baseline, per unit (baseline-analysis.json).
  relayMiBPerSyncedWorkspace: 1.0, relayMiBPerLiveDoc: 2.2, hostMiBPerLiveDoc: 0.96, emptyServerMiB: 350,
  // Cloudflare single cell idle (cf.jsonl); replaced by the scenario's numbers when supplied.
  cellIdleVcpu: 0.6, cellIdleMiB: 600,
  // Per-workspace container (relay + session host), measured in step 5.
  workspaceIdleVcpuHosted: 0.1, workspaceIdleVcpuUnhosted: 0.01,
  // Session host log polls through the public origin, per hosted workspace.
  hairpinRequestsPerS: 1,
  ...(process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : {}),
};

const profile = {
  accounts: 1000, workspacesPerAccount: 1,
  activeShareDaily: 0.10, awakeHoursPerActiveDay: 2, sleepTailHours: 10 / 60,
  hostedShare: 0.10, // workspaces with a live share hosted by the server
  docsPerHostedWorkspace: 4, storageGBPerWorkspace: 0.05,
  requestsPerActiveHour: 3600, // desktop sync and API calls through the edge while active
};

const workspaces = profile.accounts * profile.workspacesPerAccount;
const hosted = workspaces * profile.hostedShare;
const activeDays = workspaces * profile.activeShareDaily * 30;
const over = (used, included) => Math.max(0, used - included);
const container = (type, seconds, vcpuBusy) => {
  const [, mem, disk] = price.instances[type];
  return { memGiBs: mem * seconds, vcpuS: vcpuBusy * seconds, diskGBs: disk * seconds };
};
const sum = rows => rows.reduce((a, b) => ({ memGiBs: a.memGiBs + b.memGiBs, vcpuS: a.vcpuS + b.vcpuS, diskGBs: a.diskGBs + b.diskGBs }), { memGiBs: 0, vcpuS: 0, diskGBs: 0 });
const containerCost = usage => over(usage.memGiBs, price.includedMemGiBs) * price.containerMemGiBs
  + over(usage.vcpuS, price.includedVcpuS) * price.containerVcpuS + over(usage.diskGBs, price.includedDiskGBs) * price.containerDiskGBs;
const requestCost = (workerRequests, doRequests) => over(workerRequests, price.includedWorkerRequests) / 1e6 * price.workerRequestsPerM
  + over(doRequests, price.includedDoRequests) / 1e6 * price.doRequestsPerM;
const doDurationCost = seconds => over(seconds * price.doMemGB, price.includedDoGBs) * price.doGBs;
const r2Cost = gb => over(gb, price.includedR2GB) * price.r2GBMonth;
const round = value => Math.round(value * 100) / 100;

const storageGB = workspaces * profile.storageGBPerWorkspace;
const activeRequests = activeDays * profile.awakeHoursPerActiveDay * profile.requestsPerActiveHour;
const hairpin = hosted * measured.hairpinRequestsPerS * MONTH_S;

// A: one Hetzner server holds the whole set while memory and the session host caps allow.
const liveDocs = hosted * profile.docsPerHostedWorkspace;
const aMemoryMiB = measured.emptyServerMiB + workspaces * measured.relayMiBPerSyncedWorkspace
  + liveDocs * (measured.relayMiBPerLiveDoc + measured.hostMiBPerLiveDoc);
const a = { monthly: price.hetznerCpx32 + r2Cost(storageGB), memoryMiB: Math.round(aMemoryMiB), liveDocs,
  note: liveDocs > 64 ? `needs ${Math.ceil(liveDocs / 64)} session hosts at today's 64-document cap` : 'fits one session host' };

// B1: one big always-on cell (hosting keeps it awake).
const b1Usage = container('standard-2', MONTH_S, measured.cellIdleVcpu);
const b1 = { monthly: price.plan + containerCost(b1Usage) + requestCost(activeRequests + hairpin, activeRequests + hairpin)
  + doDurationCost(MONTH_S) + r2Cost(storageGB) };

// B2: one basic container per workspace. Hosted workspaces never sleep while the session host polls through the edge.
const b2Hosted = container('basic', MONTH_S, measured.workspaceIdleVcpuHosted);
const unhostedSeconds = activeDays * (profile.awakeHoursPerActiveDay + profile.sleepTailHours) * 3600 * (1 - profile.hostedShare);
const b2Active = container('basic', unhostedSeconds, measured.workspaceIdleVcpuUnhosted);
const b2HomeCell = container('standard-1', MONTH_S, measured.cellIdleVcpu / 2);
const b2Usage = sum([...Array(hosted).fill(b2Hosted), b2Active, b2HomeCell]);
const b2 = { monthly: price.plan + containerCost(b2Usage) + requestCost(activeRequests + hairpin, activeRequests + hairpin)
  + doDurationCost(hosted * MONTH_S + unhostedSeconds + MONTH_S) + r2Cost(storageGB) };
// B2 with a loopback relay URL for the session host: hosted containers still stay awake (their own process),
// but polls leave the Worker and Durable Object bills.
const b2Loopback = { monthly: b2.monthly - (requestCost(activeRequests + hairpin, activeRequests + hairpin) - requestCost(activeRequests, activeRequests)) };

// C: relay as Workers and Durable Objects with SQLite storage and hibernating WebSockets (paper only).
const cRowsWritten = activeDays * profile.awakeHoursPerActiveDay * 3600 * 0.5; // one row per two seconds of activity
const c = { monthly: price.plan + requestCost(activeRequests, activeRequests) + over(storageGB, price.includedDoSqlGB) * price.doSqlGBMonth
  + over(cRowsWritten, price.includedRowsWritten) / 1e6 * price.doRowsWrittenPerM
  + doDurationCost(activeDays * profile.awakeHoursPerActiveDay * 3600 * 0.1),
  note: 'excludes the session host: settlement runs in the Rust engine, which a Durable Object cannot run' };

console.log(JSON.stringify({ profile, measured, results: {
  A: { ...a, monthly: round(a.monthly) },
  'B1 single cell': { monthly: round(b1.monthly) },
  'B2 container per workspace': { monthly: round(b2.monthly), hostedWorkspaces: hosted, hairpinRequests: Math.round(hairpin) },
  'B2 with loopback session host': { monthly: round(b2Loopback.monthly) },
  C: { ...c, monthly: round(c.monthly) },
} }, null, 2));
