import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { JS_SHARDS, assertTaskCoverage } from "./shards.mjs";
import { RUST_ARCHIVE_PROOFS, RUST_POLICY_STEPS, RUST_SHARDS, RUST_TEST_PROOFS } from "./cloud-rust.mjs";

export function aggregateJavascript(records) {
  const preparation = records.filter(record => record.part === "prepare-0");
  if (preparation.length !== 1 || preparation[0].verdict !== "PASS") throw new Error("The shared JavaScript preparation did not pass.");
  const shards = records.filter(record => /^(pure|native)-\d+$/u.test(record.part));
  const expectedParts = ["pure", "native"].flatMap(part => Array.from({ length: JS_SHARDS }, (_, index) => `${part}-${index}`));
  if (records.length !== expectedParts.length + 1 || shards.length !== expectedParts.length
    || expectedParts.some(part => shards.filter(record => record.part === part).length !== 1)) throw new Error("JavaScript shard evidence is missing, duplicated, or unexpected.");
  if (new Set(records.map(record => record.commit)).size !== 1) throw new Error("JavaScript parts examined different commits.");
  const expected = [];
  for (const part of ["pure", "native"]) {
    const parts = shards.filter(record => record.part.startsWith(`${part}-`));
    const inventory = [...parts[0].planned].sort();
    for (const row of parts) if (JSON.stringify([...row.planned].sort()) !== JSON.stringify(inventory)) throw new Error(`JavaScript ${part} inventories disagree.`);
    expected.push(...inventory.map(id => ({ id })));
    for (const row of parts) if (JSON.stringify([...row.assigned].sort()) !== JSON.stringify([...row.completed].sort())) throw new Error(`Incomplete JavaScript shard ${row.part}.`);
  }
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
  if (RUST_TEST_PROOFS.some(name => shards.flatMap(shard => shard.steps ?? []).filter(step => step.name === name).length !== 1
    || shards[0].steps?.filter(step => step.name === name && step.verdict === "PASS").length !== 1)) throw new Error("A required Rust test proof is missing, duplicated, or did not pass.");
  if (records.length !== shards.length + 2 || new Set(records.map(record => record.commit)).size !== 1) throw new Error("Rust parts examined different commits or unexpected evidence.");
  for (const shard of shards) {
    if (JSON.stringify([...shard.planned].sort()) !== JSON.stringify([...archive.planned].sort())) throw new Error("Rust inventories disagree.");
    if (JSON.stringify([...shard.assigned].sort()) !== JSON.stringify([...shard.completed].sort())) throw new Error(`Incomplete Rust shard ${shard.part}.`);
    if (shard.scratch?.status !== "PASS") throw new Error(`Rust scratch cleanup failed: ${shard.part}.`);
  }
  assertTaskCoverage(archive.planned.map(id => ({ id })), shards);
  return { tasks: archive.planned.length, steps: [...policy.steps, ...[...RUST_ARCHIVE_PROOFS, ...RUST_TEST_PROOFS].map(name => ({ name, status: "PASS" })), { name: "test --workspace", status: "PASS" }], parts: records.map(({ part, seconds }) => ({ part, seconds })) };
}

function gateJobNames(scope) {
  if (!["js", "rust"].includes(scope)) throw new Error(`Unknown distributed gate ${scope}.`);
  return ["what changed", "confinement", ...(scope === "js"
    ? ["typecheck + tests", "JS shared preparation", ...["pure", "native"].flatMap(part => Array.from({ length: JS_SHARDS }, (_, index) => `JS ${part} ${index}`))]
    : ["engine gate", "Rust build once", "Rust policy checks", ...Array.from({ length: RUST_SHARDS }, (_, index) => `Rust tests ${index}`)])];
}

export function completedGateTiming(scope, jobs, commit) {
  const expected = gateJobNames(scope);
  const required = jobs.filter(job => expected.includes(job.name));
  if (!commit || required.length !== expected.length || expected.some(name => required.filter(job => job.name === name).length !== 1)
    || required.some(job => job.status !== "completed" || job.conclusion !== "success" || job.head_sha !== commit)) {
    throw new Error(`A completed ${scope} job is missing, unsuccessful, or from another commit.`);
  }
  if (required.some(job => !Number.isFinite(Date.parse(job.started_at)) || !Number.isFinite(Date.parse(job.completed_at))
    || Date.parse(job.completed_at) < Date.parse(job.started_at))) throw new Error(`A completed ${scope} job has invalid times.`);
  const startedAt = new Date(Math.min(...required.map(job => Date.parse(job.started_at)))).toISOString();
  const finishedAt = new Date(Math.max(...required.map(job => Date.parse(job.completed_at)))).toISOString();
  const seconds = (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
  const budgetSeconds = scope === "js" ? 300 : 600;
  if (seconds > budgetSeconds) throw new Error(`The complete ${scope} gate took ${seconds}s, exceeding its ${budgetSeconds}s budget including final reporting.`);
  return { startedAt, finishedAt, seconds, budgetSeconds };
}

export async function verifyCompletedCloud(scope) {
  const timing = completedGateTiming(scope, await jobs(), process.env.DOHC_WORKFLOW_HEAD_SHA);
  console.log(`[verification] PASS (${scope} completed group): ${JSON.stringify(timing)}`);
}

async function jobs() {
  const result = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`Cannot read workflow job times: HTTP ${response.status}.`);
    const data = await response.json();
    if (!Array.isArray(data.jobs)) throw new Error("Missing workflow jobs.");
    result.push(...data.jobs);
    if (data.jobs.length < 100) return result;
  }
}

export async function aggregateCloud(scope, directory = ".agent-artifacts/verification/downloaded") {
  const report = { version: 1, scope, verdict: "FAIL", steps: [] };
  try {
    const records = [...globSync(`${directory}/**/result.json`)].map(path => JSON.parse(readFileSync(path, "utf8"))).filter(record => record.scope === scope);
    if (!["js", "rust"].includes(scope)) throw new Error(`Unknown distributed gate ${scope}.`);
    if (!process.env.GITHUB_SHA || records.some(record => record.commit !== process.env.GITHUB_SHA)) throw new Error("The gate evidence does not cover the requested commit.");
    report.commit = process.env.GITHUB_SHA;
    Object.assign(report, scope === "js" ? aggregateJavascript(records) : aggregateRust(records));
    const finalJob = scope === "js" ? "typecheck + tests" : "engine gate";
    const expected = gateJobNames(scope);
    const required = (await jobs()).filter(job => expected.includes(job.name));
    if (required.length !== expected.length || expected.some(name => required.filter(job => job.name === name).length !== 1)
      || required.some(job => job.name !== finalJob && job.conclusion !== "success")) throw new Error(`A required ${scope} job is missing or did not finish successfully.`);
    if (required.some(job => !Number.isFinite(Date.parse(job.started_at)))) throw new Error("A required job has no start time.");
    report.startedAt = new Date(Math.min(...required.map(job => Date.parse(job.started_at)))).toISOString();
    report.finishedAt = new Date().toISOString();
    report.seconds = (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000;
    report.budgetSeconds = scope === "js" ? 300 : 600;
    report.jobs = required.map(({ name, started_at, completed_at, conclusion }) => ({ name, startedAt: started_at, finishedAt: completed_at, conclusion }));
    // Artifact upload and the runner's final reporting still have to finish.
    if (report.seconds + 10 > report.budgetSeconds) throw new Error(`The complete ${scope} gate has used ${report.seconds}s of its ${report.budgetSeconds}s budget before final reporting.`);
    report.verdict = "PASS";
  } catch (error) { report.error = error.message; throw error; }
  finally {
    mkdirSync(".agent-artifacts/verification/aggregate", { recursive: true });
    writeFileSync(`.agent-artifacts/verification/aggregate/${scope}-result.json`, JSON.stringify(report, null, 2) + "\n");
    if (scope === "rust") {
      console.log("\n== summary ==");
      for (const step of report.steps) console.log(`  ${step.status} ${step.name}`);
      console.log(`  ${report.verdict} complete gate${report.error ? `: ${report.error}` : ""}`);
    }
    console.log(`[verification] ${report.verdict} (${scope}): ${report.seconds ?? "unknown"}s, ${report.tasks ?? 0} tasks`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) aggregateCloud(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
