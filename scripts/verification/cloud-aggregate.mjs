import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { cloudApi, GATE_POLL_MS, QUEUED_STATUSES } from "./cloud-api.mjs";
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
  "confinement-compiler": { names: ["compiler confinement"], needs: ["changes", "javascript-prepare"] },
  "confinement-relay": { names: ["relay confinement"], needs: ["changes", "javascript-prepare"] },
  "javascript-workers": { names: Array.from({ length: JS_SHARDS - 1 }, (_, index) => `JS worker ${index + 1}`), needs: ["changes"] },
  javascript: { names: ["typecheck + tests"], needs: ["changes"] },
  "rust-archive": { names: ["Rust build once"], needs: ["changes"] },
  "rust-policy": { names: ["Rust policy checks"], needs: ["changes"] },
  "rust-tests": { names: Array.from({ length: RUST_SHARDS - 1 }, (_, index) => `Rust tests ${index + 1}`), needs: ["changes", "javascript"] },
  rust: { names: ["engine gate"], needs: ["changes", "javascript"] },
};

function gateJobNames(scope) {
  if (!["js", "rust"].includes(scope)) throw new Error(`Unknown distributed gate ${scope}.`);
  return Object.entries(CLOUD_JOB_GRAPH).filter(([id]) => id === "changes" || id === "javascript-prepare"
    || (scope === "rust" ? id.startsWith("rust") : id.startsWith("javascript"))).flatMap(([, node]) => node.names);
}

const confinementNames = Object.entries(CLOUD_JOB_GRAPH).filter(([id]) => id.startsWith("confinement-")).flatMap(([, job]) => job.names);

function gateTiming(scope, required, confinement = []) {
  const all = [...required, ...confinement];
  if (all.some(job => ![job.created_at, job.started_at, job.completed_at].every(time => Number.isFinite(Date.parse(time)))
    || Date.parse(job.completed_at) < Date.parse(job.started_at))) throw new Error(`A completed ${scope} job has invalid times.`);
  const start = Date.parse(required.find(job => job.name === "what changed").started_at);
  const spanSeconds = (Math.max(...required.map(job => Date.parse(job.completed_at))) - start) / 1000;
  const confinementSeconds = confinement.length ? (Date.parse(required.find(job => job.name === "shared preparation").completed_at) - start
    + Math.max(...confinement.map(job => Date.parse(job.completed_at) - Date.parse(job.started_at)))) / 1000 : null;
  const jobs = all.map(({ name, created_at, started_at, completed_at, conclusion }) => ({ name, createdAt: created_at,
    startedAt: started_at, finishedAt: completed_at, conclusion, runnerWaitSeconds: Math.max(0, (Date.parse(started_at) - Date.parse(created_at)) / 1000) }));
  const longest = jobs.filter(job => !confinementNames.includes(job.name)).reduce((a, b) => a.runnerWaitSeconds > b.runnerWaitSeconds ? a : b);
  const contended = longest.runnerWaitSeconds > 30, seconds = Math.max(spanSeconds, confinementSeconds ?? 0);
  const budgetSeconds = scope === "js" ? 300 : 600;
  const timing = seconds <= budgetSeconds ? "within budget" : contended ? "unmeasured" : "over budget";
  return { spanSeconds, confinementSeconds, seconds, budgetSeconds, contended, timing, jobs,
    ...(timing === "unmeasured" ? { warning: `${scope} timing unmeasured: ${seconds}s exceeds the ${budgetSeconds}s budget; longest runner wait ${longest.name}: ${longest.runnerWaitSeconds}s.` } : {}) };
}

function requireBudget(scope, timing) {
  if (timing.timing === "over budget") throw Object.assign(new Error(`The complete ${scope} gate took ${timing.seconds}s, exceeding its ${timing.budgetSeconds}s budget including final reporting.`), { timing });
  if (timing.warning) console.warn(`::warning::${timing.warning}`);
  return timing;
}

export function completedGateTiming(scope, jobs, commit) {
  const expected = [...gateJobNames(scope), ...confinementNames];
  const required = jobs.filter(job => expected.includes(job.name));
  if (!commit || required.length !== expected.length || expected.some(name => required.filter(job => job.name === name).length !== 1)
    || required.some(job => job.status !== "completed" || job.conclusion !== "success" || job.head_sha !== commit)) {
    throw new Error(`A completed ${scope} job is missing, unsuccessful, or from another commit.`);
  }
  return requireBudget(scope, gateTiming(scope, required.filter(job => !confinementNames.includes(job.name)),
    required.filter(job => confinementNames.includes(job.name))));
}

export async function verifyCompletedCloud(scope) {
  const report = { version: 1, scope, verdict: "FAIL", complete: true, commit: process.env.DOHC_WORKFLOW_HEAD_SHA };
  try {
    Object.assign(report, completedGateTiming(scope, await cloudApi().jobs(), report.commit));
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

// Partition zero publishes its own receipt before joining the other workers.
export async function waitForGate(scope, { readJobs, pause = setTimeout, now = Date.now, ...options } = {}) {
  const api = cloudApi(options), deadline = now() + 20 * 60_000;
  const expected = gateJobNames(scope).filter(name => name !== (scope === "js" ? "typecheck + tests" : "engine gate"));
  try {
    for (;;) {
      const required = (await (readJobs ? readJobs() : api.jobs())).filter(job => expected.includes(job.name));
      if (expected.some(name => required.filter(job => job.name === name).length > 1)) throw new Error(`Duplicate ${scope} jobs.`);
      if (required.some(job => job.status === "completed" && job.conclusion !== "success")) throw new Error(`A required ${scope} job did not finish successfully.`);
      if (now() >= deadline) throw new Error(`The ${scope} group exceeded its 20-minute wait cap; awaited jobs ${required.some(job => QUEUED_STATUSES.includes(job.status)) ? "still queued for a runner" : required.some(job => job.status === "in_progress") ? "still running" : "missing"}.`);
      if (required.length === expected.length && required.every(job => job.status === "completed" && job.conclusion === "success")) return;
      await pause(Math.min(GATE_POLL_MS[scope], deadline - now()));
    }
  } finally { api.log(`${scope} group wait`); }
}

export async function aggregateCloud(scope, directory = ".agent-artifacts/verification/downloaded", { readJobs = () => cloudApi().jobs(), now = Date.now, env = process.env, outputDirectory = ".agent-artifacts/verification/aggregate" } = {}) {
  const report = { version: 1, scope, verdict: "FAIL", complete: false, steps: [] };
  try {
    const records = [...globSync(`${directory}/**/result.json`)].map(path => JSON.parse(readFileSync(path, "utf8"))).filter(record => record.scope === scope);
    if (!["js", "rust"].includes(scope)) throw new Error(`Unknown distributed gate ${scope}.`);
    if (!env.GITHUB_SHA || records.some(record => record.commit !== env.GITHUB_SHA)) throw new Error("The gate evidence does not cover the requested commit.");
    report.commit = env.GITHUB_SHA;
    Object.assign(report, scope === "js" ? aggregateJavascript(records) : aggregateRust(records));
    const finalJob = scope === "js" ? "typecheck + tests" : "engine gate";
    const all = await readJobs();
    const expected = gateJobNames(scope);
    const required = all.filter(job => expected.includes(job.name));
    if (required.length !== expected.length || expected.some(name => required.filter(job => job.name === name).length !== 1)
      || required.some(job => job.name !== finalJob && (job.status !== "completed" || job.conclusion !== "success"))) throw new Error(`A required ${scope} job is missing or did not finish successfully.`);
    const finishedAt = new Date(now()).toISOString();
    Object.assign(report, gateTiming(scope, required.map(job => job.name === finalJob ? { ...job, completed_at: finishedAt } : job)));
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
    console.log(`[verification] ${report.verdict} (${scope}): ${report.seconds ?? "unknown"}s (${report.timing ?? "unavailable"}), ${report.tasks ?? 0} tasks`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const action = process.argv[2] === "wait" ? waitForGate(process.argv[3]) : aggregateCloud(process.argv[2]);
  action.catch(error => { console.error(error); process.exitCode = 1; });
}
