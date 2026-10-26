import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import { cancellationScope } from "./cancellation.mjs";
import { pnpm, repoRoot, run } from "./process.mjs";
import { startTiming, timed } from "./timing.mjs";
import { nodeTestFailures, nodeTestPassed, nodeTestTimes, readLog, readTestRecord, recordedRun, rerunCommand, slowest, testRecordReporter } from "./flaky.mjs";
import { affectedPackages, packageReferences } from "./selection.mjs";

const databasePackages = new Set(["@dohc/workspace-postgres", "@dohc/workspace-auth", "@dohc/workspace-api", "@dohc/share-web"]);
const longestFirst = ["@dohc/ydoc-projection", "@dohc/desktop", "@dohc/sync-relay", "@dohc/app-backend-runtime"];
const desktopRoot = join(repoRoot, "apps/desktop");
const fileOf = test => test.slice(0, test.indexOf(" › "));

export function testPlan(packages) {
  return packages.filter(({ manifest }) => manifest.scripts?.test).map(({ name, manifest }) => {
    const script = name === "@dohc/desktop" ? "test:unit" : name === "@dohc/app-backend-runtime" ? "test:prepared" : "test";
    if (!manifest.scripts[script]) throw new Error(`Missing ${script} in ${name}.`);
    const workers = name === "@dohc/app-backend-runtime" ? 1
      : name === "@dohc/desktop" ? Math.min(4, Math.max(2, Math.floor(availableParallelism() / 4))) : 4;
    const vitest = /^vitest run(?: |$)/u.test(manifest.scripts[script]);
    return { name, script, resource: databasePackages.has(name) ? "postgres" : null,
      // A failing test runs once more; the reporter records each one that passed only on retry, and the slow ones.
      args: ["--filter", name, "run", script, ...(vitest ? [`--maxWorkers=${workers}`, "--retry=1", "--reporter=default", `--reporter=${testRecordReporter}`] : [])] };
  }).sort((a, b) => {
    const priority = name => longestFirst.includes(name) ? longestFirst.indexOf(name) : longestFirst.length;
    return priority(a.name) - priority(b.name) || a.name.localeCompare(b.name);
  });
}

// Stop admitting work after failure, then let already-running commands close.
// Once `more` resolves, one more command can run.
export async function runBounded(tasks, execute, concurrency = 2, more) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Test concurrency must be a positive integer.");
  const pending = [...tasks], active = new Set(), resources = new Set();
  let failure, limit = concurrency;
  let widening = more?.then(() => { limit += 1; widening = undefined; });
  while (pending.length || active.size) {
    while (!failure && active.size < limit) {
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
    await Promise.race(widening ? [...active, widening] : active);
  }
  if (failure) throw failure;
}

// `stop` is the caller's cancellation scope: its stop interrupts these commands, and their first confirmed failure stops it.
// `repositoryTests` is the repository lane's script: every repository test, or "test:repo:tree" for the ones that read the source tree.
// `full` runs each desktop unit test file in a worker of its own, so a test that passes only after another file in a shared worker fails.
// `onlyPackage` runs one package's steps as a full run does, without the repository lane. The desktop release tests the desktop package this way.
export async function testWorkspace({ prepared = false, output = join(repoRoot, ".agent-artifacts/js-tests", new Date().toISOString().replaceAll(":", "-")), env = process.env, beforeDesktopScripts, runProofs, changed = null, repositoryTests = "test:repo", full = false, onlyPackage = null, stop } = {}) {
  if (runProofs !== undefined && typeof runProofs !== "function") throw new Error("runProofs must be a function.");
  mkdirSync(output, { recursive: true });
  const report = { version: 1, concurrency: 2, proofs: Boolean(runProofs), steps: [], verdict: "RUNNING" };
  const finish = startTiming(report);
  const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  const cancellation = cancellationScope("Workspace tests");
  const stopper = stop ?? cancellation;
  // The first command to fail stops every lane from starting another.
  let failure;
  const databaseFinished = Promise.withResolvers();
  const repositoryFree = Promise.withResolvers();
  function fail(error, name = "tests") {
    failure ??= error;
    stopper.stop(error?.step ?? name, error);
    // Wake the repository lane when failure prevents a queued database test.
    databaseFinished.resolve();
    throw error;
  }
  async function checkpoint() {
    await cancellation.checkpoint();
    if (failure) throw failure;
    stopper.signal.throwIfAborted();
  }
  // `rerun` marks a node:test step with its package's directory: one that failed only in its tests runs once more.
  async function command(name, args, { rerun, stepEnv } = {}) {
    await checkpoint();
    const file = join(output, name.replaceAll(/[^\w.-]/gu, "_"));
    const row = { name, args, log: `${file}.log`, ...(stepEnv ? { env: stepEnv } : {}) };
    report.steps.push(row);
    const record = `${file}.tests.jsonl`;
    const commandEnv = { ...env, ...stepEnv };
    const execute = log => run(...pnpm(args), { env: { ...commandEnv, DOHC_TEST_RECORD: record }, log, signal: stopper.signal });
    async function attempts() {
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
    }
    // The tests that failed every try, when nothing else failed the step and each one has a command that runs it alone.
    function failedEveryTry() {
      const tests = rerun ? (row.retryLog ? nodeTestFailures(readLog(row.retryLog)) : [])
        : recordedRun(record)?.outside === 0 ? readTestRecord(record).filter(test => test.failed).map(test => test.test) : [];
      if (!tests.length || !tests.every(test => rerunCommand({ step: name, test }))) return [];
      if (!rerun) return tests;
      // A test that failed only the retry did not fail every try.
      const first = nodeTestFailures(readLog(row.log));
      if (!tests.every(test => first.includes(test))) return [];
      // A test that failed in an earlier command of the script stopped the commands after it, which never ran.
      let script;
      try { script = JSON.parse(readLog(join(rerun, "package.json"))).scripts?.[args.at(-1)]; } catch { return []; }
      if (typeof script !== "string") return [];
      const last = script.split("&&").at(-1).trim().split(/\s+/u);
      return tests.every(test => last.includes(fileOf(test))) ? tests : [];
    }
    // The whole test file, with one worker. A test can fail only after another test in its file, or fail its file in a way the report does not name.
    function wholeFile(testFile) {
      if (!rerun) return pnpm(["--filter", name, "exec", "vitest", "run", testFile, "--maxWorkers=1", "--no-file-parallelism", "--retry=0", "--reporter=default", `--reporter=${testRecordReporter}`]);
      const nodeTest = [...(testFile.endsWith(".ts") ? ["--experimental-transform-types"] : []), "--test", "--test-concurrency=1", testFile];
      return name === "repository" ? [process.execPath, nodeTest] : pnpm(["--filter", "@dohc/desktop", "exec", "node", ...nodeTest]);
    }
    // The failures each file names when it fails alone, which can be other tests than the ones it reran.
    const failedAlone = [];
    // Load from other steps can fail a test on both tries. Its file alone shows whether the file fails by itself.
    async function passAlone(testFile, tests, base) {
      const log = `${base}.log`, aloneRecord = `${base}.tests.jsonl`;
      const alone = { file: testFile, outcome: "interrupted" };
      (row.alone ??= []).push(alone);
      await checkpoint();
      alone.log = log;
      try { await run(...wholeFile(testFile), { env: { ...commandEnv, DOHC_TEST_RECORD: aloneRecord, DOHC_TEST_RECORD_ALL: "1" }, log, signal: stopper.signal }); }
      catch (error) {
        if (!error.interrupted) {
          alone.outcome = "failed";
          failedAlone.push(...rerun ? nodeTestFailures(readLog(log)) : readTestRecord(aloneRecord).filter(test => test.failed).map(test => test.test));
        }
        throw error;
      }
      // Both runners pass a file whose tests did not run, so the report must show each failed test passed.
      const report = readLog(log), recorded = readTestRecord(aloneRecord);
      const passed = rerun ? !nodeTestFailures(report).length && tests.every(test => nodeTestPassed(report, test))
        : recordedRun(aloneRecord)?.outside === 0 && tests.every(test => recorded.some(row => row.test === test && row.passed));
      alone.outcome = passed ? "passed" : "no test ran";
      if (!passed) throw new Error(`${testFile} did not pass its failed tests alone.`);
    }
    return timed(row, async () => {
      try { return await attempts(); }
      catch (error) {
        // Before a failure stops the run, each file with a test that failed every try runs once more alone. An interrupted command did not fail by itself.
        const tests = error.commandExitFailure ? failedEveryTry() : [];
        if (!tests.length) throw error;
        for (const [index, [testFile, fileTests]] of [...Map.groupBy(tests, fileOf)].entries()) {
          try { await passAlone(testFile, fileTests, `${file}.alone-${index + 1}`); }
          catch { throw error; }
        }
        row.passedAlone = tests;
        // A node:test step's test that failed only its first try passed on retry.
        const flaky = rerun ? nodeTestFailures(readLog(row.log)).filter(test => !tests.includes(test)) : [];
        if (flaky.length) row.flaky = flaky;
      }
    }, save).finally(() => {
      const recorded = readTestRecord(record);
      const flaky = [...(row.flaky ?? []), ...recorded.filter(test => test.flaky).map(test => test.test)];
      if (flaky.length) row.flaky = flaky;
      // What a vitest test threw on a try that failed, which its log no longer shows once a retry or a run alone passes.
      const errors = recorded.filter(test => (test.flaky || test.failed) && test.error);
      if (errors.length) row.testErrors = Object.fromEntries(errors.map(test => [test.test, test.error]));
      // vitest's failed and slow tests come from its reporter; node:test's from the spec report of the attempt that ran last.
      const last = readLog(row.retryLog ?? row.log);
      const failed = [...new Set([...recorded.filter(test => test.failed).map(test => test.test), ...(rerun ? nodeTestFailures(last) : []), ...failedAlone])]
        .filter(test => !row.passedAlone?.includes(test));
      if (failed.length) row.failed = failed;
      const times = [...recorded.filter(test => test.seconds >= 2), ...nodeTestTimes(last).filter(test => test.seconds >= 2)];
      if (times.length) row.slowest = slowest(times);
      save();
    }).catch(error => {
      if (stopper.notRun(row, error)) save();
      return fail(error, name);
    });
  }
  async function planPackages() {
    const inventory = await command("inventory", ["-r", "list", "--depth", "-1", "--json"]);
    const packages = JSON.parse(inventory.stdout).filter(pkg => relative(repoRoot, pkg.path) !== "")
      .map(pkg => ({ ...pkg, manifest: JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8")) }));
    // A change confined to some packages runs only their tests and their dependents'.
    const relativePackages = packages.map(pkg => ({ ...pkg, path: relative(repoRoot, pkg.path).replaceAll("\\", "/") }));
    const only = onlyPackage !== null ? [onlyPackage] : changed && affectedPackages(changed, relativePackages, packageReferences(repoRoot, relativePackages));
    const planned = testPlan(packages);
    if (!planned.length) throw new Error("No workspace package tests were discovered.");
    // A change confined to some packages runs only their tests and their dependents'.
    const tasks = only ? planned.filter(task => only.includes(task.name)) : planned;
    if (onlyPackage !== null && !tasks.length) throw new Error(`No workspace package named ${onlyPackage} has tests.`);
    if (only) report.skippedPackages = planned.filter(task => !only.includes(task.name)).map(task => task.name);
    report.packages = tasks.map(({name, script, resource}) => ({name, script, resource}));
    save();
    return tasks;
  }
  try {
    if (!prepared) {
      await command("runtime-build", ["--filter", "@dohc/app-backend-runtime", "build"]);
    }
    const repositoryChecks = onlyPackage !== null ? null : command("repository", ["run", repositoryTests], { rerun: repoRoot });
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
        const stepEnv = full && task.name === "@dohc/desktop" ? { DOHC_DESKTOP_TEST_ISOLATION: "all" } : undefined;
        try { await command(task.name, task.args, { stepEnv }); }
        finally {
          databasePending.delete(task.name);
          if (!databasePending.size) databaseFinished.resolve();
        }
      }, report.concurrency, repositoryFree.promise);
      return tasks;
    }).catch(fail);
    // Isolated scripts, proofs, and then any package test that has not started
    // take over the repository lane without adding another concurrent command.
    // Only the runtime packaging fixture rewrites dist.
    const runRepository = async () => {
      await repositoryChecks;
      const tasks = await plan;
      // Desktop-only release preflight shares a four-CPU hosted runner. Its
      // Windows compiler owner must compile C# before its deadline expires.
      if (onlyPackage === "@dohc/desktop") await packages;
      if (tasks.some(task => task.name === "@dohc/desktop")) {
        await command("desktop-scripts", ["--filter", "@dohc/desktop", "run", "test:scripts:isolated"], { rerun: desktopRoot });
      }
      if (runProofs) {
        await databaseFinished.promise;
        await checkpoint();
        const row = { name: "proofs", runner: "runProofs" };
        report.steps.push(row);
        await timed(row, () => runProofs(checkpoint), save).catch(error => {
          stopper.notRun(row, error);
          return fail(error, "proofs");
        });
      }
      repositoryFree.resolve();
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
      await command("desktop-runtime-packaging", ["--filter", "@dohc/desktop", "run", "test:scripts:runtime"], { rerun: desktopRoot });
    }
    await cancellation.checkpoint();
    report.verdict = "PASS";
  } catch (error) {
    report.verdict = "FAIL";
    report.error = error.message;
    stopper.notRun(report, error);
    throw error;
  } finally {
    const interrupted = await cancellation.dispose();
    if (interrupted) { report.verdict = "FAIL"; report.error ??= interrupted.message; }
    const desktop = report.packages?.some(task => task.name === "@dohc/desktop");
    const stopped = stopper.unfinished(report.steps, [...(onlyPackage !== null ? [] : ["repository"]), ...(report.packages ?? []).map(task => task.name),
      ...(desktop ? ["desktop-scripts"] : []), ...(runProofs ? ["proofs"] : []), ...(desktop ? ["desktop-runtime-packaging"] : [])]);
    if (stopped) report.stopped = stopped;
    const error = (step, test) => step.testErrors?.[test] ? { error: step.testErrors[test] } : {};
    report.flaky = report.steps.flatMap(step => [...(step.flaky ?? []).map(test => ({ step: step.name, test, ...error(step, test) })),
      ...(step.passedAlone ?? []).map(test => ({ step: step.name, test, passedAlone: true, ...error(step, test) }))]);
    report.failed = report.steps.flatMap(step => (step.failed ?? []).map(test => ({ step: step.name, test })));
    report.slowest = slowest(report.steps.flatMap(step => (step.slowest ?? []).map(test => ({ step: step.name, ...test }))));
    finish(); save();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const packageIndex = args.indexOf("--package");
  testWorkspace({ prepared: args.includes("--prepared"), ...(outputIndex >= 0 ? { output: resolve(args[outputIndex + 1]) } : {}),
    ...(packageIndex >= 0 ? { onlyPackage: args[packageIndex + 1] ?? "" } : {}) })
    .catch(error => { console.error(error.message); process.exitCode ??= 1; });
}
