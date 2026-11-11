import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { JS_SHARDS, assertTaskCoverage } from "./shards.mjs";
import { RUST_ARCHIVE_PROOFS, RUST_POLICY_STEPS, RUST_READER_SHARD, RUST_SHARDS, RUST_TEST_PROOFS } from "./cloud-rust.mjs";

export function aggregateJavascript(records) {
  const preparation = records.filter(record => record.part === "prepare-0");
  if (preparation.length !== 1 || preparation[0].verdict !== "PASS") throw new Error("The shared JavaScript preparation did not pass.");
  const shards = records.filter(record => /^worker-\d+$/u.test(record.part));
  const expectedParts = Array.from({ length: JS_SHARDS }, (_, index) => `worker-${index}`);
  if (records.length !== expectedParts.length + 1 || shards.length !== expectedParts.length
    || expectedParts.some(part => shards.filter(record => record.part === part).length !== 1)) throw new Error("JavaScript shard evidence is missing, duplicated, or unexpected.");
  if (new Set(records.map(record => record.commit)).size !== 1) throw new Error("JavaScript parts examined different commits.");
  const inventory = [...shards[0].planned].sort();
  for (const row of shards) {
    if (JSON.stringify([...row.planned].sort()) !== JSON.stringify(inventory)) throw new Error("JavaScript worker inventories disagree.");
    if (JSON.stringify([...row.assigned].sort()) !== JSON.stringify([...row.completed].sort())) throw new Error(`Incomplete JavaScript shard ${row.part}.`);
  }
  const expected = inventory.map(id => ({ id }));
  assertTaskCoverage(expected, shards);
  if (records.filter(record => record.selfHostNative).length !== 1) throw new Error("The native delivery and restart proof did not produce its evidence.");
  return { tasks: expected.length, tests: shards.flatMap(record => record.tests), parts: records.map(({ part, seconds }) => ({ part, seconds })) };
}

export function aggregateRust(records) {
  const one = part => {
    const rows = records.filter(record => record.part === part);
    if (rows.length !== 1 || rows[0].verdict !== "PASS" || rows[0].provenance?.status !== "PASS") throw new Error(`Rust ${part} evidence did not pass.`);
    return rows[0];
  };
  const policy = one("policy");
  if (policy.steps.length !== RUST_POLICY_STEPS.length || RUST_POLICY_STEPS.some(name => policy.steps.filter(step => step.name === name && step.status === "PASS").length !== 1)) throw new Error("A required Rust policy step is missing or did not pass.");
  const archive = one("archive-0");
  if (archive.scratch?.status !== "PASS" || RUST_ARCHIVE_PROOFS.some(name => archive.steps?.filter(step => step.name === name && step.verdict === "PASS").length !== 1)) throw new Error("A required Rust archive proof is missing or did not pass.");
  const shards = Array.from({ length: RUST_SHARDS }, (_, index) => one(`tests-${index}`));
  if (RUST_TEST_PROOFS.some(name => records.flatMap(record => record.steps ?? []).filter(step => step.name === name).length !== 1
    || shards[RUST_READER_SHARD].steps?.filter(step => step.name === name && step.verdict === "PASS").length !== 1)) throw new Error("A required Rust test proof is missing, duplicated, or did not pass.");
  if (records.length !== shards.length + 2 || new Set(records.map(record => record.commit)).size !== 1) throw new Error("Rust parts examined different commits or unexpected evidence.");
  for (const shard of shards) {
    if (JSON.stringify([...shard.planned].sort()) !== JSON.stringify([...archive.planned].sort())) throw new Error("Rust inventories disagree.");
    if (JSON.stringify([...shard.assigned].sort()) !== JSON.stringify([...shard.completed].sort())) throw new Error(`Incomplete Rust shard ${shard.part}.`);
    if (shard.scratch?.status !== "PASS") throw new Error(`Rust scratch cleanup failed: ${shard.part}.`);
  }
  assertTaskCoverage(archive.planned.map(id => ({ id })), shards);
  return { tasks: archive.planned.length, steps: [...policy.steps, ...[...RUST_ARCHIVE_PROOFS, ...RUST_TEST_PROOFS].map(name => ({ name, status: "PASS" })), { name: "test --workspace", status: "PASS" }], parts: records.map(({ part, seconds }) => ({ part, seconds })) };
}

// These are workflow `needs` edges. The workflow tests compare every edge and name.
export const CLOUD_JOB_GRAPH = {
  changes: { names: ["what changed"], needs: [] },
  "javascript-prepare": { names: ["shared preparation"], needs: ["changes"] },
  confinement: { names: ["compiler and relay confinement"], needs: ["changes", "javascript-prepare"] },
  "javascript-workers": { names: Array.from({ length: JS_SHARDS - 1 }, (_, index) => `JS worker ${index + 1}`), needs: ["changes"] },
  javascript: { names: ["typecheck + tests"], needs: ["changes"] },
  "rust-archive": { names: ["Rust build once"], needs: ["changes"] },
  "rust-policy": { names: ["Rust policy checks"], needs: ["changes"] },
  "rust-tests": { names: Array.from({ length: RUST_SHARDS - 1 }, (_, index) => `Rust tests ${index + 1}`), needs: ["changes", "javascript"] },
  rust: { names: ["engine gate"], needs: ["changes", "javascript"] },
};

function gateGraph(scope, jobs, confinement = true) {
  if (!["js", "rust"].includes(scope)) throw new Error(`Unknown distributed gate ${scope}.`);
  // A combined run's Rust jobs depend on JavaScript. Include that group's waits;
  // a Rust-only dispatch skips JavaScript and has no such dependency stage.
  const javascript = scope === "js" || jobs.some(job => (job.name === "typecheck + tests" || /^JS worker /u.test(job.name)) && job.status !== "skipped" && job.conclusion !== "skipped");
  return Object.entries(CLOUD_JOB_GRAPH).filter(([id]) => id === "changes" || id === "javascript-prepare"
    || (id === "confinement" ? confinement : id.startsWith("rust") ? scope === "rust" : javascript));
}

function gateJobNames(scope, jobs, confinement = true) {
  return gateGraph(scope, jobs, confinement).flatMap(([, job]) => job.names);
}

export function gateQueueTiming(scope, jobs, now = Date.now(), confinement = true) {
  const graph = gateGraph(scope, jobs, confinement);
  const depths = new Map();
  const depth = id => {
    if (!depths.has(id)) {
      const parents = CLOUD_JOB_GRAPH[id].needs.filter(parent => graph.some(([key]) => key === parent));
      depths.set(id, parents.length ? 1 + Math.max(...parents.map(depth)) : 0);
    }
    return depths.get(id);
  };
  const stages = [], required = [];
  for (const [id, node] of graph) for (const name of node.names) {
    const rows = jobs.filter(job => job.name === name);
    if (rows.length > 1) throw new Error(`Duplicate ${scope} jobs: ${name}.`);
    if (!rows.length) continue;
    const job = rows[0], created = Date.parse(job.created_at);
    const queued = ["queued", "waiting", "pending", "requested"].includes(job.status);
    const started = queued ? now : Date.parse(job.started_at);
    if (!Number.isFinite(created) || !Number.isFinite(started) || started < created) throw new Error(`A required ${scope} job has invalid runner wait times: ${name}.`);
    const runnerWaitSeconds = (started - created) / 1000;
    const stage = depth(id);
    stages[stage] ??= { stage, runnerWaitSeconds: 0, jobs: [] };
    stages[stage].jobs.push(name);
    stages[stage].runnerWaitSeconds = Math.max(stages[stage].runnerWaitSeconds, runnerWaitSeconds);
    required.push({ ...job, stage, runnerWaitSeconds, queued });
  }
  return { runnerWaitSeconds: stages.reduce((total, stage) => total + stage.runnerWaitSeconds, 0), stages, jobs: required };
}

export function gateDeadline(scope, jobs, now = Date.now()) {
  const selections = jobs.filter(job => job.name === "what changed");
  if (selections.length !== 1 || !Number.isFinite(Date.parse(selections[0].started_at))) throw new Error("Gate selection has no unique start time.");
  const timing = gateQueueTiming(scope, jobs, now);
  return Date.parse(selections[0].started_at) + ((scope === "js" ? 300 : 600) + timing.runnerWaitSeconds) * 1000;
}

function gateTiming(scope, required, finishedAt, queue) {
  if (required.some(job => !Number.isFinite(Date.parse(job.started_at)) || !Number.isFinite(Date.parse(job.completed_at))
    || Date.parse(job.completed_at) < Date.parse(job.started_at))) throw new Error(`A completed ${scope} job has invalid times.`);
  const startedAt = new Date(Math.min(...required.map(job => Date.parse(job.started_at)))).toISOString();
  const seconds = (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
  const budgetSeconds = scope === "js" ? 300 : 600;
  const workloadSeconds = seconds - queue.runnerWaitSeconds;
  return { startedAt, finishedAt, seconds, budgetSeconds, runnerWaitSeconds: queue.runnerWaitSeconds, workloadSeconds,
    stages: queue.stages, jobs: queue.jobs.map(({ name, created_at, started_at, completed_at, conclusion, stage, runnerWaitSeconds }) =>
      ({ name, createdAt: created_at, startedAt: started_at, finishedAt: completed_at, conclusion, stage, runnerWaitSeconds })),
    withinBudget: seconds <= budgetSeconds || workloadSeconds <= budgetSeconds };
}

function requireBudget(scope, timing) {
  if (!timing.withinBudget) throw Object.assign(new Error(`The complete ${scope} gate took ${timing.seconds}s (${timing.workloadSeconds}s after ${timing.runnerWaitSeconds}s runner wait), exceeding its ${timing.budgetSeconds}s budget including final reporting.`), { timing });
  return timing;
}

export function completedGateTiming(scope, jobs, commit) {
  const expected = gateJobNames(scope, jobs);
  const required = jobs.filter(job => expected.includes(job.name));
  if (!commit || required.length !== expected.length || expected.some(name => required.filter(job => job.name === name).length !== 1)
    || required.some(job => job.status !== "completed" || job.conclusion !== "success" || job.head_sha !== commit)) {
    throw new Error(`A completed ${scope} job is missing, unsuccessful, or from another commit.`);
  }
  const finishedAt = new Date(Math.max(...required.map(job => Date.parse(job.completed_at)))).toISOString();
  return requireBudget(scope, gateTiming(scope, required, finishedAt, gateQueueTiming(scope, jobs)));
}

export async function verifyCompletedCloud(scope) {
  const report = { version: 1, scope, verdict: "FAIL", complete: true, commit: process.env.DOHC_WORKFLOW_HEAD_SHA };
  try {
    Object.assign(report, completedGateTiming(scope, await jobs(), report.commit));
    report.verdict = "PASS";
  } catch (error) {
    Object.assign(report, error.timing, { error: error.message });
    throw error;
  } finally {
    mkdirSync(".agent-artifacts/verification/aggregate", { recursive: true });
    writeFileSync(`.agent-artifacts/verification/aggregate/${scope}-completed-result.json`, JSON.stringify(report, null, 2) + "\n");
    console.log(`[verification] ${report.verdict} (${scope} completed group): ${JSON.stringify(report)}`);
  }
}

async function jobs() {
  const result = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Cannot read workflow job times: HTTP ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data.jobs)) throw new Error("Missing workflow jobs.");
    result.push(...data.jobs);
    if (data.jobs.length < 100) return result;
  }
}

// The reporting job runs partition zero before waiting for the other workers.
export async function waitForGate(scope, { readJobs = jobs, pause = setTimeout, now = Date.now } = {}) {
  const finalJob = scope === "js" ? "typecheck + tests" : "engine gate";
  for (;;) {
    const all = await readJobs();
    const expected = gateJobNames(scope, all, false).filter(name => name !== finalJob);
    const required = all.filter(job => expected.includes(job.name));
    if (expected.some(name => required.filter(job => job.name === name).length > 1)) throw new Error(`Duplicate ${scope} jobs.`);
    if (required.some(job => job.status === "completed" && job.conclusion !== "success")) throw new Error(`A required ${scope} job did not finish successfully.`);
    const remaining = gateDeadline(scope, all, now()) - now();
    const queued = required.some(job => ["queued", "waiting", "pending", "requested"].includes(job.status));
    if (remaining <= 0 && !queued) throw new Error(`The ${scope} group has no time left for complete reporting within its budget.`);
    if (required.length === expected.length && required.every(job => job.status === "completed" && job.conclusion === "success")) return;
    await pause(queued ? 10_000 : Math.min(5_000, remaining));
  }
}

export async function aggregateCloud(scope, directory = ".agent-artifacts/verification/downloaded", { readJobs = jobs, now = Date.now, env = process.env, outputDirectory = ".agent-artifacts/verification/aggregate" } = {}) {
  const report = { version: 1, scope, verdict: "FAIL", complete: false, steps: [] };
  try {
    const records = [...globSync(`${directory}/**/result.json`)].map(path => JSON.parse(readFileSync(path, "utf8"))).filter(record => record.scope === scope);
    if (!["js", "rust"].includes(scope)) throw new Error(`Unknown distributed gate ${scope}.`);
    if (!env.GITHUB_SHA || records.some(record => record.commit !== env.GITHUB_SHA)) throw new Error("The gate evidence does not cover the requested commit.");
    report.commit = env.GITHUB_SHA;
    Object.assign(report, scope === "js" ? aggregateJavascript(records) : aggregateRust(records));
    const finalJob = scope === "js" ? "typecheck + tests" : "engine gate";
    const all = await readJobs();
    const expected = gateJobNames(scope, all, false);
    const required = all.filter(job => expected.includes(job.name));
    if (required.length !== expected.length || expected.some(name => required.filter(job => job.name === name).length !== 1)
      || required.some(job => job.name !== finalJob && (job.status !== "completed" || job.conclusion !== "success"))) throw new Error(`A required ${scope} job is missing or did not finish successfully.`);
    const finishedAt = new Date(now()).toISOString();
    Object.assign(report, gateTiming(scope, required.map(job => job.name === finalJob ? { ...job, completed_at: finishedAt } : job), finishedAt, gateQueueTiming(scope, all, now())));
    requireBudget(scope, report);
    report.verdict = "PASS";
    return report;
  } catch (error) { report.error = error.message; throw error; }
  finally {
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(`${outputDirectory}/${scope}-result.json`, JSON.stringify(report, null, 2) + "\n");
    if (scope === "rust") {
      console.log("\n== summary ==");
      for (const step of report.steps) console.log(`  ${step.status} ${step.name}`);
      console.log(`  ${report.verdict} complete gate${report.error ? `: ${report.error}` : ""}`);
    }
    console.log(`[verification] ${report.verdict} (${scope}): ${report.seconds ?? "unknown"}s wall, ${report.runnerWaitSeconds ?? "unknown"}s runner wait, ${report.workloadSeconds ?? "unknown"}s workload, ${report.tasks ?? 0} tasks`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const action = process.argv[2] === "wait" ? waitForGate(process.argv[3]) : aggregateCloud(process.argv[2]);
  action.catch(error => { console.error(error); process.exitCode = 1; });
}
