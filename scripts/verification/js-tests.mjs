import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import { cancellationScope } from "./cancellation.mjs";
import { pnpm, repoRoot, run } from "./process.mjs";
import { startTiming, timed } from "./timing.mjs";
import { flakyReporter, nodeTestFailures, readFlakyLog } from "./flaky.mjs";

const databasePackages = new Set(["@dohc/workspace-postgres", "@dohc/workspace-auth", "@dohc/workspace-api", "@dohc/share-web"]);
const longestFirst = ["@dohc/ydoc-projection", "@dohc/desktop", "@dohc/sync-relay", "@dohc/app-backend-runtime"];

export function testPlan(packages) {
  return packages.filter(({ manifest }) => manifest.scripts?.test).map(({ name, manifest }) => {
    const script = name === "@dohc/desktop" ? "test:unit" : name === "@dohc/app-backend-runtime" ? "test:prepared" : "test";
    if (!manifest.scripts[script]) throw new Error(`Missing ${script} in ${name}.`);
    const workers = name === "@dohc/app-backend-runtime" ? 1
      : name === "@dohc/desktop" ? Math.min(4, Math.max(2, Math.floor(availableParallelism() / 4))) : 4;
    const vitest = /^vitest run(?: |$)/u.test(manifest.scripts[script]);
    return { name, script, resource: databasePackages.has(name) ? "postgres" : null,
      // A failing test runs once more; the reporter records each one that passed only on retry.
      args: ["--filter", name, "run", script, ...(vitest ? [`--maxWorkers=${workers}`, "--retry=1", "--reporter=default", `--reporter=${flakyReporter}`] : [])] };
  }).sort((a, b) => {
    const priority = name => longestFirst.includes(name) ? longestFirst.indexOf(name) : longestFirst.length;
    return priority(a.name) - priority(b.name) || a.name.localeCompare(b.name);
  });
}

// Stop admitting work after failure, then let already-running commands close.
export async function runBounded(tasks, execute, concurrency = 2) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Test concurrency must be a positive integer.");
  const pending = [...tasks], active = new Set(), resources = new Set();
  let failure;
  while (pending.length || active.size) {
    while (!failure && active.size < concurrency) {
      const index = pending.findIndex(task => !task.resource || !resources.has(task.resource));
      if (index < 0) break;
      const [task] = pending.splice(index, 1);
      if (task.resource) resources.add(task.resource);
      const work = Promise.resolve().then(() => execute(task)).catch(error => { failure ??= error; }).finally(() => {
        active.delete(work);
        if (task.resource) resources.delete(task.resource);
      });
      active.add(work);
    }
    if (!active.size) break;
    await Promise.race(active);
  }
  if (failure) throw failure;
}

export async function testWorkspace({ prepared = false, output = join(repoRoot, ".agent-artifacts/js-tests", new Date().toISOString().replaceAll(":", "-")), env = process.env, beforeDesktopScripts, runProofs } = {}) {
  if (runProofs !== undefined && typeof runProofs !== "function") throw new Error("runProofs must be a function.");
  mkdirSync(output, { recursive: true });
  const report = { version: 1, concurrency: 2, proofs: Boolean(runProofs), steps: [], verdict: "RUNNING" };
  const finish = startTiming(report);
  const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  const cancellation = cancellationScope("Workspace tests");
  // The first command to fail stops every lane from starting another.
  let failure;
  const databaseFinished = Promise.withResolvers();
  function fail(error) {
    failure ??= error;
    // Wake the repository lane when failure prevents a queued database test.
    databaseFinished.resolve();
    throw error;
  }
  async function checkpoint() {
    await cancellation.checkpoint();
    if (failure) throw failure;
  }
  // `rerun` marks a node:test step: one that failed only in its tests runs once more.
  async function command(name, args, { rerun = false } = {}) {
    await checkpoint();
    const file = join(output, name.replaceAll(/[^\w.-]/gu, "_"));
    const row = { name, args, log: `${file}.log` };
    report.steps.push(row);
    const flakyLog = `${file}.flaky.jsonl`;
    const execute = log => run(...pnpm(args), { env: { ...env, DOHC_FLAKY_LOG: flakyLog }, log });
    return timed(row, async () => {
      try { return await execute(row.log); }
      catch (error) {
        // A failed build or check is not retried, and neither is a step whose report names no failed test.
        const failed = rerun && error.commandExitFailure && existsSync(row.log) ? nodeTestFailures(readFileSync(row.log, "utf8")) : [];
        if (!failed.length) throw error;
        await checkpoint();
        row.retryLog = `${file}.retry.log`;
        const result = await execute(row.retryLog);
        row.flaky = failed;
        return result;
      }
    }, save).finally(() => {
      const flaky = [...(row.flaky ?? []), ...readFlakyLog(flakyLog)];
      if (flaky.length) { row.flaky = flaky; save(); }
    }).catch(fail);
  }
  async function planPackages() {
    const inventory = await command("inventory", ["-r", "list", "--depth", "-1", "--json"]);
    const packages = JSON.parse(inventory.stdout).filter(pkg => relative(repoRoot, pkg.path) !== "")
      .map(pkg => ({ ...pkg, manifest: JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8")) }));
    const tasks = testPlan(packages);
    if (!tasks.length) throw new Error("No workspace package tests were discovered.");
    report.packages = tasks.map(({name, script, resource}) => ({name, script, resource}));
    save();
    return tasks;
  }
  try {
    if (!prepared) {
      await command("runtime-build", ["--filter", "@dohc/app-backend-runtime", "build"]);
    }
    const repositoryChecks = command("repository", ["run", "test:repo"], { rerun: true });
    const plan = planPackages().catch(fail);
    const databasePending = new Set();
    const packages = plan.then(async tasks => {
      for (const task of tasks) if (task.resource === "postgres") databasePending.add(task.name);
      if (!databasePending.size) databaseFinished.resolve();
      // Complete the shared database consumers before the repository lane's
      // proofs, while the longest desktop package occupies the other slot.
      const priority = task => task.name === "@dohc/desktop" ? 0 : task.resource === "postgres" ? 1 : 2;
      const scheduled = runProofs ? tasks.toSorted((a, b) => priority(a) - priority(b)) : tasks;
      await runBounded(scheduled, async task => {
        try { await command(task.name, task.args); }
        finally {
          databasePending.delete(task.name);
          if (!databasePending.size) databaseFinished.resolve();
        }
      }, report.concurrency);
      return tasks;
    }).catch(fail);
    // Isolated scripts take over the repository lane without adding another
    // concurrent command. Only the runtime packaging fixture rewrites dist.
    const runRepository = async () => {
      await repositoryChecks;
      const tasks = await plan;
      if (tasks.some(task => task.name === "@dohc/desktop")) {
        await command("desktop-scripts", ["--filter", "@dohc/desktop", "run", "test:scripts:isolated"], { rerun: true });
      }
      if (runProofs) {
        await databaseFinished.promise;
        await checkpoint();
        const row = { name: "proofs", runner: "runProofs" };
        report.steps.push(row);
        await timed(row, () => runProofs(checkpoint), save);
      }
    };
    // Every lane settles before cleanup, including after a sibling fails.
    const results = await Promise.allSettled([runRepository().catch(fail), packages]);
    if (failure) throw failure;
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const tasks = results[1].value;
    // Packaging rebuilds dist, which package tests and Rust's public-collection
    // recovery fixture read. Package tests and proofs must also finish first.
    if (tasks.some(task => task.name === "@dohc/desktop")) {
      await beforeDesktopScripts?.();
      await command("desktop-runtime-packaging", ["--filter", "@dohc/desktop", "run", "test:scripts:runtime"], { rerun: true });
    }
    await cancellation.checkpoint();
    report.verdict = "PASS";
  } catch (error) {
    report.verdict = "FAIL";
    report.error = error.message;
    throw error;
  } finally {
    const interrupted = await cancellation.dispose();
    if (interrupted) { report.verdict = "FAIL"; report.error ??= interrupted.message; }
    report.flaky = report.steps.flatMap(step => (step.flaky ?? []).map(test => ({ step: step.name, test })));
    finish(); save();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  testWorkspace({ prepared: args.includes("--prepared"), ...(outputIndex >= 0 ? { output: resolve(args[outputIndex + 1]) } : {}) })
    .catch(error => { console.error(error.message); process.exitCode ??= 1; });
}
