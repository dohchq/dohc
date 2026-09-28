import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, relative, resolve } from "node:path";
import { cancellationScope } from "./cancellation.mjs";
import { pnpm, repoRoot, run } from "./process.mjs";
import { startTiming, timed } from "./timing.mjs";

const databasePackages = new Set(["@dohc/workspace-postgres", "@dohc/workspace-auth", "@dohc/workspace-api", "@dohc/share-web"]);
const longestFirst = ["@dohc/ydoc-projection", "@dohc/desktop", "@dohc/sync-relay", "@dohc/app-backend-runtime"];

export function testPlan(packages, testFiles = {}) {
  for (const name of Object.keys(testFiles)) {
    if (!packages.some(pkg => pkg.name === name && pkg.manifest.scripts?.test)) throw new Error(`No selected test package owns file selection: ${name}.`);
  }
  return packages.filter(({ manifest }) => manifest.scripts?.test).map(({ name, manifest }) => {
    const script = name === "@dohc/desktop" ? "test:unit" : name === "@dohc/app-backend-runtime" ? "test:prepared" : "test";
    if (!manifest.scripts[script]) throw new Error(`Missing ${script} in ${name}.`);
    const workers = name === "@dohc/app-backend-runtime" ? 2
      : name === "@dohc/desktop" ? Math.min(4, Math.max(2, Math.floor(availableParallelism() / 4))) : 4;
    const vitest = /^vitest run(?: |$)/u.test(manifest.scripts[script]);
    const files = testFiles[name];
    if (files && (!vitest || !files.length)) {
      throw new Error(`Invalid test file selection for ${name}.`);
    }
    return { name, script, ...(files ? {files} : {}), resource: databasePackages.has(name) ? "postgres" : null,
      args: ["--filter", name, "run", script, ...(vitest ? [`--maxWorkers=${workers}`] : []), ...(files ?? [])] };
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

export async function testWorkspace({ prepared = false, output = join(repoRoot, ".agent-artifacts/js-tests", new Date().toISOString().replaceAll(":", "-")), env = process.env, selectedPackages, testFiles = {} } = {}) {
  mkdirSync(output, { recursive: true });
  const report = { version: 1, concurrency: 2, steps: [], verdict: "RUNNING" };
  const finish = startTiming(report);
  const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  const cancellation = cancellationScope("Workspace tests");
  // The first command to fail stops every lane from starting another.
  let failure;
  async function command(name, args) {
    await cancellation.checkpoint();
    if (failure) throw failure;
    const row = { name, args, log: join(output, name.replaceAll(/[^\w.-]/gu, "_") + ".log") };
    report.steps.push(row);
    return timed(row, () => run(...pnpm(args), { env, log: row.log }), save)
      .catch(error => { failure ??= error; throw error; });
  }
  async function runPackages() {
    const inventory = await command("inventory", ["-r", "list", "--depth", "-1", "--json"]);
    const packages = JSON.parse(inventory.stdout).filter(pkg => relative(repoRoot, pkg.path) !== "")
      .map(pkg => ({ ...pkg, manifest: JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8")) }));
    if (selectedPackages && selectedPackages.some(name => !packages.some(pkg => pkg.name === name))) {
      throw new Error("A selected workspace package is missing from the installed inventory.");
    }
    const tasks = testPlan(packages.filter(pkg => !selectedPackages || selectedPackages.includes(pkg.name)), testFiles);
    for (const task of tasks) for (const file of task.files ?? []) {
      const pkg = packages.find(pkg => pkg.name === task.name);
      if (!existsSync(join(pkg.path, file))) throw new Error(`Selected test file is missing: ${task.name}/${file}.`);
    }
    if (!tasks.length && !selectedPackages) throw new Error("No workspace package tests were discovered.");
    report.selectedPackages = selectedPackages ?? packages.map(pkg => pkg.name);
    report.packages = tasks.map(({name, script, resource, files}) => ({name, script, resource, ...(files ? {files} : {})}));
    save();
    await runBounded(tasks, task => command(task.name, task.args), report.concurrency);
    return tasks;
  }
  try {
    if (!prepared) {
      await command("runtime-build", ["--filter", "@dohc/app-backend-runtime", "build"]);
    }
    // Repository tests write only temporary fixtures and read only tracked
    // source and this checkout's HEAD, which package tests never change, so
    // they run beside the package lanes. Both lanes settle before any failure
    // is reported, so no command outlives cleanup.
    const [, packages] = await Promise.allSettled([command("repository", ["run", "test:repo"]), runPackages()]);
    if (failure) throw failure;
    if (packages.status === "rejected") throw packages.reason;
    const tasks = packages.value;
    // Packaging tests rebuild runtime output. No package may read dist during
    // that rebuild, even when its own tests finished much earlier.
    if (tasks.some(task => task.name === "@dohc/desktop")) await command("desktop-scripts", ["--filter", "@dohc/desktop", "run", "test:scripts"]);
    await cancellation.checkpoint();
    report.verdict = "PASS";
  } catch (error) {
    report.verdict = "FAIL";
    report.error = error.message;
    throw error;
  } finally {
    const interrupted = await cancellation.dispose();
    if (interrupted) { report.verdict = "FAIL"; report.error ??= interrupted.message; }
    finish(); save();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  testWorkspace({ prepared: args.includes("--prepared"), ...(outputIndex >= 0 ? { output: resolve(args[outputIndex + 1]) } : {}) })
    .catch(error => { console.error(error.message); process.exitCode ??= 1; });
}
