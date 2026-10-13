// Monthly cost per 1,000 accounts for options A, B, and C under one stated activity
// profile, from published prices (fetched 2026-10-13) and the trial's measurements.
// Usage: node trial/measure/cost.mjs
const MONTH_S = 30 * 86400;
const HOUR_S = 3600;

// Cloudflare Workers Paid: containers/platform/pricing, durable-objects/platform/pricing,
// workers/platform/pricing, r2/pricing. Hetzner CPX32 after 2026-06-15, from the handoff.
const price = {
  plan: 5,
  memGiBs: 0.0000025, vcpuS: 0.000020, diskGBs: 0.00000007,
  includedMemGiBs: 25 * HOUR_S, includedVcpuS: 375 * 60, includedDiskGBs: 200 * HOUR_S,
  workerRequest: 0.30 / 1e6, includedWorkerRequests: 10e6,
  doRequest: 0.15 / 1e6, includedDoRequests: 1e6,
  doGBs: 12.5 / 1e6, includedDoGBs: 400_000, doMemGB: 0.128,
  doSqlGBMonth: 0.20, includedDoSqlGB: 5,
  r2GBMonth: 0.015, includedR2GB: 10,
  hetznerCpx32: 41.99,
  instance: { basic: { mem: 1, disk: 4 }, 'standard-1': { mem: 4, disk: 8 }, 'standard-2': { mem: 6, disk: 12 } },
};

// Measured in this trial (see the findings note for sources).
const measured = {
  serverIdleMiB: 350, relayMiBPerWorkspace: 1.0, relayMiBPerLiveDoc: 2.9, hostMiBPerLiveDoc: 0.96,
  cellIdleVcpu: 0.25,               // single Cloudflare cell, 16 hosted workspaces
  hairpinPerHostedSingleCell: 0.36, // log polls per second per hosted workspace, one shared daemon
  hairpinPerHostedOwnDaemon: 4.0,   // log polls per second, one daemon per workspace container
  hostedWorkspaceVcpu: 0.21,        // idle hosted workspace container (basic)
  homeCellVcpu: 0.05,               // home cell with no hosting (accounts, share-web)
};

// Stated activity profile.
const profile = {
  accounts: 1000, workspacesPerAccount: 1,
  activeDailyShare: 0.10, awakeHoursPerActiveDay: 2, sleepAfterHours: 10 / 60,
  activeVcpu: 0.05,                 // workspace container while people work (unmeasured; editors cost 0.005-0.016 vCPU each)
  hostedShare: 0.10, docsPerHostedWorkspace: 4,
  storageGBPerWorkspace: 0.05,
  clientRequestsPerActiveHour: 3600,
};

const workspaces = profile.accounts * profile.workspacesPerAccount;
const hosted = workspaces * profile.hostedShare;
const activeWorkspaceDays = workspaces * profile.activeDailyShare * 30;
const awakeSecondsPerActiveDay = (profile.awakeHoursPerActiveDay + profile.sleepAfterHours) * HOUR_S;
const clientRequests = activeWorkspaceDays * profile.awakeHoursPerActiveDay * profile.clientRequestsPerActiveHour;
const storageGB = workspaces * profile.storageGBPerWorkspace;

const over = (used, included) => Math.max(0, used - included);
const usage = (type, seconds, vcpu) => ({ memGiBs: price.instance[type].mem * seconds, vcpuS: vcpu * seconds, diskGBs: price.instance[type].disk * seconds });
const add = (...rows) => rows.reduce((a, b) => ({ memGiBs: a.memGiBs + b.memGiBs, vcpuS: a.vcpuS + b.vcpuS, diskGBs: a.diskGBs + b.diskGBs }));
const containers = u => ({
  memory: over(u.memGiBs, price.includedMemGiBs) * price.memGiBs,
  cpu: over(u.vcpuS, price.includedVcpuS) * price.vcpuS,
  disk: over(u.diskGBs, price.includedDiskGBs) * price.diskGBs,
});
const requests = count => ({ workerRequests: over(count, price.includedWorkerRequests) * price.workerRequest, doRequests: over(count, price.includedDoRequests) * price.doRequest });
// Assumption: a container's Durable Object is billed for duration while its container runs.
const doDuration = seconds => ({ doDuration: over(seconds * price.doMemGB, price.includedDoGBs) * price.doGBs });
const r2 = { r2: over(storageGB, price.includedR2GB) * price.r2GBMonth };
const total = parts => Math.round(Object.values(parts).reduce((a, b) => a + b, 0) * 100) / 100;
const rounded = parts => Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, Math.round(value * 100) / 100]));

// A: one Hetzner server runs the release; nightly and continuous backups to R2.
const liveDocs = hosted * profile.docsPerHostedWorkspace;
const aMemoryGiB = (measured.serverIdleMiB + workspaces * measured.relayMiBPerWorkspace
  + liveDocs * (measured.relayMiBPerLiveDoc + measured.hostMiBPerLiveDoc)) / 1024;
const A = { server: price.hetznerCpx32, ...r2 };

// B1: the same single cell as one Cloudflare container. Any hosted workspace keeps it awake.
const b1Hairpin = hosted * measured.hairpinPerHostedSingleCell * MONTH_S;
const B1 = { plan: price.plan, ...containers(usage('standard-2', MONTH_S, measured.cellIdleVcpu)),
  ...requests(clientRequests + b1Hairpin), ...doDuration(MONTH_S), ...r2 };

// B2: one basic container per workspace, as measured. Hosted workspaces never sleep.
const unhostedSeconds = activeWorkspaceDays * (1 - profile.hostedShare) * awakeSecondsPerActiveDay;
const b2Hairpin = hosted * measured.hairpinPerHostedOwnDaemon * MONTH_S;
const B2 = { plan: price.plan, ...containers(add(
    usage('basic', hosted * MONTH_S, measured.hostedWorkspaceVcpu),
    usage('basic', unhostedSeconds, profile.activeVcpu),
    usage('standard-1', MONTH_S, measured.homeCellVcpu))),
  ...requests(clientRequests + b2Hairpin), ...doDuration(hosted * MONTH_S + unhostedSeconds + MONTH_S), ...r2 };

// B2 after release changes: the session host reaches its relay over loopback and long-polls,
// so hosted workspaces sleep like any other when nobody is working.
const allActiveSeconds = activeWorkspaceDays * awakeSecondsPerActiveDay;
const B2fixed = { plan: price.plan, ...containers(add(
    usage('basic', allActiveSeconds, profile.activeVcpu),
    usage('standard-1', MONTH_S, measured.homeCellVcpu))),
  ...requests(clientRequests), ...doDuration(allActiveSeconds + MONTH_S), ...r2 };

// C (paper): relay rewritten as one Durable Object per workspace with SQLite storage and
// hibernating WebSockets. Live hosting still needs the Rust engine, so hosted documents
// run in B2-fixed containers.
const hostedActiveSeconds = activeWorkspaceDays * profile.hostedShare * awakeSecondsPerActiveDay;
const C = { plan: price.plan, ...requests(clientRequests), doStorage: over(storageGB, price.includedDoSqlGB) * price.doSqlGBMonth,
  ...doDuration(activeWorkspaceDays * profile.awakeHoursPerActiveDay * HOUR_S * 0.1),
  sessionHostContainers: total(containers(usage('basic', hostedActiveSeconds, profile.activeVcpu))) };

console.log(JSON.stringify({
  profile, measured,
  derived: { workspaces, hosted, liveDocs, activeWorkspaceDays, clientRequests, storageGB, aMemoryGiB: +aMemoryGiB.toFixed(2),
    b1HairpinRequests: Math.round(b1Hairpin), b2HairpinRequests: Math.round(b2Hairpin) },
  monthlyUsd: {
    'A Hetzner CPX32': { total: total(A), ...rounded(A) },
    'B1 one Cloudflare cell': { total: total(B1), ...rounded(B1) },
    'B2 container per workspace (measured)': { total: total(B2), ...rounded(B2) },
    'B2 after session host changes': { total: total(B2fixed), ...rounded(B2fixed) },
    'C relay as Durable Objects (paper)': { total: total(C), ...rounded(C) },
  },
}, null, 2));
