import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, matchesGlob, resolve } from "node:path";
import { prepare, assertPrepared, sourceFingerprint, buildEnvironment } from "./build.mjs";
import { doctor } from "./doctor.mjs";
import { git, pnpm, repoRoot, run } from "./process.mjs";
import { classifyTreeProvenance, readTreeState } from "../../tools/rust-engine-program/tree-provenance.mjs";

const require = createRequire(join(repoRoot, "apps/desktop/package.json"));
function treeState() {
  return readTreeState(
    (command) => { try { return git(command.split(" ").slice(1)); } catch { return null; } },
    () => { try { return existsSync(resolve(repoRoot, git(["rev-parse", "--git-path", "logs/HEAD"]))); } catch { return null; } },
  );
}
export function selectedGates(files, workflow) {
  const yaml = require("js-yaml");
  const document = yaml.load(workflow);
  const filterStep = document.jobs.changes.steps.find((step) => step.with?.filters);
  const filters = yaml.load(filterStep.with.filters);
  return Object.fromEntries(["rust", "js"].map((name) => [name, files.some((file) => filters[name].some((pattern) => matchesGlob(file, pattern)))]));
}

async function postgres(output) {
  const name = `dohc-verify-${randomUUID()}`;
  const result = await run("docker", ["run", "--detach", "--name", name, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=dohc", "--env", "POSTGRES_PASSWORD=dohc", "--env", "POSTGRES_DB=dohc", "--health-cmd", "pg_isready -U dohc -d dohc", "--health-interval", "1s", "--health-retries", "30", "postgres:17-alpine"], { log: join(output, "postgres-start.log"), timeoutMs: 300_000 });
  const id = result.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Docker returned no container ID. Inspect container ${name}.`);
  const stop = () => run("docker", ["rm", "--force", id], { log: join(output, "postgres-stop.log"), timeoutMs: 30_000 });
  try {
    const deadline = Date.now() + 60_000;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Verification Postgres did not become healthy.");
      const health = await run("docker", ["inspect", "--format", "{{.State.Health.Status}}", id], { timeoutMs: Math.min(10_000, remaining) });
      if (health.stdout.trim() === "healthy") break;
      if (Date.now() > deadline || health.stdout.trim() === "unhealthy") throw new Error("Verification Postgres did not become healthy.");
      await new Promise((done) => setTimeout(done, 1000));
    }
    const port = (await run("docker", ["port", id, "5432/tcp"], { timeoutMs: 10_000 })).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (!port) throw new Error("Docker did not report a loopback Postgres port.");
    return { id, url: `postgres://dohc:dohc@127.0.0.1:${port}/dohc`, stop };
  } catch (error) { await stop(); throw error; }
}

export async function verify(args) {
  const mode = args[0] ?? "smoke";
  if (!["smoke", "e2e", "pr", "plan"].includes(mode)) throw new Error("Use smoke, e2e, plan --base <ref>, or pr --base <ref>.");
  const baseIndex = args.indexOf("--base");
  const base = baseIndex >= 0 ? args[baseIndex + 1] : null;
  const jobIndex = args.indexOf("--job");
  const job = jobIndex < 0 ? null : args[jobIndex + 1];
  if (jobIndex >= 0 && (mode !== "pr" || !["rust", "js"].includes(job))) throw new Error("--job rust|js is available only for PR verification.");
  if (["pr", "plan"].includes(mode) && (!base || base.startsWith("--"))) throw new Error("Supply --base <ref> for PR gate selection.");
  const baseCommit = base ? git(["rev-parse", "--verify", `${base}^{commit}`]) : null;
  const files = base ? [...new Set([
    ...git(["diff", "--name-only", `${baseCommit}...HEAD`]).split(/\r?\n/),
    ...(mode === "plan" ? git(["diff", "--name-only", "HEAD"]).split(/\r?\n/).concat(git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/)) : []),
  ])].filter(Boolean) : [];
  const workflow = readFileSync(join(repoRoot, ".github/workflows/pr-checks.yml"), "utf8");
  const requiredGates = selectedGates(files, workflow);
  if (job) requiredGates[job] = true;
  const gates = Object.fromEntries(Object.entries(requiredGates).map(([name, needed]) => [name, needed && (!job || name === job)]));
  if (mode === "plan") { console.log(JSON.stringify({ base, baseCommit, files, gates }, null, 2)); return; }
  const output = join(repoRoot, ".agent-artifacts/verification", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  mkdirSync(output, { recursive: true });
  const report = { version: 1, mode, scope: job ?? "all", root: repoRoot, base, baseCommit, commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "", requiredGates, gates, steps: [], treeReadings: [{ step: "start", state: treeState() }], output, verdict: "RUNNING" };
  const reportPath = join(output, "result.json");
  const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  const startSource = { engine: sourceFingerprint("engine"), desktop: sourceFingerprint("desktop") };
  function checkTree(name) {
    report.treeReadings.push({ step: name, state: treeState() });
    report.provenance = classifyTreeProvenance(report.treeReadings);
    save();
    if (report.provenance.status !== "PASS") throw new Error(report.provenance.reason);
    if (Object.entries(startSource).some(([kind, hash]) => sourceFingerprint(kind) !== hash)) throw new Error("Source changed during verification. The result cannot prove the starting checkout.");
  }
  let database;
  async function step(name, command, commandArgs, env = process.env) {
    const started = Date.now();
    const row = { name, command, args: commandArgs, verdict: "RUNNING", log: join(output, `${name}.log`) };
    report.steps.push(row); save();
    let result;
    try { result = await run(command, commandArgs, { env, log: row.log }); row.verdict = "PASS"; }
    catch (error) { row.verdict = "FAIL"; throw error; }
    finally { row.seconds = (Date.now() - started) / 1000; save(); }
    checkTree(name);
    return result;
  }
  save();
  try {
    if (mode === "pr" && report.dirty) throw new Error("Commit the worktree before running the PR gate.");
    if (mode === "pr" && (gates.js || gates.rust)) await step("install", ...pnpm(["install", "--frozen-lockfile"]));
    report.doctor = doctor(); save();
    if (report.doctor.checks.some((check) => check.state === "FAIL")) throw new Error("Preflight failed. Read result.json and run pnpm setup:worktree.");
    if (mode !== "pr" || gates.js) {
      await prepare({ output });
      report.build = assertPrepared(); save();
      checkTree("prepare");
    }
    if (mode === "pr" && gates.rust) {
      const pins = require("js-yaml").load(workflow).env;
      for (const [tool, variable] of [["deny", "CARGO_DENY_VERSION"], ["audit", "CARGO_AUDIT_VERSION"], ["nextest", "CARGO_NEXTEST_VERSION"]]) {
        const result = await step(`cargo-${tool}-version`, "cargo", [tool, "--version"]);
        if (result.stdout.split(/\r?\n/)[0].split(/\s+/)[1] !== pins[variable]) throw new Error(`Install cargo-${tool} ${pins[variable]} to match the workflow.`);
      }
      await step("rust", process.execPath, ["tools/rust-engine-program/run-rust-checks.mjs"], buildEnvironment());
      await step("rust-verdict", process.execPath, ["tools/rust-engine-program/require-ci-pass-verdict.mjs", join(output, "rust.log")]);
    }
    if (mode === "pr" && gates.js) {
      database = await postgres(output);
      report.postgres = { id: database.id }; save();
      const env = { ...process.env, POSTGRES_URL: database.url, DOHC_REQUIRE_POSTGRES: "1", DOHC_REQUIRE_ENGINE_E2E: "1", DOHC_REQUIRE_PLUGIN_INSTALL_E2E: "1" };
      await step("typecheck", ...pnpm(["run", "typecheck"]), env);
      await step("tests", ...pnpm(["run", "test"]), env);
    }
    if (mode !== "pr" || gates.js) {
      const forwarded = mode === "e2e" ? args.slice(1).filter((arg) => arg !== "--") : ["--grep", "@verification-smoke"];
      const jsonReport = join(output, "playwright.json");
      await step("desktop", process.execPath, ["apps/desktop/scripts/run-playwright.mjs", "--config", "apps/desktop/playwright.config.ts", "--output", join(output, "desktop"), ...forwarded, "--reporter=list,json"], { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReport, DOHC_QA_OUTPUT: output, DOHC_REQUIRE_ENGINE_E2E: "1" });
      report.desktop = JSON.parse(readFileSync(jsonReport, "utf8")).stats;
      if (!report.desktop?.expected || report.desktop.unexpected || report.desktop.flaky) throw new Error("Desktop verification did not complete a passing test run.");
      if (mode !== "e2e" && report.desktop.skipped) throw new Error("The mandatory desktop smoke test was skipped.");
      assertPrepared();
    }
    checkTree("finish");
    report.verdict = "PASS";
  } catch (error) { report.verdict = "FAIL"; report.error = error.message; throw error; }
  finally {
    try { await database?.stop(); }
    catch (error) { report.verdict = "FAIL"; report.cleanupError = error.message; process.exitCode = 1; }
    save(); console.log(`[verification] ${report.verdict} (${report.scope}): ${reportPath}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) verify(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
