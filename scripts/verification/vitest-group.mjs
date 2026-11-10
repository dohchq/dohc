import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { repoRoot } from "./process.mjs";
import { startTiming } from "./timing.mjs";

const specId = (pkg, spec) => `vitest:${pkg}:${spec.project.name}:${relative(repoRoot, spec.moduleId).replaceAll("\\", "/")}`;

// Each package owns its cwd, environment, Vite server, and test descendants.
export async function runVitestGroup(tasks, record, save) {
  const pkg = tasks[0].package;
  const wanted = new Map(tasks.map(task => [task.id, task]));
  process.env.NODE_ENV ??= "test";
  const { createVitest, parseCLI } = await import("vitest/node");
  const { filter, options } = parseCLI(tasks[0].script);
  const ctx = await createVitest("test", { ...options, root: resolve(repoRoot, tasks[0].cwd), run: true, watch: false,
    maxWorkers: pkg === "@dohc/app-backend-runtime" ? 1 : 2, retry: 0 });
  try {
    await ctx.standalone();
    const specs = (await ctx.getRelevantTestSpecifications(filter)).filter(spec => wanted.has(specId(pkg, spec)));
    if (specs.length !== wanted.size) throw new Error(`Test inventory changed in ${pkg}.`);
    const result = await ctx.runTestSpecifications(specs);
    let failure;
    if (result.unhandledErrors.length || result.testModules.length !== specs.length) {
      record.testRunErrors = [{ package: pkg, errors: result.unhandledErrors.map(error => error.stack ?? error.message) }];
      failure = new Error(`Incomplete test run: ${pkg}.`);
    }
    for (const module of result.testModules) {
      const id = specId(pkg, module.toTestSpecification());
      const task = wanted.get(id);
      if (!task) throw new Error(`Unplanned test module: ${id}.`);
      wanted.delete(id);
      const cases = [...module.children.allTests()];
      const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
      for (const test of cases) counts[test.result().state] += 1;
      const failedTests = cases.filter(test => test.result().errors?.length || test.diagnostic()?.retryCount)
        .map(test => ({ name: test.fullName, errors: test.result().errors?.map(error => error.stack ?? error.message), retries: test.diagnostic()?.retryCount }));
      const skippedTests = cases.filter(test => test.result().state === "skipped")
        .map(test => ({ name: test.fullName, mode: test.options.mode, note: test.result().note }));
      const slowest = cases.map(test => ({ name: test.fullName, seconds: (test.diagnostic()?.duration ?? 0) / 1000 }))
        .filter(test => test.seconds >= 2).sort((a, b) => b.seconds - a.seconds).slice(0, 10);
      const diagnostic = module.diagnostic();
      const timings = { environment: diagnostic.environmentSetupDuration / 1000, preparation: diagnostic.prepareDuration / 1000,
        collection: diagnostic.collectDuration / 1000, setup: diagnostic.setupDuration / 1000, tests: diagnostic.duration / 1000 };
      record.tests.push({ id, ...counts, failedTests, skippedTests, slowest, errors: module.errors().map(error => error.stack ?? error.message),
        seconds: Object.values(timings).reduce((sum, seconds) => sum + seconds, 0), timings });
      if (module.state() === "failed" || module.errors().length || counts.failed || counts.pending || failedTests.length || !cases.length) failure ??= new Error(`Test file did not finish: ${id}.`);
      else if (task.native && cases.some(test => test.result().state === "skipped" && !["skip", "todo"].includes(test.options.mode))) failure ??= new Error(`Native test case skipped during execution: ${id}.`);
      else record.completed.push(id);
      save();
    }
    if (wanted.size) failure ??= new Error(`Test files did not run: ${[...wanted.keys()]}.`);
    if (failure) throw failure;
  } finally { await ctx.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [input, output] = process.argv.slice(2);
  const record = { tests: [], completed: [], verdict: "RUNNING" };
  const finish = startTiming(record);
  const save = () => writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
  save();
  try {
    await runVitestGroup(JSON.parse(readFileSync(input, "utf8")), record, save);
    record.verdict = "PASS";
  } catch (error) {
    record.verdict = "FAIL";
    record.error = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally { finish(); save(); }
}
