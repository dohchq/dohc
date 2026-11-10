import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { affectedPackages, packageReferences, readWorkspacePackages } from "./selection.mjs";
import { repoRoot } from "./process.mjs";
import { desktopProofTags } from "./verify.mjs";

const slash = path => path.replaceAll("\\", "/");
const fileId = path => slash(relative(repoRoot, path));
export const JS_SHARDS = 11;

const databasePackages = new Set(["@dohc/workspace-postgres", "@dohc/workspace-auth", "@dohc/workspace-api", "@dohc/share-web"]);

// Partition the same execution units that the runner schedules. A large file
// stays whole; small files share their package and project initialization.
export function javascriptGroups(tasks) {
  const packages = Map.groupBy(tasks.filter(task => task.kind === "vitest"), task => JSON.stringify([task.package, task.project, Boolean(task.native)]));
  const groups = [];
  for (const [key, files] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const chunks = [];
    for (const task of files.toSorted((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))) {
      const chunk = chunks.filter(chunk => chunk.weight + task.weight <= 60).sort((a, b) => b.weight - a.weight)[0];
      if (chunk) { chunk.tasks.push(task); chunk.weight += task.weight; }
      else chunks.push({ tasks: [task], weight: task.weight });
    }
    groups.push(...chunks.map((chunk, index) => ({ ...chunk, id: `vitest-group:${key}:${index}`, kind: "vitest", pkg: files[0].package,
      native: Boolean(files[0].native), resource: databasePackages.has(files[0].package) ? "postgres" : null,
      weight: Math.max(...chunk.tasks.map(task => task.weight), chunk.weight / (files[0].package === "@dohc/app-backend-runtime" ? 1 : 2)) + 4 })));
  }
  groups.push(...tasks.filter(task => task.kind !== "vitest").map(task => ({ id: task.id, kind: task.kind, tasks: [task], native: Boolean(task.native), weight: task.weight })));
  return groups;
}

export function partitionTasks(tasks, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("A shard count must be a positive integer.");
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("Duplicate verification task IDs.");
  const shards = Array.from({ length: count }, () => ({ weight: 0, tasks: [] }));
  for (const task of tasks.toSorted((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))) {
    const shard = shards.reduce((least, next) => next.weight < least.weight ? next : least);
    shard.tasks.push(task);
    shard.weight += task.weight;
  }
  return shards.map(shard => shard.tasks);
}

export function partitionJavascript(groups, count = JS_SHARDS) {
  const native = partitionTasks(groups.filter(group => group.native), count);
  const pure = partitionTasks(groups.filter(group => !group.native), count);
  return native.map((groups, index) => [...groups, ...pure[index]]);
}

export function assertTaskCoverage(expected, records) {
  const remaining = new Set(expected.map(task => task.id));
  if (remaining.size !== expected.length) throw new Error("Duplicate planned verification tasks.");
  for (const record of records) {
    if (record.verdict !== "PASS") throw new Error(`Verification part ${record.part} did not pass.`);
    for (const id of record.completed ?? []) {
      if (!remaining.delete(id)) throw new Error(`Unexpected or repeated verification task: ${id}`);
    }
  }
  if (remaining.size) throw new Error(`Verification tasks did not finish: ${[...remaining].join(", ")}`);
}

function sourceDependencies(file) {
  const source = readFileSync(file, "utf8");
  const result = [];
  for (const match of source.matchAll(/["'`](\.{1,2}\/[^"'`\s${}]+)["'`]/gu)) {
    const base = resolve(dirname(file), match[1]);
    const stem = base.replace(/\.[cm]?jsx?$/u, "");
    const path = [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"].map(extension => stem + extension),
      ...["index.ts", "index.tsx", "index.js", "index.mjs"].map(name => join(base, name))]
      .find(path => /\.[cm]?[jt]sx?$/u.test(path) && existsSync(path));
    if (path && !fileId(path).startsWith("../") && !path.includes(`${join("node_modules", "")}`)) result.push(path);
  }
  return result;
}

// A test that reaches the native fixture stays with the prepared engine, even
// when that dependency is several shared test helpers away.
export function nativeTestFiles(files, { dependencies = sourceDependencies,
  roots = [resolve(repoRoot, "apps/desktop/src/testing/engineBinary.ts")] } = {}) {
  const parents = new Map();
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dependency of dependencies(file)) {
      const importers = parents.get(dependency) ?? new Set();
      importers.add(file);
      parents.set(dependency, importers);
      visit(dependency);
    }
  }
  files.forEach(visit);
  const native = new Set(roots);
  const pending = [...roots];
  while (pending.length) for (const file of parents.get(pending.pop()) ?? []) {
    if (!native.has(file)) { native.add(file); pending.push(file); }
  }
  return new Set(files.filter(file => native.has(file)));
}

export function manifestTasks(root, script, { prefix = "repository", manifest = JSON.parse(readFileSync(join(root, "package.json"))) } = {}) {
  const source = manifest.scripts?.[script];
  if (typeof source !== "string") throw new Error(`Missing verification script ${script}.`);
  return source.split(/\s*&&\s*/u).flatMap(command => {
    const args = command.trim().split(/\s+/u);
    if (args[0] === "pnpm") {
      const nested = args[1] === "run" ? args[2] : args[1];
      if (manifest.scripts?.[nested]?.includes("&&") && !args.slice(args[1] === "run" ? 3 : 2).length) return manifestTasks(root, nested, { prefix, manifest });
    }
    if (args[0] === "node" && args.includes("--test")) {
      const files = args.filter(arg => /\.[cm]?[jt]sx?$/u.test(arg));
      if (!files.length) throw new Error(`No files in ${script}: ${command}`);
      const flags = args.slice(1).filter(arg => !files.includes(arg) && !arg.startsWith("--test-concurrency="));
      return files.map(file => ({ id: `node:${fileId(resolve(root, file))}`, kind: "command", cwd: fileId(root), command: "node",
        args: [...flags, "--test-concurrency=1", file], weight: 1 + readFileSync(resolve(root, file)).length / 1000 }));
    }
    if (!new Set(["node", "pnpm"]).has(args[0]) || /[|;&<>"']/u.test(command)) throw new Error(`Unsupported verification script: ${command}`);
    return [{ id: `${prefix}:${command}`, kind: "command", cwd: fileId(root), command: args[0], args: args.slice(1), weight: 20 }];
  });
}

export async function javascriptTasks({ changed = null, repositoryTests = "test:repo", proofs = true } = {}) {
  // Match Vitest's CLI before the first Vite server chooses development mode.
  const nodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV ??= "test";
  try {
  const { createVitest, parseCLI } = await import("vitest/node");
  const packages = readWorkspacePackages(repoRoot);
  const selected = changed && affectedPackages(changed, packages, packageReferences(repoRoot, packages));
  const tasks = [];
  const durations = JSON.parse(readFileSync(new URL("./shard-times.json", import.meta.url)));
  for (const pkg of packages.filter(pkg => !selected || selected.includes(pkg.name))) {
    const script = pkg.manifest.scripts?.[pkg.name === "@dohc/desktop" ? "test:unit" : pkg.name === "@dohc/app-backend-runtime" ? "test:prepared" : "test"];
    if (!script) continue;
    if (!/^vitest run(?: |$)/u.test(script)) throw new Error(`Declare a verification task for ${pkg.name}: ${script}`);
    const { filter, options } = parseCLI(script);
    const ctx = await createVitest("test", { ...options, root: resolve(repoRoot, pkg.path), watch: false, run: true });
    try {
      const specifications = await ctx.getRelevantTestSpecifications(filter);
      if (!specifications.length) throw new Error(`No test files in selected package ${pkg.name}.`);
      for (const spec of specifications) {
        const file = fileId(spec.moduleId);
        tasks.push({ id: `vitest:${pkg.name}:${spec.project.name}:${file}`, kind: "vitest", package: pkg.name, cwd: pkg.path,
          script, project: spec.project.name, file, weight: durations[file] ?? 1 });
      }
    } finally { await ctx.close(); }
  }
  const native = nativeTestFiles(tasks.map(task => resolve(repoRoot, task.file)));
  for (const task of tasks) task.native = native.has(resolve(repoRoot, task.file));
  tasks.push(...manifestTasks(repoRoot, repositoryTests),
    { id: "typecheck", kind: "command", command: "pnpm", cwd: "", args: ["run", "typecheck"], weight: 40 });
  if (!selected || selected.includes("@dohc/desktop")) tasks.push(
    ...manifestTasks(join(repoRoot, "apps/desktop"), "test:scripts:isolated", { prefix: "desktop" }),
    ...manifestTasks(join(repoRoot, "apps/desktop"), "test:scripts:runtime", { prefix: "desktop" }));
  if (proofs) {
    const ctx = await createVitest("test", { root: resolve(repoRoot, "services/share-web"), config: "vitest.self-host-native.config.ts", watch: false, run: true });
    try {
      const result = await ctx.collectTests(await ctx.globTestSpecifications());
      if (result.unhandledErrors.length || result.testModules.length !== 1 || result.testModules[0].errors().length) throw new Error("Cannot collect the self-host native proofs.");
      const cases = [...result.testModules[0].children.allTests()];
      if (!cases.length) throw new Error("No self-host native proofs.");
      for (const test of cases) tasks.push({ id: `self-host-native:${test.fullName}`, kind: "self-host-native", name: test.fullName, native: true, weight: 15 });
    } finally { await ctx.close(); }
    for (const tag of desktopProofTags().required) tasks.push({ id: `desktop:${tag}`, kind: "desktop", tag, native: true, weight: 35 });
    tasks.push({ id: "accounts", kind: "accounts", native: true, weight: 20 });
  }
  for (const task of tasks) task.weight = durations[task.id] ?? task.weight;
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error("Duplicate JavaScript verification tasks.");
  return tasks;
  } finally {
    if (nodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnvironment;
  }
}
