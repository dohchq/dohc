import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertPrepared, hashFile, prepare, stagedEnginePath } from "./build.mjs";
import { changedFiles, desktopProofCommand, passedSpecTitles, postgres, readSelfHostDeliveryProof } from "./verify.mjs";
import { selectsRepositoryTests } from "./selection.mjs";
import { JS_SHARDS, assertTaskCoverage, javascriptGroups, javascriptTasks, partitionJavascript } from "./shards.mjs";
import { runBounded } from "./js-tests.mjs";
import { waitForPreparation } from "./wait-preparation.mjs";
import { git, pnpm, readJson, repoRoot, run } from "./process.mjs";
import { startTiming, timed } from "./timing.mjs";

export { JS_SHARDS };
const output = resolve(repoRoot, ".agent-artifacts/verification/cloud", process.argv[2] ?? "unknown", process.argv[3] ?? "0");

export async function cloudPlan() {
  const changed = process.env.PR_BASE_SHA ? changedFiles(process.env.PR_BASE_SHA) : null;
  const workflow = readFileSync(join(repoRoot, ".github/workflows/pr-checks.yml"), "utf8");
  const repositoryTests = changed && !selectsRepositoryTests(changed, workflow) ? "test:repo:tree" : "test:repo";
  return javascriptTasks({ changed, repositoryTests });
}

function passingBrowserReport(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (!report.stats?.expected || report.stats.unexpected || report.stats.skipped || report.stats.flaky) throw new Error(`Browser proof failed or skipped: ${path}`);
  return report;
}

async function runJavascript(groups, record, save, availability) {
  const tasks = groups.flatMap(group => group.tasks);
  const selected = new Map(tasks.map(task => [task.id, task]));
  groups = [...groups];
  groups.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const step = async (name, action) => {
    const row = { name }; record.steps.push(row);
    return timed(row, action, save);
  };
  const command = (task, command, args, options = {}) => step(task.id, () => run(command, args, { log: join(output, `${record.steps.length}.log`), ...options }));
  async function execute(group) {
    if (group.kind === "vitest") {
      if (group.pkg === "@dohc/mobile") {
        await step(`${group.pkg} build:editor`, () => run(...pnpm(["--filter", group.pkg, "build:editor"]), { log: join(output, `${record.steps.length}.log`) }));
      }
      const prefix = join(output, `${record.steps.length}-${group.pkg.replaceAll(/[^\w-]/gu, "_")}`);
      const input = `${prefix}-tasks.json`, resultPath = `${prefix}-vitest.json`;
      writeFileSync(input, JSON.stringify(group.tasks) + "\n");
      let failure;
      try {
        await step(group.pkg, () => run(process.execPath, [resolve(import.meta.dirname, "vitest-group.mjs"), input, resultPath], {
          cwd: resolve(repoRoot, group.tasks[0].cwd), log: `${prefix}.log`,
          env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "test" },
        }));
      } catch (error) { failure = error; }
      const result = readJson(resultPath);
      if (result) {
        record.tests.push(...result.tests);
        record.completed.push(...result.completed);
        if (result.testRunErrors?.length) (record.testRunErrors ??= []).push(...result.testRunErrors);
        save();
      }
      if (failure) throw failure;
      if (result?.verdict !== "PASS") throw new Error(`Incomplete test run: ${group.pkg}.`);
      assertTaskCoverage(group.tasks, [result]);
      return;
    }
    const [task] = group.tasks;
    if (task.kind === "command") {
      const [executable, args] = task.command === "pnpm" ? pnpm(task.args) : [task.command === "node" ? process.execPath : task.command, task.args];
      await command(task, executable, args, { cwd: resolve(repoRoot, task.cwd) });
    } else if (task.kind === "self-host-native") {
      const directory = join(output, `self-host-${record.steps.length}`);
      mkdirSync(directory, { recursive: true });
      const sha256 = hashFile(stagedEnginePath);
      const escaped = task.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      await command(task, ...pnpm(["--filter", "@dohc/share-web", "exec", "vitest", "run", "--config", "vitest.self-host-native.config.ts",
        "--testNamePattern", `^${escaped}$`, "--reporter=default", "--reporter=json", `--outputFile.json=${join(directory, "vitest.json")}`]),
      { env: { ...process.env, DOHC_SERVICE_HOST_PROOF_BINARY: stagedEnginePath, DOHC_SERVICE_HOST_PROOF_SHA256: sha256, DOHC_SERVICE_HOST_PROOF_OUTPUT: directory } });
      const result = JSON.parse(readFileSync(join(directory, "vitest.json"), "utf8"));
      const cases = result.testResults.flatMap(module => module.assertionResults).filter(test => test.fullName === task.name);
      if (!result.success || cases.length !== 1 || cases[0].status !== "passed" || result.numPassedTests !== 1 || result.numFailedTests) throw new Error(`Native proof did not pass: ${task.name}.`);
      if (task.name.startsWith("enrolls a self-hosted document,")) {
        // The canonical reader also checks the complete saved delivery record.
        record.selfHostNative = readSelfHostDeliveryProof(directory, stagedEnginePath, sha256);
      }
    } else if (task.kind === "desktop" || task.kind === "accounts") {
      const path = join(output, `${record.steps.length}-playwright.json`);
      const args = ["--config", task.kind === "accounts" ? "services/workspace-api/playwright.config.ts" : "apps/desktop/playwright.config.ts",
        "--output", join(output, `browser-${record.steps.length}`), "--retries=0", "--reporter=list,json", ...(task.tag ? ["--grep", task.tag] : [])];
      const executable = task.kind === "accounts" ? [process.execPath, ["apps/desktop/scripts/run-playwright.mjs", ...args]] : desktopProofCommand(args);
      await command(task, ...executable, { env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: path, DOHC_QA_OUTPUT: output } });
      const result = passingBrowserReport(path);
      if (task.tag && !passedSpecTitles(result.suites).some(title => title.split(/\s+/u).includes(task.tag))) throw new Error(`Missing desktop proof ${task.tag}.`);
    } else throw new Error(`Unknown task kind ${task.kind}.`);
    record.completed.push(task.id);
  }
  // This test replaces the packaged runtime. Its readers finish first.
  const runtime = groups.filter(group => group.tasks.some(task => task.id.includes("stage-app-backend-runtime.test.mjs")));
  await runBounded(groups.filter(group => !runtime.includes(group)), execute, 2, availability?.changed, availability);
  for (const group of runtime) await execute(group);
  assertTaskCoverage([...selected.values()], [{ ...record, verdict: "PASS" }]);
}

async function restoreNativePreparation() {
  const { artifact, deadline } = await waitForPreparation("js");
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0) throw new Error("The prepared artifact has no valid identity.");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Native artifact transfer exceeded the JavaScript gate budget.");
  const response = await fetch(`${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(Math.min(60_000, remaining)),
  });
  if (!response.ok || !response.body) throw new Error(`Cannot download the prepared artifact: HTTP ${response.status}.`);
  const temporary = mkdtempSync(join(tmpdir(), "dohc-js-prepared-"));
  const zip = join(temporary, "artifact.zip"), archive = join(temporary, "javascript-prepared.tar.zst");
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(zip));
    await run("unzip", ["-o", "-j", zip, "javascript-prepared.tar.zst", "-d", temporary], { log: join(output, "artifact-unzip.log") });
    await run("tar", ["-I", "zstd", "-xf", archive], { cwd: repoRoot, log: join(output, "artifact-restore.log") });
    return assertPrepared();
  } finally {
    rmSync(zip, { force: true }); rmSync(archive, { force: true }); rmdirSync(temporary);
  }
}

export async function cloudJavascript(part, index = 0) {
  if (!process.env.GITHUB_ACTIONS) throw new Error("Distributed gates run on GitHub Actions. Use pnpm verify:pr on a development host.");
  mkdirSync(output, { recursive: true });
  const record = { version: 1, scope: "js", part: `${part}-${index}`, commit: git(["rev-parse", "HEAD"]), steps: [], tests: [], completed: [], verdict: "RUNNING" };
  const finish = startTiming(record);
  const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(record, null, 2) + "\n");
  const step = (name, action) => { const row = { name }; record.steps.push(row); return timed(row, action, save); };
  save();
  let database;
  try {
    if (part === "prepare") {
      await prepare({ install: false, output });
      record.build = assertPrepared();
    } else {
      if (part !== "worker" || !Number.isSafeInteger(index) || index < 0 || index >= JS_SHARDS) throw new Error("Use worker with a valid shard index.");
      process.env.DOHC_REQUIRE_ENGINE_E2E = "1";
      process.env.DOHC_REQUIRE_POSTGRES = "1";
      process.env.DOHC_TEST_ENGINE_BINARY = stagedEnginePath;
      process.env.DOHC_TEST_RELAY_MAIN = resolve(repoRoot, "services/sync-relay/dist/main.js");
      const tasks = await step("test inventory", cloudPlan);
      record.planned = tasks.map(task => task.id);
      const shard = partitionJavascript(javascriptGroups(tasks))[index];
      record.assigned = shard.flatMap(group => group.tasks.map(task => task.id));
      save();
      process.env.DOHC_QA_OUTPUT = output;
      let nativeReady = !shard.some(group => group.native);
      const preparation = nativeReady ? Promise.resolve() : step("native preparation", async () => {
        const actions = [restoreNativePreparation().then(build => { record.build = build; })];
        if (shard.some(group => ["desktop", "accounts"].includes(group.kind))) actions.push(step("browser installation", () =>
          run(...pnpm(["exec", "playwright", "install", "chromium"]), { log: join(output, "browser-install.log") })));
        const results = await Promise.allSettled(actions);
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
        nativeReady = true;
      });
      // Observe preparation failure immediately, including while PostgreSQL starts.
      preparation.catch(() => {});
      let workFailure;
      try {
        if (shard.some(group => group.resource === "postgres" || ["desktop", "accounts", "self-host-native"].includes(group.kind))) {
          database = await step("postgres", () => postgres(output));
          process.env.POSTGRES_URL = database.url;
        }
        await runJavascript(shard, record, save, { changed: preparation, canRun: group => !group.native || nativeReady });
      } catch (error) { workFailure = error; }
      const [prepared] = await Promise.allSettled([preparation]);
      if (workFailure) throw workFailure;
      if (prepared.status === "rejected") throw prepared.reason;
    }
    record.verdict = "PASS";
  } catch (error) {
    record.verdict = "FAIL"; record.error = error.stack; throw error;
  } finally {
    try { await database?.stop(); }
    catch (error) { record.verdict = "FAIL"; record.cleanupError = error.message; process.exitCode = 1; }
    finish(); save();
    console.log(`[verification] ${record.verdict} (js ${record.part}): ${join(output, "result.json")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  cloudJavascript(process.argv[2], Number(process.argv[3] ?? 0)).catch(error => { console.error(error); process.exitCode = 1; });
}
