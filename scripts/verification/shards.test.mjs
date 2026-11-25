import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BROWSER_TEST_FILES,
  assertTaskCoverage,
  javascriptGroups,
  javascriptTasks,
  nativeTestFiles,
  packedPreparedArtifactPaths,
  partitionJavascript,
  preparedArtifactPaths,
  simulateJavascript,
} from "./shards.mjs";
import { MIN_TASK_SECONDS, refreshShardTimes } from "./refresh-shard-times.mjs";
import { readWorkspacePackages } from "./selection.mjs";
import {
  CLOUD_JOB_GRAPH,
  aggregateJavascript,
  aggregateRust,
  completedGateTiming,
  verifyCompletedCloud,
} from "./cloud-aggregate.mjs";
import { JS_SHARDS } from "./cloud.mjs";
import {
  RUST_ARCHIVE_PROOFS,
  RUST_POLICY_STEPS,
  RUST_READER_SHARD,
  RUST_SHARDS,
  RUST_TEST_PROOFS,
  RUST_TEST_THREADS,
  passedRustTests,
  rustTestInventory,
  partitionRustTests,
  rustPartitionFilters,
  assertRustPartitionInventory,
} from "./cloud-rust.mjs";
import { recordedRustTimes, rustTimingSamples } from "./refresh-rust-times.mjs";
import { waitForPreparation } from "./wait-preparation.mjs";
import { cloudApi } from "./cloud-api.mjs";
import { runVitestGroup } from "./vitest-group.mjs";

test("JS workers retry the Electron installer once and propagate other errors", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cloud-electron-retry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.mock.property(process, "argv", [...process.argv.slice(0, 2), directory, "0"]);
  t.mock.property(process, "env", {
    ...process.env,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "merge_group",
  });
  t.mock.method(console, "log", () => {});
  const asModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
  const installer = asModule(`
    export * from ${JSON.stringify(new URL("./verify.mjs", import.meta.url).href)};
    export const state = {};
    export function electronBinary() {
      const error = state.errors[state.calls++];
      if (error) throw error;
    }
    export async function setTimeout(ms) { state.delays.push(ms); }
  `);
  const shards = new URL("./shards.mjs", import.meta.url).href;
  const inventory = asModule(`
    export * from ${JSON.stringify(shards)};
    import { javascriptGroups as groupTasks } from ${JSON.stringify(shards)};
    export const javascriptTasks = () => [
      { id: "fixture", kind: "command", command: "node", args: ["-e", ""], cwd: ".", weight: 1 },
    ];
    export const javascriptGroups = (tasks) =>
      groupTasks(tasks).map(group => ({ ...group, pkg: "@dohc/desktop" }));
  `);
  const workerUrl = new URL("./cloud.mjs?electron-retry", import.meta.url);
  const modules = new Map([
    ["./verify.mjs", installer],
    ["node:timers/promises", installer],
    ["./shards.mjs", inventory],
  ]);
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const url = context.parentURL === workerUrl.href && modules.get(specifier);
      return url ? { url, shortCircuit: true } : next(specifier, context);
    },
  });
  t.after(() => hook.deregister());
  const { cloudJavascript } = await import(workerUrl.href);
  const { state } = await import(installer);
  const first = new Error("Electron failed to install correctly. First download failed.");
  const second = new Error("Electron failed to install correctly. Second download failed.");
  const missing = new Error("Cannot find module 'electron'");
  const attempts = [];
  for (const errors of [[first], [first, second], [missing]]) {
    Object.assign(state, { errors, calls: 0, delays: [] });
    const error = await cloudJavascript("worker").catch((failure) => failure);
    attempts.push({ error, calls: state.calls, delays: state.delays });
  }
  assert.deepEqual(attempts, [
    { error: undefined, calls: 2, delays: [2_000] },
    { error: second, calls: 2, delays: [2_000] },
    { error: missing, calls: 1, delays: [] },
  ]);
});

test("native results retain declared opt-in skips but reject runtime skips and missing engines", async (t) => {
  const parent = resolve(".agent-artifacts/verification/native-report-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(root, "vitest.config.mjs"),
    "export default {test:{include:['*.test.mjs'],fileParallelism:false}};",
  );
  const engineGate = pathToFileURL(resolve("apps/desktop/src/testing/engineBinary.ts")).href;
  const fixtures = {
    pass: "import {it,expect} from 'vitest'; it('runs the native case',()=>expect(2+2).toBe(4));",
    "opt-in":
      "import {it} from 'vitest'; it.skip('manual benchmark',()=>{throw Error('must remain opt-in')});",
    "runtime-skip":
      "import {it} from 'vitest'; it('passes',()=>{}); it('required case',context=>context.skip());",
    "missing-engine": `import {it,vi} from 'vitest'; import {requireEngineBinaryOrSkip} from ${JSON.stringify(engineGate)};
      vi.stubEnv('DOHC_TEST_ENGINE_BINARY', ${JSON.stringify(join(root, "missing-engine"))});
      vi.stubEnv('DOHC_REQUIRE_ENGINE_E2E','1'); requireEngineBinaryOrSkip(); it.skip('native case',()=>{});`,
  };
  const tasks = Object.entries(fixtures).map(([name, source]) => {
    const file = relative(process.cwd(), join(root, `${name}.test.mjs`)).replaceAll("\\", "/");
    writeFileSync(resolve(file), source);
    return {
      id: `vitest:proof::${file}`,
      package: "proof",
      cwd: relative(process.cwd(), root),
      script: "vitest run",
      native: true,
    };
  });
  const record = { tests: [], completed: [] },
    originalExitCode = process.exitCode;
  try {
    await assert.rejects(runVitestGroup(tasks, record, () => {}));
  } finally {
    process.exitCode = originalExitCode;
  }
  assert.deepEqual(
    record.completed.sort(),
    tasks
      .slice(0, 2)
      .map((task) => task.id)
      .sort(),
  );
  assert.equal(record.tests.find((row) => row.id === tasks[1].id).skipped, 1);
  assert.match(
    JSON.stringify(record.tests.find((row) => row.id === tasks[3].id).errors),
    /DOHC_REQUIRE_ENGINE_E2E/u,
  );
});

test("shards cover every task once, including uneven and small workloads", () => {
  for (const count of [1, 3, 8])
    for (const size of [1, 3, 31]) {
      const tasks = Array.from({ length: size }, (_, index) => ({
        id: `task-${index}`,
        weight: index + 1,
      }));
      const shards = partitionJavascript(tasks, count);
      assert.deepEqual(shards, partitionJavascript(tasks.toReversed(), count));
      const records = shards.map((tasks, part) => ({
        part,
        verdict: "PASS",
        completed: tasks.map((task) => task.id),
      }));
      assertTaskCoverage(tasks, records);
      assert.throws(
        () =>
          assertTaskCoverage(
            tasks,
            records.map((row) => ({ ...row, completed: [] })),
          ),
        /did not finish/u,
      );
      assert.throws(
        () => assertTaskCoverage(tasks, [...records, records.find((row) => row.completed.length)]),
        /repeated/u,
      );
      assert.throws(
        () =>
          assertTaskCoverage(
            tasks,
            records.map((row) => ({ ...row, verdict: "FAIL" })),
          ),
        /did not pass/u,
      );
    }
});

test("package typechecks and native proofs stay complete when changed files select no package tests", async () => {
  const packages = readWorkspacePackages(process.cwd()).filter(
    (pkg) => pkg.manifest.scripts?.typecheck,
  );
  const tasks = await javascriptTasks({ changed: ["docs/guide.md"], proofs: true });
  // The long proof runs one task per test. Every other native file runs as one task.
  const native = Map.groupBy(
    tasks.filter((task) => task.kind === "self-host-native"),
    (task) => task.file,
  );
  const split = native.get("services/share-web/src/selfHostedLiveNative.integration.ts") ?? [];
  assert.ok(split.length > 1);
  for (const task of split) assert.equal(task.id, `self-host-native:${task.name}`);
  for (const file of [
    "services/share-web/src/namedRecipientAuthenticatedNative.integration.ts",
    "services/share-web/src/remoteMcpNative.integration.ts",
  ])
    assert.deepEqual(
      native.get(file)?.map(({ id, name }) => ({ id, name })),
      [{ id: `self-host-native:${file}`, name: undefined }],
    );
  for (const file of native.keys()) assert.ok(existsSync(resolve(file)), file);
  const typechecks = tasks.filter((task) => task.id.startsWith("typecheck:"));
  assert.deepEqual(
    typechecks.map((task) => task.id).sort(),
    packages.map((pkg) => `typecheck:${pkg.name}`).sort(),
  );
  assert.ok(!tasks.some((task) => task.id === "typecheck"));
  for (const pkg of packages) {
    const task = typechecks.find((task) => task.id === `typecheck:${pkg.name}`);
    assert.equal(task.cwd, pkg.path);
    assert.equal(task.command, "pnpm");
    assert.deepEqual(task.args, ["run", "typecheck"]);
    assert.ok(!task.native);
  }
  const mobile = typechecks.find((task) => task.id === "typecheck:@dohc/mobile");
  const groups = javascriptGroups([
    mobile,
    { id: "mobile-test", kind: "vitest", package: "@dohc/mobile", weight: 1 },
  ]);
  assert.ok(groups[0].resource);
  assert.equal(groups[0].resource, groups[1].resource);
});

test("browser test files run as native desktop tasks, after the worker installs Chromium", async () => {
  const tasks = await javascriptTasks({
    changed: ["apps/desktop/vitest.config.ts"],
    proofs: false,
  });
  for (const file of BROWSER_TEST_FILES) {
    const task = tasks.find((task) => task.file === file);
    assert.ok(task, file);
    assert.equal(task.package, "@dohc/desktop");
    assert.equal(task.native, true);
  }
});

test("native fixture dependencies propagate through helpers and cycles", () => {
  const graph = new Map([
    ["native-test", ["helper"]],
    ["helper", ["cycle", "engine"]],
    ["cycle", ["helper"]],
    ["pure-test", ["pure-helper"]],
    ["pure-helper", []],
    ["engine", []],
  ]);
  assert.deepEqual(
    nativeTestFiles(["native-test", "pure-test"], {
      dependencies: (file) => graph.get(file),
      roots: ["engine"],
    }),
    new Set(["native-test"]),
  );
});

test("prepared artifact references keep tests and their helpers behind restoration", (t) => {
  const parent = resolve(".agent-artifacts/verification/prepared-readers");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workflow = readFileSync(resolve(".github/workflows/pr-checks.yml"), "utf8");
  const pack = workflow.match(
    /- name: Pack prepared artifacts\s+run: >-\s+([\s\S]*?)(?=\r?\n      -)/u,
  )[1];
  const paths = pack
    .trim()
    .split(/\s+/u)
    .slice(pack.trim().split(/\s+/u).indexOf("/tmp/javascript-prepared.tar.zst") + 1);
  assert.deepEqual(new Set(paths), new Set(packedPreparedArtifactPaths));
  const expected = [];
  for (const [index, path] of preparedArtifactPaths.entries()) {
    for (const [style, expression] of Object.entries({
      literal: `join(repoRoot, ${JSON.stringify(path)})`,
      joined: `join(repoRoot, ${path
        .split("/")
        .map((part) => JSON.stringify(part))
        .join(", ")})`,
      relative: `new URL(${JSON.stringify(relative(root, resolve(path)).replaceAll("\\", "/"))}, import.meta.url)`,
      template: "`${repoRoot}/" + path + "`",
    })) {
      const file = join(root, `${index}-${style}.test.mjs`);
      writeFileSync(file, `statSync(${expression});`);
      expected.push(file);
    }
  }
  for (const name of ["DOHC_TEST_ENGINE_BINARY", "DOHC_TEST_RELAY_MAIN"]) {
    const helper = join(root, `${name}.mjs`),
      file = join(root, `${name}.test.mjs`);
    writeFileSync(helper, `export const path = process.env.${name};`);
    writeFileSync(file, `import {path} from './${name}.mjs'; statSync(path);`);
    expected.push(file);
  }
  const pure = join(root, "pure.test.mjs");
  writeFileSync(
    pure,
    `statSync(join(scratch, 'dist')); statSync(new URL('../packages/app-backend-runtime/dist', import.meta.url));`,
  );
  assert.deepEqual(nativeTestFiles([...expected, pure]), new Set(expected));
});

test("prepared artifact readers include the share-web dist fingerprint regression", () => {
  const file = resolve("services/share-web/src/deviceControl.integration.test.ts");
  assert.ok(nativeTestFiles([file]).has(file));
});

test("execution groups preserve files, projects, native prerequisites, and command tasks", () => {
  const files = Array.from({ length: 30 }, (_, index) => ({
    id: `file-${index}`,
    kind: "vitest",
    package: index % 2 ? "@dohc/workspace-api" : "desktop",
    project: index % 3 ? "node" : "dom",
    native: index % 4 === 0,
    weight: index + 1,
  }));
  const tasks = [...files, { id: "typecheck", kind: "command", weight: 100 }];
  const groups = javascriptGroups(tasks);
  for (const group of groups.filter((group) => group.kind === "vitest")) {
    assert.equal(new Set(group.tasks.map((task) => task.package)).size, 1);
    assert.equal(new Set(group.tasks.map((task) => task.project)).size, 1);
    assert.equal(new Set(group.tasks.map((task) => task.native)).size, 1);
    assert.equal(group.native, group.tasks[0].native);
    assert.equal(group.resource === "postgres", group.pkg === "@dohc/workspace-api");
  }
  assert.deepEqual(javascriptGroups(tasks.toReversed()), groups);
  assertTaskCoverage(
    tasks,
    partitionJavascript(groups, JS_SHARDS).map((groups, part) => ({
      part,
      verdict: "PASS",
      completed: groups.flatMap((group) => group.tasks.map((task) => task.id)),
    })),
  );
});

test("only browser groups reserve two slots without changing their wall time", () => {
  const tasks = ["desktop", "accounts", "self-host-native", "command"].map((kind) => ({
    id: kind,
    kind,
    weight: 20,
    native: true,
  }));
  const files = [{ id: "file", kind: "vitest", package: "example", weight: 20 }];
  const groups = javascriptGroups([...tasks, ...files]);
  for (const task of tasks) {
    const group = groups.find((group) => group.id === task.id);
    assert.equal(group.weight, 20);
    assert.equal(group.slots, ["desktop", "accounts"].includes(task.kind) ? 2 : undefined);
    assert.equal(task.weight, 20);
  }
  const vitest = groups.find((group) => group.kind === "vitest");
  assert.equal(vitest.weight, 24);
  assert.equal(vitest.slots, undefined);
});

test("simulation admits pure work before preparation and widens to three slots afterward", () => {
  const groups = [
    { id: "pure", weight: 30 },
    ...["native-a", "native-b", "native-c"].map((id) => ({ id, weight: 20, native: true })),
  ];
  const result = simulateJavascript(groups, { inventory: 0, nativeReady: 10 });
  assert.deepEqual(
    result.steps.find((step) => step.id === "pure"),
    {
      id: "pure",
      startedAt: 0,
      finishedAt: 30,
    },
  );
  for (const id of ["native-a", "native-b"])
    assert.equal(result.steps.find((step) => step.id === id).startedAt, 10);
  assert.equal(result.steps.find((step) => step.id === "native-c").startedAt, 30);
  assert.equal(result.seconds, 50);
  assert.equal(
    simulateJavascript(
      ["pure-a", "pure-b", "pure-c"].map((id) => ({ id, weight: 10 })),
      { inventory: 0 },
    ).seconds,
    10,
  );
});

test("simulation excludes shared resources and accounts for browser slots and the final runtime writer", () => {
  const groups = [
    { id: "database-a", resource: "postgres", weight: 30 },
    { id: "database-b", resource: "postgres", weight: 20 },
    { id: "mobile-a", resource: "mobile-editor", weight: 25 },
    { id: "mobile-b", resource: "mobile-editor", weight: 15 },
    { id: "browser", kind: "desktop", slots: 2, weight: 10 },
    {
      id: "runtime",
      weight: 100,
      tasks: [{ id: "node:apps/desktop/scripts/stage-app-backend-runtime.test.mjs" }],
    },
  ];
  const result = simulateJavascript(groups, { inventory: 0, postgres: 0 });
  for (const resource of ["postgres", "mobile-editor"]) {
    const work = result.steps.filter(
      (step) => groups.find((group) => group.id === step.id).resource === resource,
    );
    assert.ok(work[1].startedAt >= work[0].finishedAt);
  }
  for (const step of result.steps) {
    const running = result.steps.filter(
      (other) => other.startedAt <= step.startedAt && other.finishedAt > step.startedAt,
    );
    assert.ok(
      running.reduce(
        (sum, other) => sum + (groups.find((group) => group.id === other.id).slots ?? 1),
        0,
      ) <= 3,
    );
  }
  const runtime = result.steps.find((step) => step.id === "runtime");
  assert.ok(
    result.steps
      .filter((step) => step !== runtime)
      .every((step) => step.finishedAt <= runtime.startedAt),
  );
});

test("CPU contention slows active groups when native work arrives and releases capacity when they finish", () => {
  const result = simulateJavascript(
    [
      { id: "pure-a", weight: 40, cpu: 2.5 },
      { id: "pure-b", weight: 40, cpu: 2.5 },
      { id: "native", weight: 40, cpu: 2.5, native: true },
    ],
    { inventory: 0, nativeReady: 10 },
  );
  assert.deepEqual(result.steps, [
    { id: "pure-a", startedAt: 0, finishedAt: 70 },
    { id: "pure-b", startedAt: 0, finishedAt: 70 },
    { id: "native", startedAt: 10, finishedAt: 78 },
  ]);
  assert.equal(result.seconds, 78);
});

test("partitioning spreads desktop browser groups, projection tests, lint, and desktop typecheck", () => {
  const tasks = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `desktop-${index}`,
      kind: "vitest",
      package: "@dohc/desktop",
      project: "desktop",
      weight: 60,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `projection-${index}`,
      kind: "vitest",
      package: "@dohc/ydoc-projection",
      weight: 60,
    })),
    { id: "repository:pnpm lint", kind: "command", weight: 60 },
    { id: "typecheck:@dohc/desktop", kind: "command", weight: 60 },
  ];
  const shards = partitionJavascript(javascriptGroups(tasks), 5);
  assert.deepEqual(
    shards.map((shard) => shard.length),
    [1, 1, 1, 1, 1],
  );
  assertTaskCoverage(
    tasks,
    shards.map((shard, part) => ({
      part,
      verdict: "PASS",
      completed: shard.flatMap((group) => group.tasks.map((task) => task.id)),
    })),
  );
});

test("partitioning balances finish time when resources serialize work", () => {
  const groups = [10, 20, 50, 50, 20, 10, 20, 50].map((weight, index) => ({
    id: `task-${index}`,
    weight,
    resource: [1, 3].includes(index) ? "postgres" : undefined,
  }));
  const shards = partitionJavascript(groups, 2);
  assert.deepEqual(shards, partitionJavascript(groups.toReversed(), 2));
  assert.deepEqual(
    shards.map((shard) => simulateJavascript(shard, { inventory: 0, postgres: 0 }).seconds),
    [50, 50],
  );
  assertTaskCoverage(
    groups,
    shards.map((shard, part) => ({
      part,
      verdict: "PASS",
      completed: shard.map((group) => group.id),
    })),
  );
  assert.throws(() => partitionJavascript(groups, 0), /positive integer/u);
  assert.throws(() => partitionJavascript([groups[0], groups[0]], 2), /Duplicate/u);
  for (const weight of [Number.NaN, Infinity, -1, "7", undefined])
    assert.throws(
      () => partitionJavascript([groups[0], { id: "bad", weight }], 2),
      /finite, non-negative/u,
    );
});

test("timing refresh uses measured medians, retains missing weights, and keeps planner keys", () => {
  const record = (seconds) => ({
    scope: "js",
    verdict: "PASS",
    tests: [
      { id: "vitest:example:node:src/example.test.ts", seconds },
      { id: "vitest:example::src/tiny.test.ts", seconds: 0 },
    ],
    steps: [
      { name: "typecheck:example", seconds: seconds + 1 },
      { name: "native preparation", seconds: 100 },
    ],
  });
  const records = [record(1), record(8), record(3), record(5)];
  const weights = refreshShardTimes(records, { missing: 7 });
  assert.deepEqual(weights, {
    missing: 7,
    "src/example.test.ts": 4,
    "src/tiny.test.ts": MIN_TASK_SECONDS,
    "typecheck:example": 5,
  });
  assert.deepEqual(weights, refreshShardTimes(records.toReversed(), { missing: 7 }));
  const override = "vitest:example:node:src/example.test.ts";
  assert.equal(refreshShardTimes(records, { [override]: 10 })[override], 4);
  assert.throws(() => refreshShardTimes([{ ...record(1), verdict: "FAIL" }]), /passing/u);
  assert.throws(() => refreshShardTimes([record(NaN)]), /Invalid/u);
});

test("JavaScript receipts reject missing, failed, duplicated, or different-head work", () => {
  const records = [{ part: "prepare-0", commit: "head", verdict: "PASS" }];
  for (let index = 0; index < JS_SHARDS; index++)
    records.push({
      part: `worker-${index}`,
      commit: "head",
      verdict: "PASS",
      planned: Array.from({ length: JS_SHARDS }, (_, id) => `task-${id}`),
      assigned: [`task-${index}`],
      completed: [`task-${index}`],
      tests: [],
      ...(!index ? { selfHostNative: {} } : {}),
    });
  assert.equal(aggregateJavascript(records).tasks, JS_SHARDS);
  assert.throws(() => aggregateJavascript(records.slice(1)), {
    message:
      "The JavaScript preparation receipt is missing, duplicated, or unsuccessful; check preparation and worker jobs.",
  });
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => {
      rows[1].completed = [];
    },
    (rows) => {
      rows[1].verdict = "FAIL";
    },
    (rows) => {
      rows[1].commit = "other";
    },
    (rows) => {
      rows[1].planned.push("forgotten");
    },
    (rows) => rows.push(rows[1]),
    (rows) => rows.push({ part: "unexpected", commit: "head", verdict: "FAIL" }),
  ]) {
    const broken = structuredClone(records);
    mutate(broken);
    assert.throws(() => aggregateJavascript(broken));
  }
});

test("Rust receipts require every policy row and exactly the full passing test inventory", () => {
  const steps = RUST_POLICY_STEPS.map((name) => ({ name, status: "PASS" }));
  const all = Array.from({ length: RUST_SHARDS }, (_, index) => `crate test${index}`);
  const row = (part, extra = {}) => ({
    part,
    commit: "head",
    verdict: "PASS",
    provenance: { status: "PASS" },
    ...extra,
  });
  const archiveSteps = RUST_ARCHIVE_PROOFS.map((name) => ({ name, verdict: "PASS" }));
  const records = [
    row("policy", { steps }),
    row("archive-0", { planned: all, steps: archiveSteps, scratch: { status: "PASS" } }),
    ...all.map((id, index) =>
      row(`tests-${index}`, {
        planned: all,
        assigned: [id],
        completed: [id],
        scratch: { status: "PASS" },
        steps:
          index === RUST_READER_SHARD
            ? RUST_TEST_PROOFS.map((name) => ({ name, verdict: "PASS" }))
            : [],
      }),
    ),
  ];
  assert.equal(aggregateRust(records).tasks, RUST_SHARDS);
  for (const mutate of [
    (rows) => {
      rows[0].steps.pop();
    },
    (rows) => {
      rows[0].steps[0].status = "SKIP";
    },
    (rows) => {
      rows[2].completed = [];
    },
    (rows) => {
      rows[2].completed.push(rows[3].completed[0]);
    },
    (rows) => {
      rows[2].scratch.status = "FAIL";
    },
    (rows) => {
      rows[2].provenance.status = "FAIL";
    },
    (rows) => {
      rows[1].planned.push("unrun");
    },
    (rows) => {
      rows[1].commit = "other";
    },
    (rows) => rows.pop(),
    (rows) => {
      rows[1].steps.pop();
    },
    (rows) => {
      rows[1].steps[0].verdict = "FAIL";
    },
    (rows) => {
      rows[1].scratch.status = "FAIL";
    },
    (rows) => {
      rows[RUST_READER_SHARD + 2].steps = [];
    },
    (rows) => {
      rows[RUST_READER_SHARD + 2].steps[0].verdict = "FAIL";
    },
    (rows) => {
      rows[2].steps = structuredClone(rows[RUST_READER_SHARD + 2].steps);
    },
    (rows) => {
      rows[1].steps.push(...structuredClone(rows[RUST_READER_SHARD + 2].steps));
    },
    (rows) => {
      rows[2].steps = rows[RUST_READER_SHARD + 2].steps;
      rows[RUST_READER_SHARD + 2].steps = [];
    },
  ]) {
    const broken = structuredClone(records);
    mutate(broken);
    assert.throws(() => aggregateRust(broken));
  }
});

test("reader proofs run on a matrix partition", () => {
  // Partition 0 also aggregates the gate, so the reader proofs stay off it.
  assert.ok(RUST_READER_SHARD > 0 && RUST_READER_SHARD < RUST_SHARDS);
});

test("Rust inventory retains selected ordinary tests and counts only actual passes", () => {
  const tests = {
    "rust-suites": {
      crate: {
        testcases: {
          retained: { ignored: false, "filter-match": { status: "matches" } },
          ignored: { ignored: true, "filter-match": { status: "matches" } },
          otherShard: { ignored: false, "filter-match": { status: "mismatch" } },
        },
      },
    },
  };
  assert.deepEqual(rustTestInventory(tests), [{ id: "crate retained" }]);
  assert.deepEqual(
    passedRustTests(
      "PASS [ 0.1s] (1/2) crate retained\nFAIL [ 0.2s] crate broken\nFLAKY 2/2 [ 0.1s] crate retry",
    ),
    ["crate retained"],
  );
});

test("Rust time partitions are deterministic and cover each test exactly once", () => {
  const times = {
    defaultSeconds: 0.5,
    binaries: { crate: 1 },
    tests: { "crate slow": 66, "crate medium": 7, "crate fast": 2 },
  };
  const inventory = [
    "crate slow",
    "crate medium",
    "crate fast",
    ...Array.from({ length: 601 }, (_, i) => `crate new_${i}`),
  ];
  for (const count of [1, 4, 5, 6, 7, 8, inventory.length + 1]) {
    const partitions = partitionRustTests(inventory, count, times);
    assert.deepEqual(partitions, partitionRustTests(inventory.toReversed(), count, times));
    assert.equal(partitions.length, count);
    assert.deepEqual(partitions.flat().sort(), inventory.toSorted());
    assert.equal(new Set(partitions.flat()).size, inventory.length);
  }
  assert.throws(() => partitionRustTests(["crate same", "crate same"]), /Duplicate/u);
  for (const count of [0, -1, 1.5, NaN])
    assert.throws(() => partitionRustTests(inventory, count), /positive integer/u);
});

test("Rust partitions use binary defaults for new tests and the global default for new binaries", () => {
  const times = { defaultSeconds: 1, binaries: { known: 3 }, tests: { "known slow": 5 } };
  assert.deepEqual(
    partitionRustTests(
      ["known slow", "known new_a", "known new_b", "new_crate new", "constructor new"],
      2,
      times,
      0,
    ),
    [
      ["known slow", "constructor new", "new_crate new"],
      ["known new_a", "known new_b"],
    ],
  );
  assert.deepEqual(partitionRustTests([], 2, times), [[], []]);
});

test("The reader reserve holds back wall seconds times the test thread count", () => {
  const times = { defaultSeconds: 10, binaries: {}, tests: {} };
  const inventory = Array.from({ length: 24 }, (_, i) => `crate t${i}`);
  assert.equal(RUST_READER_SHARD, 1);
  assert.equal(RUST_TEST_THREADS, 4);
  // A 20 s wall reserve holds back 20, 40, or 80 test-seconds at 1, 2, or 4 threads.
  for (const [threads, sizes] of [
    [1, [13, 11]],
    [2, [14, 10]],
    [undefined, [16, 8]],
  ]) {
    const partitions = partitionRustTests(inventory, 2, times, 20, threads);
    assert.deepEqual(
      partitions.map((tests) => tests.length),
      sizes,
    );
  }
});

test("Rust filters select exact tests in exact binaries and escape filterset syntax", () => {
  assert.deepEqual(rustPartitionFilters(["crate same", "crate::integration same_longer"]), [
    "-E",
    "(binary_id(=crate) & test(=same)) | (binary_id(=crate::integration) & test(=same_longer))",
  ]);
  assert.deepEqual(rustPartitionFilters(["crate::bin/tool test(a,b)\\ path\n雪"]), [
    "-E",
    "(binary_id(=crate::bin\\u{2f}tool) & test(=test\\u{28}a\\u{2c}b\\u{29}\\u{5c}\\u{20}path\\u{a}\\u{96ea}))",
  ]);
  assert.deepEqual(rustPartitionFilters([]), ["-E", "none()"]);
});

test("Rust filters split large selections without dropping or repeating tests", () => {
  const assigned = Array.from(
    { length: 1600 },
    (_, i) => `crate::integration test_${i}_${"x".repeat(150)}_雪`,
  );
  const args = rustPartitionFilters(assigned);
  const filters = args.filter((_, index) => index % 2);
  assert.ok(filters.length > 1);
  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], "-E");
    assert.ok(Buffer.byteLength(args[index + 1]) + 1 < 128 * 1024);
  }
  const decode = (name) =>
    name.replace(/\\u\{([a-f0-9]+)\}/gu, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
  const selected = filters.flatMap((filter) =>
    [...filter.matchAll(/\(binary_id\(=([^)]*)\) & test\(=([^)]*)\)\)/gu)].map(
      (match) => `${decode(match[1])} ${decode(match[2])}`,
    ),
  );
  assert.deepEqual(selected, assigned);
  assert.throws(() => rustPartitionFilters([`crate ${"雪".repeat(32768)}`]), /too long/u);
});

test("Rust partition inventory rejects missing, unexpected, and duplicate listed tests", () => {
  const assigned = ["crate first", "crate second"];
  assert.doesNotThrow(() => assertRustPartitionInventory(assigned, assigned.toReversed()));
  for (const listed of [
    [],
    assigned.slice(1),
    [...assigned, "crate extra"],
    [assigned[0], assigned[0]],
  ])
    assert.throws(
      () => assertRustPartitionInventory(assigned, listed),
      /differs from its assignment/u,
    );
});

test("Rust time refresh records per-test medians and estimates the remaining work per binary", () => {
  const samples = rustTimingSamples(
    "\u001b[32mPASS [ 1.0s] (1/3) crate fast\u001b[0m\nPASS [ 9.0s] crate slow\nFAIL [ 2.0s] crate failed\nFLAKY 2/2 [ 1.0s] crate retry\nPASS [ 0.0s] other tiny",
  );
  assert.deepEqual(samples, [
    { id: "crate fast", seconds: 1 },
    { id: "crate slow", seconds: 9 },
    { id: "other tiny", seconds: 0 },
  ]);
  const rows = [
    ...samples,
    { id: "crate fast", seconds: 2 },
    { id: "crate small", seconds: 0.5 },
    { id: "crate slow", seconds: 5 },
    { id: "crate slow", seconds: 100 },
  ];
  assert.deepEqual(recordedRustTimes(rows), {
    thresholdSeconds: 2,
    defaultSeconds: 0.667,
    binaries: { crate: 1, other: 0.001 },
    tests: { "crate slow": 9 },
  });
  assert.deepEqual(recordedRustTimes(rows), recordedRustTimes(rows.toReversed()));
  assert.deepEqual(recordedRustTimes([{ id: "crate boundary", seconds: 2 }]).tests, {
    "crate boundary": 2,
  });
  assert.throws(() => recordedRustTimes([]), /No passed/u);
});

function passingCloudJobs() {
  const { jobs } = JSON.parse(
    readFileSync(new URL("./fixtures/passing-cloud-jobs.json", import.meta.url), "utf8"),
  );
  const active = new Set(Object.values(CLOUD_JOB_GRAPH).flatMap((node) => node.names));
  return jobs.filter((job) => active.has(job.name));
}

const apiEnv = {
  GITHUB_API_URL: "https://api.example.test",
  GITHUB_REPOSITORY: "test/repo",
  GITHUB_RUN_ID: "1",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_TOKEN: "fixture",
};
const apiResponse = (value, status = 200, etag = '"fixture"') =>
  new Response(status === 304 ? null : JSON.stringify(value), {
    status,
    headers: {
      etag,
      "x-ratelimit-limit": "1000",
      "x-ratelimit-remaining": "997",
      "x-ratelimit-used": "3",
    },
  });
function dependencyFinishedAt(jobs, name) {
  const node = Object.values(CLOUD_JOB_GRAPH).find((node) => node.names.includes(name));
  if (!node?.needs.length) return Date.parse(jobs.find((job) => job.name === name).started_at);
  return Math.max(
    ...node.needs
      .flatMap((id) => CLOUD_JOB_GRAPH[id].names)
      .map((name) => Date.parse(jobs.find((job) => job.name === name).completed_at)),
  );
}
const withoutWaits = () => {
  const jobs = passingCloudJobs();
  for (const job of jobs) {
    if (job.name !== "what changed")
      job.started_at = new Date(dependencyFinishedAt(jobs, job.name)).toISOString();
    job.created_at = job.started_at;
  }
  return jobs;
};
function withRunnerWait(jobs, name, seconds) {
  const job = jobs.find((job) => job.name === name),
    ready = dependencyFinishedAt(jobs, name);
  job.created_at = new Date(ready).toISOString();
  job.started_at = new Date(ready + seconds * 1000).toISOString();
}

test("the timing fixture covers every current workflow job name exactly once", () => {
  const expected = Object.values(CLOUD_JOB_GRAPH)
    .flatMap((job) => job.names)
    .sort();
  assert.deepEqual(
    passingCloudJobs()
      .filter((job) => expected.includes(job.name))
      .map((job) => job.name)
      .sort(),
    expected,
  );
});

test("the adapted saved run includes shared preparation in the gate span", () => {
  const jobs = passingCloudJobs();
  for (const [scope, seconds] of [
    ["js", 241],
    ["rust", 419],
  ]) {
    const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(result.spanSeconds, seconds);
    assert.equal("confinementSeconds" in result, false);
    assert.equal(result.seconds, seconds);
    assert.equal(result.contended, false);
    assert.equal(result.timing, "within budget");
    assert.ok(result.jobs.every((job) => Number.isFinite(job.runnerWaitSeconds)));
  }
  const prepared = jobs.find((job) => job.name === "shared preparation");
  prepared.completed_at = new Date(Date.parse(jobs[0].started_at) + 242_000).toISOString();
  assert.equal(
    completedGateTiming("js", jobs, jobs[0].head_sha).seconds,
    242,
    "preparation finishes one second after the saved JavaScript gate",
  );
});

test("run 43478162335 adapted to the current graph retains its span", () => {
  const { jobs } = JSON.parse(
    readFileSync(new URL("./fixtures/folded-passing-run.json", import.meta.url), "utf8"),
  );
  const active = new Set(Object.values(CLOUD_JOB_GRAPH).flatMap((node) => node.names));
  const filtered = jobs.filter((job) => active.has(job.name));
  for (const [scope, seconds] of [
    ["js", 280],
    ["rust", 432],
  ]) {
    const result = completedGateTiming(scope, filtered, filtered[0].head_sha);
    assert.equal(result.seconds, seconds);
    assert.equal(result.contended, false);
    assert.equal(result.timing, "within budget");
  }
});

test("uncontended ceiling overruns fail; contended overruns retain their measured span", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const [scope, finalJob, budget] of [
    ["js", "JS worker 0", 400],
    ["rust", "Rust tests 0", 700],
  ]) {
    const jobs = withoutWaits(),
      start = Date.parse(jobs[0].started_at);
    const last = jobs.find((job) => job.name === finalJob);
    last.completed_at = new Date(start + (budget + 50) * 1000).toISOString();
    assert.throws(
      () => completedGateTiming(scope, jobs, jobs[0].head_sha),
      (error) => {
        assert.equal(error.timing.seconds, budget + 50);
        assert.equal(error.timing.timing, "over budget");
        return /exceeding.*budget/u.test(error.message);
      },
    );
    withRunnerWait(jobs, finalJob, 30);
    assert.throws(
      () => completedGateTiming(scope, jobs, jobs[0].head_sha),
      /exceeding/u,
      "30 seconds does not count as contention",
    );
    withRunnerWait(jobs, finalJob, 31);
    const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(result.contended, true);
    assert.equal(result.timing, "unmeasured");
    assert.match(
      result.warning,
      new RegExp(`${budget + 50}s.*${budget - 100}s.*${finalJob}.*31s`, "u"),
    );
    last.completed_at = new Date(start + (budget - 100) * 1000).toISOString();
    const within = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(within.contended, true);
    assert.equal(within.timing, "within budget");
    assert.equal(within.warning, undefined);
  }
  assert.equal(
    warn.mock.calls.length,
    0,
    "timing classification leaves warning emission to final verification",
  );
});

test("shared preparation uses the wall span and its runner wait counts as contention", (t) => {
  t.mock.method(console, "warn", () => {});
  const name = "shared preparation";
  for (const scope of ["js", "rust"]) {
    const jobs = withoutWaits(),
      proof = jobs.find((job) => job.name === name);
    proof.completed_at = new Date(Date.parse(jobs[0].started_at) + 750_000).toISOString();
    assert.throws(
      () => completedGateTiming(scope, jobs, jobs[0].head_sha),
      (error) => {
        assert.equal(error.timing.seconds, 750);
        assert.equal(error.timing.contended, false);
        return /exceeding/u.test(error.message);
      },
    );
    proof.started_at = new Date(Date.parse(proof.started_at) + 7_200_000).toISOString();
    proof.completed_at = new Date(Date.parse(proof.completed_at) + 7_200_000).toISOString();
    const result = completedGateTiming(scope, jobs, jobs[0].head_sha);
    assert.equal(result.seconds, 7950);
    assert.equal(result.spanSeconds, result.seconds);
    assert.equal(result.contended, true);
    assert.equal(result.timing, "unmeasured");
    assert.ok(result.warning.includes(name));
  }
});

test("a failed JavaScript worker leaves Rust's independent verdict visible", () => {
  const jobs = withoutWaits();
  jobs.find((job) => job.name === "JS worker 1").conclusion = "failure";
  assert.throws(() => completedGateTiming("js", jobs, jobs[0].head_sha), /unsuccessful/u);
  assert.equal(completedGateTiming("rust", jobs, jobs[0].head_sha).timing, "within budget");
  const last = jobs.find((job) => job.name === "Rust tests 0");
  last.completed_at = new Date(Date.parse(jobs[0].started_at) + 750_000).toISOString();
  assert.throws(() => completedGateTiming("rust", jobs, jobs[0].head_sha), /exceeding/u);
});

test("contention counts only waits that can occur inside the gate span", (t) => {
  t.mock.method(console, "warn", () => {});
  const jobs = withoutWaits(),
    start = Date.parse(jobs[0].started_at);
  jobs[0].created_at = new Date(start - 31_000).toISOString();
  jobs.find((job) => job.name === "JS worker 0").completed_at = new Date(
    start + 450_000,
  ).toISOString();
  assert.throws(() => completedGateTiming("js", jobs, jobs[0].head_sha), /exceeding/u);
  jobs.find((job) => job.name === "Rust tests 0").completed_at = new Date(
    start + 750_000,
  ).toISOString();
  assert.throws(() => completedGateTiming("rust", jobs, jobs[0].head_sha), /exceeding/u);
  const js = jobs.find((job) => job.name === "JS worker 1");
  withRunnerWait(jobs, js.name, 300);
  js.completed_at = new Date(Date.parse(js.started_at) + 1000).toISOString();
  js.conclusion = "failure";
  assert.throws(
    () => completedGateTiming("rust", jobs, jobs[0].head_sha),
    (error) => {
      assert.equal(error.timing.contended, false);
      assert.equal(error.timing.timing, "over budget");
      assert.equal(error.timing.warning, undefined);
      return /exceeding/u.test(error.message);
    },
    "a JavaScript worker's wait does not excuse Rust's overrun",
  );
  for (const absent of [false, true]) {
    const onlyRust = withoutWaits().filter((job) => !absent || !job.name.startsWith("JS worker"));
    for (const job of onlyRust.filter((job) => job.name.startsWith("JS worker"))) {
      Object.assign(job, { conclusion: "skipped", started_at: null, completed_at: null });
    }
    assert.equal(completedGateTiming("rust", onlyRust, jobs[0].head_sha).timing, "within budget");
  }
});

test("negative waits clamp to zero and invalid or incomplete evidence always fails", () => {
  const jobs = withoutWaits();
  jobs.forEach((job) => {
    job.created_at = job.completed_at;
  });
  assert.ok(
    completedGateTiming("js", jobs, jobs[0].head_sha).jobs.every(
      (job) => job.runnerWaitSeconds === 0,
    ),
  );
  for (const scope of ["js", "rust"])
    for (const mutate of [
      ...["shared preparation"].flatMap((name) => [
        (rows) =>
          rows.splice(
            rows.findIndex((job) => job.name === name),
            1,
          ),
        (rows) => rows.push(rows.find((job) => job.name === name)),
        ...["cancelled", "failure", "skipped"].map((conclusion) => (rows) => {
          rows.find((job) => job.name === name).conclusion = conclusion;
        }),
        (rows) => {
          rows.find((job) => job.name === name).head_sha = "other";
        },
      ]),
      ...[
        scope === "js" ? `JS worker ${JS_SHARDS - 2}` : "Rust tests 1",
        scope === "js" ? `JS worker ${JS_SHARDS - 1}` : `Rust tests ${RUST_SHARDS - 1}`,
      ].flatMap((name) => [
        (rows) =>
          rows.splice(
            rows.findIndex((job) => job.name === name),
            1,
          ),
        (rows) => rows.push(rows.find((job) => job.name === name)),
        (rows) => {
          rows.find((job) => job.name === name).conclusion = "cancelled";
        },
        (rows) => {
          rows.find((job) => job.name === name).head_sha = "other";
        },
      ]),
      (rows) => {
        rows[0].head_sha = "other-head";
      },
      (rows) => {
        rows[0].created_at = "invalid";
      },
      (rows) => {
        rows[0].completed_at = rows[0].created_at;
        rows[0].started_at = "invalid";
      },
    ]) {
      const broken = passingCloudJobs();
      const prepared = broken.find((job) => job.name === "shared preparation");
      prepared.created_at = new Date(Date.parse(prepared.started_at) - 31_000).toISOString();
      mutate(broken);
      assert.throws(() => completedGateTiming(scope, broken, jobs[0].head_sha));
    }
});

test("prepared artifact body aborts get one fresh transfer inside the preparation cap", async (t) => {
  t.mock.method(console, "log", () => {});
  for (const failures of [0, 1, 2])
    for (const kind of ["TimeoutError", "AbortError", "TypeError"]) {
      let clock = 0,
        downloads = 0;
      const cause =
        kind === "TypeError" ? new TypeError("terminated") : new DOMException("body aborted", kind);
      const result = waitForPreparation("js", {
        env: apiEnv,
        now: () => clock,
        pause: async () => assert.fail("no readiness pause for body aborts"),
        download: (response) => response.text(),
        request: async (url) => {
          if (url.includes("/jobs?"))
            return apiResponse({
              jobs: [{ name: "shared preparation", status: "completed", conclusion: "success" }],
            });
          if (url.includes("/artifacts?"))
            return apiResponse({ artifacts: [{ id: 42, name: "javascript-prepared-1" }] });
          downloads++;
          return new Response(
            downloads > failures
              ? "complete archive"
              : new ReadableStream(
                  {
                    pull(controller) {
                      clock += 60_000;
                      controller.error(cause);
                    },
                  },
                  { highWaterMark: 0 },
                ),
          );
        },
      });
      if (failures === 2)
        await assert.rejects(result, (error) => {
          assert.equal(error.cause, cause);
          assert.equal(
            error.message,
            "Preparation artifact javascript-prepared-1 (42) body transfer failed after 120s (2 attempts).",
          );
          return true;
        });
      else assert.equal((await result).value, "complete archive");
      assert.equal(downloads, failures === 0 ? 1 : 2);
    }
  let clock = 0,
    downloads = 0;
  await assert.rejects(
    waitForPreparation("js", {
      env: apiEnv,
      now: () => clock,
      download: (response) => response.text(),
      request: async (url) => {
        if (url.includes("/jobs?"))
          return apiResponse({ jobs: [{ name: "shared preparation", status: "in_progress" }] });
        if (url.includes("/artifacts?")) {
          clock = 850_000;
          return apiResponse({ artifacts: [{ id: 42, name: "javascript-prepared-1" }] });
        }
        downloads++;
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                clock = 900_000;
                controller.error(new DOMException("body aborted", "TimeoutError"));
              },
            },
            { highWaterMark: 0 },
          ),
        );
      },
    }),
    /javascript-prepared-1.*body transfer failed after 50s \(1 attempt\)/u,
  );
  assert.equal(downloads, 1, "the preparation deadline must prevent a second transfer");
});

for (const [name, bodyMs, recovers] of [
  ["a slow second body completes", 75_000, true],
  ["two stalled bodies exhaust both transfers", 180_000, false],
]) {
  test(`prepared artifact body timeout: ${name}`, async (t) => {
    t.mock.method(console, "log", () => {});
    let clock = 0,
      timeout;
    const attempts = [];
    t.mock.method(AbortSignal, "timeout", (ms) => {
      const controller = new AbortController();
      timeout = { ms, controller };
      return controller.signal;
    });
    const result = waitForPreparation("js", {
      env: apiEnv,
      now: () => clock,
      pause: async () => assert.fail("no readiness pause for body timeouts"),
      download: (response) => response.text(),
      request: async (url, { signal }) => {
        if (url.includes("/artifacts?"))
          return apiResponse({ artifacts: [{ id: 42, name: "javascript-prepared-1" }] });
        assert.match(url, /\/artifacts\/42\/zip$/u);
        const { ms, controller } = timeout;
        attempts.push(ms);
        return new Response(
          new ReadableStream(
            {
              pull(body) {
                clock += Math.min(ms, bodyMs);
                if (ms < bodyMs) {
                  controller.abort(new DOMException("body timed out", "TimeoutError"));
                  body.error(signal.reason);
                } else {
                  body.enqueue(Buffer.from("complete archive"));
                  body.close();
                }
              },
            },
            { highWaterMark: 0 },
          ),
        );
      },
    });
    if (recovers) assert.equal((await result).value, "complete archive");
    else await assert.rejects(result, /body transfer failed after 180s \(2 attempts\)/u);
    assert.deepEqual(attempts, [60_000, 120_000]);
  });
}

test("workflow reads retry transient responses and request errors within their caller's deadline", async (t) => {
  for (const first of [
    500,
    429,
    new TypeError("fetch failed"),
    new DOMException("request stalled", "TimeoutError"),
  ]) {
    let clock = 0,
      attempts = 0;
    const api = cloudApi({
      env: apiEnv,
      now: () => clock,
      deadline: 15_000,
      pause: async (ms) => {
        assert.equal(ms, 1_000);
        clock += ms;
      },
      request: async () => {
        if (++attempts > 1) return apiResponse({ ok: true });
        if (typeof first !== "number") throw first;
        return apiResponse(null, first);
      },
    });
    assert.deepEqual(await api.read("/artifacts"), { ok: true });
    assert.equal(attempts, 2);
    assert.equal(clock, 1_000);
  }
  for (const [status, expected] of [
    [500, 3],
    [429, 3],
    [404, 1],
    [403, 1],
  ]) {
    let clock = 0,
      attempts = 0;
    const api = cloudApi({
      env: apiEnv,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      request: async () => {
        attempts++;
        return apiResponse(null, status);
      },
    });
    await assert.rejects(
      api.read("/artifacts"),
      new RegExp(`Cannot read workflow /artifacts: HTTP ${status} after ${expected} attempt`, "u"),
    );
    assert.equal(attempts, expected);
    assert.equal(clock, (expected - 1) * 1_000);
  }
  for (const deadline of [0, 500, 1_500]) {
    let clock = 0,
      attempts = 0;
    const api = cloudApi({
      env: apiEnv,
      now: () => clock,
      deadline,
      pause: async (ms) => {
        clock += ms;
      },
      request: async () => {
        assert.ok(clock < deadline);
        attempts++;
        return apiResponse(null, 500);
      },
    });
    await assert.rejects(api.jobs(), /Cannot read workflow.*after.*attempt/u);
    assert.equal(clock, deadline);
    assert.equal(attempts, Math.ceil(deadline / 1_000));
  }
  for (const failedRead of ["jobs", "artifacts"]) {
    let clock = 0,
      failures = 0;
    await waitForPreparation("js", {
      env: apiEnv,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      request: async (url) => {
        if (url.includes(`/${failedRead}?`) && failures++ === 0) return apiResponse(null, 500);
        if (url.includes("/jobs?"))
          return apiResponse({
            jobs: [{ name: "shared preparation", status: "completed", conclusion: "success" }],
          });
        if (url.includes("/artifacts?"))
          return apiResponse({
            artifacts:
              failedRead === "jobs" && clock < 121_000
                ? []
                : [{ id: 42, name: "javascript-prepared-1" }],
          });
        return apiResponse("archive");
      },
    });
    assert.equal(failures, 2);
    assert.equal(clock, failedRead === "jobs" ? 131_000 : 1_000);
  }
});

test("workflow reads retry cut-off JSON bodies within the caller deadline", async () => {
  for (const kind of ["TypeError", "TimeoutError"])
    for (const failures of [0, 1, 3]) {
      let clock = 0,
        requests = 0;
      const cause =
        kind === "TypeError"
          ? new TypeError("terminated")
          : new DOMException("body timed out", kind);
      const api = cloudApi({
        env: apiEnv,
        now: () => clock,
        deadline: 15_000,
        pause: async (ms) => {
          clock += ms;
        },
        request: async () => {
          requests++;
          return requests > failures
            ? apiResponse({ ok: true })
            : new Response(
                new ReadableStream(
                  {
                    pull(controller) {
                      clock += 200;
                      controller.error(cause);
                    },
                  },
                  { highWaterMark: 0 },
                ),
              );
        },
      });
      if (failures === 3)
        await assert.rejects(api.read("/artifacts"), (error) => {
          assert.equal(error.cause, cause);
          assert.equal(
            error.message,
            `Cannot read workflow /artifacts: ${cause.message} after 3 attempts.`,
          );
          return true;
        });
      else assert.deepEqual(await api.read("/artifacts"), { ok: true });
      assert.equal(requests, failures === 0 ? 1 : failures === 1 ? 2 : 3);
      assert.equal(clock, failures === 0 ? 0 : failures === 1 ? 1_200 : 2_600);
    }
  let clock = 0,
    requests = 0;
  const api = cloudApi({
    env: apiEnv,
    now: () => clock,
    deadline: 500,
    pause: async (ms) => {
      clock += ms;
    },
    request: async () => {
      requests++;
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              clock = 200;
              controller.error(new TypeError("terminated"));
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
  });
  await assert.rejects(api.read("/artifacts"), /terminated after 1 attempt/u);
  assert.equal(clock, 500);
  assert.equal(requests, 1, "the deadline prevents another JSON-body attempt");
});

test("prepared artifact body timing excludes readiness retries", async (t) => {
  t.mock.method(console, "log", () => {});
  let clock = 0,
    downloads = 0;
  await assert.rejects(
    waitForPreparation("js", {
      env: apiEnv,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      download: (response) => response.text(),
      request: async (url) => {
        if (url.includes("/jobs?"))
          return apiResponse({
            jobs: [{ name: "shared preparation", status: "completed", conclusion: "success" }],
          });
        if (url.includes("/artifacts?"))
          return apiResponse({ artifacts: [{ id: 42, name: "javascript-prepared-1" }] });
        if (++downloads <= 2) return apiResponse(null, 404);
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                clock += 1000;
                controller.error(new TypeError("terminated"));
              },
            },
            { highWaterMark: 0 },
          ),
        );
      },
    }),
    /body transfer failed after 2s \(2 attempts\)/u,
  );
  assert.equal(clock, 6000);
  assert.equal(downloads, 4);
});

for (const [scope, jobName, artifact] of [["js", "shared preparation", "javascript-prepared"]]) {
  test(`${scope} preparation polls artifacts conditionally before reading jobs`, async (t) => {
    let clock = 0,
      jobReads = 0,
      artifactReads = 0;
    const log = t.mock.method(console, "log", () => {});
    const result = await waitForPreparation(scope, {
      env: apiEnv,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      request: async (url, { headers }) => {
        assert.equal(headers.Authorization, "Bearer fixture");
        if (url.includes("/jobs?")) {
          jobReads++;
          return apiResponse(
            { jobs: [{ name: jobName, status: clock < 60_000 ? "queued" : "in_progress" }] },
            200,
            `"jobs-${jobReads}"`,
          );
        }
        if (url.endsWith("/zip")) return apiResponse("archive");
        artifactReads++;
        if (artifactReads === 1)
          return apiResponse(
            {
              artifacts: [
                { name: `${artifact}-10`, expired: false },
                { name: `${artifact}-1`, expired: true },
              ],
            },
            200,
            '"empty"',
          );
        assert.equal(headers["If-None-Match"], '"empty"');
        return artifactReads === 2
          ? apiResponse(null, 304)
          : apiResponse({ artifacts: [{ id: 42, name: `${artifact}-1`, expired: false }] });
      },
    });
    assert.equal(result.artifact.id, 42);
    assert.equal(clock, 5_000);
    assert.equal(jobReads, 0);
    assert.match(
      log.mock.calls.at(-1).arguments[0],
      new RegExp(
        `x-ratelimit-limit=1000 x-ratelimit-remaining=997 x-ratelimit-used=3 counted=3 304=1`,
        "u",
      ),
    );
  });

  test(`${scope} listed artifacts retry transient download statuses before returning`, async () => {
    for (const status of [404, 429, 500, 503]) {
      let clock = 0,
        downloads = 0;
      const result = await waitForPreparation(scope, {
        env: apiEnv,
        download: scope === "js" ? (response) => response.json() : false,
        now: () => clock,
        pause: async (ms) => {
          assert.equal(ms, 2_000);
          clock += ms;
        },
        request: async (url, { headers }) => {
          if (url.includes("/jobs?"))
            return apiResponse({ jobs: [{ name: jobName, status: "in_progress" }] });
          if (url.includes("/artifacts?"))
            return apiResponse({ artifacts: [{ id: 42, name: `${artifact}-1` }] });
          assert.equal(url, "https://api.example.test/repos/test/repo/actions/artifacts/42/zip");
          assert.equal(headers["If-None-Match"], undefined);
          return ++downloads < 3 ? apiResponse(null, status) : apiResponse("archive");
        },
      });
      assert.equal(downloads, 3);
      assert.equal(clock, 4_000);
      assert.equal(result.artifact.id, 42);
      if (scope === "js")
        assert.equal(
          result.value,
          "archive",
          "JS consumes the successful response without another request",
        );
      else
        assert.equal(
          result.value,
          undefined,
          "Rust only checks readiness before its download action",
        );
    }
  });

  test(`${scope} listed artifacts cap transient download statuses at 30 seconds and reject other failures`, async () => {
    for (const status of [404, 429, 500, 503, 403]) {
      let clock = 0,
        downloads = 0;
      await assert.rejects(
        waitForPreparation(scope, {
          env: apiEnv,
          now: () => clock,
          pause: async (ms) => {
            clock += ms;
          },
          request: async (url) => {
            if (url.includes("/jobs?"))
              return apiResponse({ jobs: [{ name: jobName, status: "in_progress" }] });
            if (url.includes("/artifacts?"))
              return apiResponse({ artifacts: [{ id: 42, name: `${artifact}-1` }] });
            downloads++;
            return apiResponse(null, status);
          },
        }),
        status !== 403 ? /listed but never became downloadable.*30/u : /HTTP 403/u,
      );
      assert.equal(clock, status !== 403 ? 30_000 : 0);
      assert.equal(downloads, status !== 403 ? 15 : 1);
    }
  });

  test(`${scope} artifact request errors retry within the readiness cap and preserve the last cause`, async () => {
    for (const persistent of [false, true]) {
      let clock = 0,
        downloads = 0;
      const causes = [];
      const waiting = waitForPreparation(scope, {
        env: apiEnv,
        now: () => clock,
        pause: async (ms) => {
          assert.equal(ms, 2_000);
          clock += ms;
        },
        request: async (url) => {
          if (url.includes("/jobs?"))
            return apiResponse({ jobs: [{ name: jobName, status: "in_progress" }] });
          if (url.includes("/artifacts?"))
            return apiResponse({ artifacts: [{ id: 42, name: `${artifact}-1` }] });
          downloads++;
          if (!persistent && downloads === 2) return apiResponse("archive");
          const cause = new TypeError("fetch failed");
          causes.push(cause);
          throw cause;
        },
      });
      if (persistent)
        await assert.rejects(waiting, (error) => {
          assert.equal(
            error.message,
            `Preparation artifact ${artifact}-1 download timed out waiting for a response within its 30-second retry cap.`,
          );
          assert.equal(error.cause, causes.at(-1));
          return true;
        });
      else assert.equal((await waiting).artifact.id, 42);
      assert.equal(downloads, persistent ? 15 : 2);
      assert.equal(clock, persistent ? 30_000 : 2_000);
    }
  });

  test(`${scope} download caps preserve the cause and distinguish stalls from observed 404s`, async () => {
    for (const saw404 of [false, true]) {
      let clock = 0,
        downloads = 0;
      const cause = new Error("download connection stalled");
      await assert.rejects(
        waitForPreparation(scope, {
          env: apiEnv,
          now: () => clock,
          pause: async (ms) => {
            clock += ms;
          },
          request: async (url) => {
            if (url.includes("/jobs?"))
              return apiResponse({ jobs: [{ name: jobName, status: "in_progress" }] });
            if (url.includes("/artifacts?"))
              return apiResponse({ artifacts: [{ id: 42, name: `${artifact}-1` }] });
            if (++downloads === 1 && saw404) return apiResponse(null, 404);
            clock = 30_000;
            throw cause;
          },
        }),
        (error) => {
          assert.equal(error.cause, cause);
          assert.equal(
            error.message,
            saw404
              ? `Preparation artifact ${artifact}-1 was listed but never became downloadable within its 30-second retry cap.`
              : `Preparation artifact ${artifact}-1 download timed out waiting for a response within its 30-second retry cap.`,
          );
          return true;
        },
      );
      assert.equal(downloads, saw404 ? 2 : 1);
    }
  });

  test(`${scope} unchanged artifact bodies on 200 permanently slow polling to 10 seconds`, async () => {
    let clock = 0,
      reads = 0;
    const pauses = [];
    await waitForPreparation(scope, {
      env: apiEnv,
      now: () => clock,
      pause: async (ms) => {
        pauses.push(ms);
        clock += ms;
      },
      request: async (url, { headers }) => {
        if (url.includes("/jobs?"))
          return apiResponse({ jobs: [{ name: jobName, status: "in_progress" }] });
        if (url.endsWith("/zip")) return apiResponse("archive");
        reads++;
        if (reads > 1)
          assert.equal(headers["If-None-Match"], reads === 2 ? '"first"' : '"changed"');
        if (reads <= 2)
          return apiResponse({ artifacts: [] }, 200, reads === 1 ? '"first"' : '"changed"');
        if (reads === 3) return apiResponse(null, 304);
        return apiResponse({ artifacts: [{ id: 42, name: `${artifact}-1` }] });
      },
    });
    assert.deepEqual(pauses, [2_500, 10_000, 10_000]);
    assert.equal(clock, 22_500);
  });

  const capMinutes = scope === "rust" ? 25 : 15,
    cap = capMinutes * 60_000;
  test(`${scope} preparation stops after ${capMinutes} minutes with the last observed build state`, async () => {
    for (const state of ["queued", "in_progress", "missing", "completed"]) {
      let clock = 0,
        lastJobRead = -1;
      const jobReadTimes = [];
      await assert.rejects(
        waitForPreparation(scope, {
          env: apiEnv,
          now: () => clock,
          pause: async (ms) => {
            clock += ms;
          },
          request: async (url) => {
            if (url.includes("/jobs?")) {
              lastJobRead = clock;
              jobReadTimes.push(clock);
              return apiResponse({
                jobs:
                  state === "missing"
                    ? []
                    : [
                        {
                          name: jobName,
                          status: state,
                          conclusion: state === "completed" ? "success" : null,
                        },
                      ],
              });
            }
            return apiResponse({ artifacts: [] });
          },
        }),
        new RegExp(
          `${capMinutes}-minute wait cap.*${state === "missing" ? "build job missing from the job list" : state === "completed" ? "no published artifact" : state === "queued" ? "queued for a runner" : "running"}`,
          "u",
        ),
      );
      assert.equal(clock, cap);
      assert.equal(lastJobRead, cap, "the cap refreshes the build state");
      // The build job is read every two minutes until the cap, then once more at the cap.
      assert.deepEqual(jobReadTimes, [
        ...Array.from(
          { length: Math.ceil(cap / 120_000) - 1 },
          (_, index) => (index + 1) * 120_000,
        ),
        cap,
      ]);
    }
    for (const conclusion of ["failure", "cancelled", "skipped", "duplicate"]) {
      let clock = 0;
      await assert.rejects(
        waitForPreparation(scope, {
          env: apiEnv,
          now: () => clock,
          pause: async (ms) => {
            clock += ms;
          },
          request: async (url) =>
            url.includes("/jobs?")
              ? apiResponse({
                  jobs:
                    conclusion === "duplicate"
                      ? [{ name: jobName }, { name: jobName }]
                      : [{ name: jobName, status: "completed", conclusion }],
                })
              : apiResponse({ artifacts: [] }),
        }),
        conclusion === "duplicate" ? /Duplicate/u : new RegExp(`ended with ${conclusion}`, "u"),
      );
      assert.equal(clock, 120_000);
    }
  });
}

test("polling waits for initially missing jobs and rejects invalid HTTP responses", async () => {
  let clock = 0,
    reads = 0;
  await waitForPreparation("js", {
    env: apiEnv,
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
    },
    request: async (url) =>
      url.includes("/jobs?")
        ? apiResponse({
            jobs: ++reads === 1 ? [] : [{ name: "shared preparation", status: "in_progress" }],
          })
        : apiResponse({ artifacts: [{ id: 1, name: "javascript-prepared-1" }] }),
  });
  assert.equal(clock, 0);
  assert.equal(reads, 0);
  for (const status of [304, 503]) {
    await assert.rejects(
      waitForPreparation("js", {
        env: apiEnv,
        pause: async () => {},
        request: async () => apiResponse(null, status),
      }),
      status === 304 ? /no cached data/u : /HTTP 503/u,
    );
  }
  await assert.rejects(
    waitForPreparation("js", {
      env: apiEnv,
      request: async (url) =>
        url.includes("/jobs?")
          ? apiResponse({ jobs: [{ name: "shared preparation", status: "in_progress" }] })
          : apiResponse(null, 304),
    }),
    /no cached data/u,
  );
  await assert.rejects(waitForPreparation("rust", { env: apiEnv }), /Only JavaScript workers/u);
});

function writeTimingReceipts(root, scope, commit) {
  const all = Array.from(
    { length: scope === "js" ? JS_SHARDS : RUST_SHARDS },
    (_, i) => `task-${i}`,
  );
  const records =
    scope === "js"
      ? [
          { part: "prepare-0" },
          ...all.map((id, index) => ({
            part: `worker-${index}`,
            planned: all,
            assigned: [id],
            completed: [id],
            tests: [],
            ...(!index ? { selfHostNative: {} } : {}),
          })),
        ]
      : [
          { part: "policy", steps: RUST_POLICY_STEPS.map((name) => ({ name, status: "PASS" })) },
          {
            part: "archive-0",
            planned: all,
            steps: RUST_ARCHIVE_PROOFS.map((name) => ({ name, verdict: "PASS" })),
          },
          ...all.map((id, index) => ({
            part: `tests-${index}`,
            planned: all,
            assigned: [id],
            completed: [id],
            steps:
              index === RUST_READER_SHARD
                ? RUST_TEST_PROOFS.map((name) => ({ name, verdict: "PASS" }))
                : [],
          })),
        ];
  for (const row of records) {
    const directory = join(root, `${row.part}-1`);
    mkdirSync(directory);
    writeFileSync(
      join(directory, "result.json"),
      JSON.stringify({
        scope,
        commit,
        verdict: "PASS",
        provenance: { status: "PASS" },
        scratch: { status: "PASS" },
        ...row,
      }),
    );
  }
}

test("delayed job creation in run 43235841741 is unmeasured", async (t) => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/delayed-job-creation.json", import.meta.url), "utf8"),
  );
  const origin = Date.parse(fixture.origin),
    commit = fixture.headSha;
  const active = new Set(Object.values(CLOUD_JOB_GRAPH).flatMap((node) => node.names));
  const recorded = fixture.jobs.filter(([name]) => active.has(name));
  const jobs = recorded.map(([name, created, started, completed]) => ({
    name,
    head_sha: commit,
    status: "completed",
    conclusion: "success",
    run_attempt: fixture.attempt,
    ...Object.fromEntries(
      [created, started, completed].map((seconds, index) => [
        ["created_at", "started_at", "completed_at"][index],
        new Date(origin + seconds * 1000).toISOString(),
      ]),
    ),
  }));
  assert.ok(jobs.every((job) => Date.parse(job.started_at) - Date.parse(job.created_at) <= 30_000));
  t.mock.method(console, "log", () => {});
  const warn = t.mock.method(console, "warn", () => {});
  for (const [scope, completedSeconds, longest, wait] of [
    ["js", 405, "JS worker 8", 126],
    ["rust", 857, "Rust build", 123],
  ])
    await t.test(scope, async () => {
      const root = mkdtempSync(join(tmpdir(), "creation-gap-")),
        outputDirectory = join(root, "aggregate");
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writeTimingReceipts(root, scope, commit);
      const env = {
        GITHUB_SHA: commit,
        DOHC_WORKFLOW_HEAD_SHA: commit,
        GITHUB_STEP_SUMMARY: join(root, "summary.md"),
      };
      await verifyCompletedCloud(scope, {
        directory: root,
        env,
        outputDirectory,
        readJobs: async () => jobs,
      });
      const completed = JSON.parse(
        readFileSync(join(outputDirectory, `${scope}-completed-result.json`), "utf8"),
      );
      assert.equal(completed.verdict, "PASS");
      assert.equal(completed.timing, "unmeasured");
      assert.equal(completed.contended, true);
      assert.equal(completed.seconds, completedSeconds);
      assert.equal(completed.jobs.find((job) => job.name === longest).runnerWaitSeconds, wait);
      assert.equal(
        completed.warning,
        `${scope} timing unmeasured: ${completedSeconds}s exceeds the ${scope === "js" ? 300 : 600}s target; longest wait for GitHub to start ${longest}: ${wait}s.`,
      );
      assert.equal(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), completed.warning + "\n");
      assert.equal(warn.mock.calls.at(-1).arguments[0], "::warning::" + completed.warning);
    });
});

for (const fixture of [
  {
    run: "45431027391",
    start: "2026-11-24T15:55:12Z",
    selectionEnd: 23,
    workerStart: 26,
    lateJob: ["JS worker 9", 300, 402],
    lastWork: ["JS worker 7", 329, 332],
    completedSeconds: 402,
    delay: 73,
  },
  {
    run: "45434028943",
    start: "2026-11-24T16:10:36Z",
    selectionEnd: 28,
    workerStart: 31,
    lateJob: ["JS worker 3", 291, 393],
    lastWork: ["JS worker 6", 303, 305],
    completedSeconds: 393,
    delay: 90,
  },
]) {
  test(`job completion delay in run ${fixture.run}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "completion-delay-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outputDirectory = join(root, "aggregate");
    const at = (seconds) => new Date(Date.parse(fixture.start) + seconds * 1000).toISOString();
    const jobs = withoutWaits();
    const selection = jobs.find((job) => job.name === "what changed");
    const commit = selection.head_sha;
    Object.assign(selection, {
      created_at: at(0),
      started_at: at(0),
      completed_at: at(fixture.selectionEnd),
    });
    for (const job of jobs.filter(
      (job) => job.name.startsWith("JS worker ") || job.name === "shared preparation",
    )) {
      const [, stepEnd, jobEnd] = [fixture.lateJob, fixture.lastWork].find(
        ([name]) => name === job.name,
      ) ?? [job.name, 230, 233];
      Object.assign(job, {
        created_at: at(fixture.selectionEnd),
        started_at: at(fixture.workerStart),
        completed_at: at(jobEnd),
        steps: [{ name: "Complete job", conclusion: "success", completed_at: at(stepEnd) }],
      });
    }
    writeTimingReceipts(root, "js", commit);
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "warn", () => {});

    const timing = await verifyCompletedCloud("js", {
      directory: root,
      env: { GITHUB_SHA: commit, DOHC_WORKFLOW_HEAD_SHA: commit },
      outputDirectory,
      readJobs: async () => structuredClone(jobs),
    });
    assert.equal(timing.timing, "unmeasured");
    assert.equal(timing.contended, true);
    assert.equal(timing.spanSeconds, fixture.completedSeconds);
    assert.equal(timing.completionDelaySeconds, fixture.delay);
    assert.equal(
      timing.warning,
      `js timing unmeasured: ${fixture.completedSeconds}s exceeds the 300s target; GitHub took ${fixture.delay}s to mark finished jobs complete.`,
    );

    const overBudget = structuredClone(jobs);
    const slowWork = overBudget.find((job) => job.name === fixture.lastWork[0]);
    const delayed = overBudget.find((job) => job.name === fixture.lateJob[0]);
    slowWork.steps[0].completed_at = at(401);
    slowWork.completed_at = at(403);
    delayed.completed_at = at(401 + fixture.delay);
    assert.throws(
      () => completedGateTiming("js", overBudget, commit),
      (error) => {
        assert.equal(error.timing.timing, "over budget");
        assert.equal(error.timing.completionDelaySeconds, fixture.delay);
        return /exceeding its 400s budget/u.test(error.message);
      },
    );
  });
}

test("self-host native proof retains JSON receipts in worker output and removes scratch DBs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "self-host-retain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeEngine = join(root, "dohc-workspace-engine");
  const workerOutput = join(root, "worker-output");
  mkdirSync(workerOutput, { recursive: true });
  writeFileSync(fakeEngine, "engine-bytes");
  const buildStub = `data:text/javascript,${encodeURIComponent(`
    export * from ${JSON.stringify(new URL("./build.mjs", import.meta.url).href)};
    export const stagedEnginePath = ${JSON.stringify(fakeEngine)};
  `)}`;
  const workerUrl = new URL("./cloud.mjs?self-host-retain", import.meta.url);
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return context.parentURL === workerUrl.href && specifier === "./build.mjs"
        ? { url: buildStub, shortCircuit: true }
        : next(specifier, context);
    },
  });
  t.after(() => hook.deregister());
  const { runJavascript } = await import(workerUrl.href);
  const taskName = "enrolls a self-hosted document, delivers edits across restart";
  const group = {
    id: `self-host-native:${taskName}`,
    kind: "self-host-native",
    native: true,
    weight: 15,
    tasks: [
      {
        id: `self-host-native:${taskName}`,
        kind: "self-host-native",
        name: taskName,
        file: "services/share-web/src/selfHostedLiveNative.integration.ts",
      },
    ],
  };
  let seenScratchDir;
  const record = { steps: [], tests: [], completed: [], flaky: [] };
  await runJavascript([group], record, () => {}, null, {
    directory: workerOutput,
    executeCommand: async (_command, args, options) => {
      const vitestOut = args
        .find((arg) => arg.startsWith("--outputFile.json="))
        .slice("--outputFile.json=".length);
      seenScratchDir = options.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
      writeFileSync(
        vitestOut,
        JSON.stringify({
          success: true,
          numFailedTests: 0,
          numPassedTests: 1,
          testResults: [{ assertionResults: [{ fullName: taskName, status: "passed" }] }],
        }),
      );
      const deliveryDir = join(seenScratchDir, "self-host-live-123");
      mkdirSync(deliveryDir, { recursive: true });
      writeFileSync(join(deliveryDir, "workspace.db-wal"), "large-wal-bytes");
      writeFileSync(
        join(deliveryDir, "result.json"),
        JSON.stringify({
          verdict: "PASS",
          executable: options.env.DOHC_SERVICE_HOST_PROOF_BINARY,
          sha256: options.env.DOHC_SERVICE_HOST_PROOF_SHA256,
          results: {
            ownerDelivery: {
              restartPreservedDraft: true,
              concurrentOwnerAndNamedEditsMerged: true,
              idleOwnerPulledRecipientEdit: true,
            },
            settledAndPublished: { ordinaryOwnerReadMatched: true },
          },
        }),
      );
    },
  });
  assert.ok(seenScratchDir && !existsSync(seenScratchDir), "scratch proof dir was removed");
  assert.ok(
    record.selfHostNative.path.startsWith(workerOutput),
    "delivery receipt stays inside worker output",
  );
  assert.ok(existsSync(record.selfHostNative.path), "delivery receipt exists on disk");
  assert.ok(existsSync(join(workerOutput, "self-host-0/vitest.json")), "vitest JSON retained");
  assert.ok(
    !existsSync(join(workerOutput, "self-host-0/self-host-live-123/workspace.db-wal")),
    "WAL scratch files stay out of worker output",
  );
});

test("a re-run of failed jobs aggregates each part's receipt from the newest attempt that ran it", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  for (const scope of ["js", "rust"]) {
    const root = mkdtempSync(join(tmpdir(), "partial-rerun-")),
      outputDirectory = join(root, "aggregate"),
      jobs = withoutWaits(),
      commit = jobs[0].head_sha,
      [part, rerun, final] =
        scope === "js"
          ? ["worker-3", "JS worker 3", "JS worker 0"]
          : ["tests-3", "Rust tests 3", "Rust tests 0"];
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeTimingReceipts(root, scope, commit);
    const first = join(root, `${part}-1`, "result.json"),
      passed = readFileSync(first, "utf8");
    mkdirSync(join(root, `${part}-2`));
    writeFileSync(join(root, `${part}-2`, "result.json"), passed);
    writeFileSync(first, JSON.stringify({ ...JSON.parse(passed), verdict: "FAIL", completed: [] }));
    const rerunAt = Date.parse(jobs.find((job) => job.name === final).completed_at) + 3_600_000;
    for (const job of jobs) {
      job.created_at = new Date(rerunAt).toISOString();
      if (job.name === rerun) {
        job.started_at = job.created_at;
        job.completed_at = new Date(rerunAt + 200_000).toISOString();
      }
    }
    const run = () =>
      verifyCompletedCloud(scope, {
        directory: root,
        env: { GITHUB_SHA: commit, DOHC_WORKFLOW_HEAD_SHA: commit },
        outputDirectory,
        readJobs: async () => jobs,
      });
    const report = await run();
    assert.equal(report.verdict, "PASS");
    assert.equal(report.timing, "unmeasured");
    rmSync(join(root, `${part}-2`), { recursive: true });
    await assert.rejects(run(), new RegExp(`${part}|did not pass`, "u"));
  }
});

test("job creation waits follow each gate's dependencies", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  for (const [scope, name, ceiling] of [
    ["js", "shared preparation", 400],
    ["rust", "Rust tests 1", 700],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "creation-boundary-")),
      outputDirectory = join(root, "aggregate");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const commit = passingCloudJobs()[0].head_sha,
      env = { GITHUB_SHA: commit, DOHC_WORKFLOW_HEAD_SHA: commit };
    writeTimingReceipts(root, scope, commit);
    for (const wait of [30, 31]) {
      const jobs = withoutWaits(),
        start = Date.parse(jobs[0].started_at);
      const job = jobs.find((job) => job.name === name),
        ready = dependencyFinishedAt(jobs, name);
      if (scope === "rust")
        assert.equal(
          ready,
          Date.parse(jobs.find((job) => job.name === "Rust build").completed_at),
          "Rust tests become ready only after Rust build completes",
        );
      job.started_at = new Date(ready + wait * 1000).toISOString();
      job.created_at = new Date(ready + (wait - 1) * 1000).toISOString();
      const final = jobs.find(
        (job) => job.name === (scope === "js" ? "JS worker 0" : "Rust tests 0"),
      );
      const end = start + (ceiling + 1) * 1000;
      final.completed_at = new Date(end).toISOString();
      const completedRun = verifyCompletedCloud(scope, {
        directory: root,
        env,
        outputDirectory,
        readJobs: async () => jobs,
      });
      if (wait === 30) await assert.rejects(completedRun, /exceeding/u);
      else await completedRun;
      const completed = JSON.parse(
        readFileSync(join(outputDirectory, `${scope}-completed-result.json`), "utf8"),
      );
      assert.equal(completed.jobs.find((row) => row.name === name).runnerWaitSeconds, wait);
      assert.equal(completed.timing, wait === 31 ? "unmeasured" : "over budget");
      assert.equal(completed.contended, wait === 31);
    }
  }
});

test("job readiness falls back for later prerequisites and partial re-runs", () => {
  {
    const jobs = withoutWaits(),
      job = jobs.find((job) => job.name === "Rust tests 1"),
      start = Date.parse(jobs[0].started_at);
    job.started_at = new Date(Date.parse(job.started_at) + 200_000).toISOString();
    job.created_at = new Date(Date.parse(job.started_at) - 5000).toISOString();
    job.completed_at = new Date(Date.parse(job.started_at) + 1000).toISOString();
    jobs.find((job) => job.name === "Rust build").completed_at = new Date(
      Date.parse(job.started_at) + 1000,
    ).toISOString();
    jobs.find((job) => job.name === "Rust tests 0").completed_at = new Date(
      start + 750_000,
    ).toISOString();
    assert.throws(
      () => completedGateTiming("rust", jobs, jobs[0].head_sha),
      (error) => {
        assert.equal(error.timing.jobs.find((row) => row.name === job.name).runnerWaitSeconds, 5);
        return error.timing.timing === "over budget";
      },
    );
    job.created_at = new Date(Date.parse(job.started_at) - 31_000).toISOString();
    assert.match(
      completedGateTiming("rust", jobs, jobs[0].head_sha).warning,
      /longest runner wait Rust tests 1: 31s/u,
    );
  }
  for (const wait of [0, 31]) {
    const jobs = withoutWaits(),
      rerunAt = Date.parse(jobs.find((job) => job.name === "JS worker 0").completed_at) + 3_600_000;
    const fresh = [`JS worker ${JS_SHARDS - 1}`];
    for (const job of jobs) {
      job.created_at = new Date(rerunAt).toISOString();
      if (!fresh.includes(job.name)) continue;
      job.started_at = new Date(rerunAt + wait * 1000).toISOString();
      job.completed_at = new Date(rerunAt + 300_000).toISOString();
    }
    const timing = completedGateTiming("js", jobs, jobs[0].head_sha);
    assert.equal(timing.timing, "unmeasured");
    assert.equal(timing.jobs.find((row) => row.name === fresh[0]).runnerWaitSeconds, wait);
    assert.equal(
      timing.warning,
      `js timing unmeasured: ${timing.seconds}s exceeds the 300s target; part of the gate passed in an earlier attempt and did not run again${wait ? `; longest runner wait ${fresh[0]}: ${wait}s` : ""}.`,
    );
  }
});

test("timing warnings name the larger part of a job's scheduling wait", () => {
  for (const scope of ["js", "rust"])
    for (const [creation, runner, cause] of [
      [0, 200, "runner wait"],
      [1, 200, "runner wait"],
      [105, 21, "wait for GitHub to start"],
      [100, 100, "runner wait"],
    ]) {
      const jobs = withoutWaits(),
        worker = jobs.find((job) => job.name === (scope === "js" ? "JS worker 8" : "Rust tests 1")),
        ready = dependencyFinishedAt(jobs, worker.name);
      worker.created_at = new Date(ready + creation * 1000).toISOString();
      worker.started_at = new Date(ready + (creation + runner) * 1000).toISOString();
      worker.completed_at = new Date(Date.parse(worker.started_at) + 1000).toISOString();
      jobs.find(
        (job) => job.name === (scope === "js" ? "JS worker 0" : "Rust tests 0"),
      ).completed_at = new Date(Date.parse(jobs[0].started_at) + 750_000).toISOString();
      const timing = completedGateTiming(scope, jobs, jobs[0].head_sha);
      assert.equal(
        timing.warning,
        `${scope} timing unmeasured: 750s exceeds the ${scope === "js" ? 300 : 600}s target; longest ${cause} ${worker.name}: ${creation + runner}s.`,
      );
    }
});

test("Rust scheduling ignores JavaScript matrix metadata", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const root = mkdtempSync(join(tmpdir(), "skipped-needs-")),
    outputDirectory = join(root, "aggregate");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commit = passingCloudJobs()[0].head_sha,
    env = { GITHUB_SHA: commit, DOHC_WORKFLOW_HEAD_SHA: commit };
  writeTimingReceipts(root, "rust", commit);
  const names = CLOUD_JOB_GRAPH["javascript-workers"].names;
  const placeholderName = names[0].replace(/\d+$/u, "${{ matrix.shard }}");
  const modes = ["placeholder", "worker wait", "running workers"];
  for (const [mode, wait] of modes.flatMap((mode) => [5, 122].map((wait) => [mode, wait]))) {
    const original = withoutWaits(),
      workers = original.filter((job) => names.includes(job.name));
    const jobs = original.filter((job) => !names.includes(job.name)),
      ready = Date.parse(jobs.find((job) => job.name === "what changed").completed_at);
    if (mode === "placeholder") {
      jobs.push({
        name: placeholderName,
        head_sha: commit,
        conclusion: "skipped",
        status: "completed",
      });
    } else {
      for (const job of workers) {
        withRunnerWait(original, job.name, 300);
        job.completed_at = new Date(Date.parse(job.started_at) + 1000).toISOString();
        if (mode === "running workers")
          Object.assign(job, { status: "in_progress", conclusion: null, completed_at: null });
      }
      jobs.push(...workers);
    }
    const build = jobs.find((job) => job.name === "Rust build");
    build.created_at = new Date(ready + (wait - 5) * 1000).toISOString();
    build.started_at = new Date(ready + wait * 1000).toISOString();
    build.completed_at = new Date(ready + (wait + 1) * 1000).toISOString();
    for (const job of jobs.filter((job) => job.name.startsWith("Rust tests "))) {
      job.created_at = build.completed_at;
      job.started_at = build.completed_at;
      job.completed_at = new Date(Date.parse(build.completed_at) + 1000).toISOString();
    }
    const end = Date.parse(jobs[0].started_at) + 750_000;
    jobs.find((job) => job.name === "Rust tests 0").completed_at = new Date(end).toISOString();
    const contended = wait > 30;
    const finalRun = verifyCompletedCloud("rust", {
      directory: root,
      env,
      outputDirectory,
      readJobs: async () => jobs,
    });
    if (contended) await finalRun;
    else await assert.rejects(finalRun, /exceeding/u);
    for (const suffix of ["result", "completed-result"]) {
      const report = JSON.parse(readFileSync(join(outputDirectory, `rust-${suffix}.json`), "utf8"));
      assert.equal(report.timing, contended ? "unmeasured" : "over budget", mode);
      assert.equal(report.verdict, contended ? "PASS" : "FAIL", mode);
      assert.equal(report.contended, contended, mode);
      assert.equal(
        report.jobs.find((job) => job.name === "Rust build").runnerWaitSeconds,
        wait,
        mode,
      );
    }
  }
});

for (const [scope, finalJob, target, ceiling] of [
  ["js", "JS worker 0", 300, 400],
  ["rust", "Rust tests 0", 600, 700],
]) {
  test(`${scope} timing boundaries agree in full and completed receipts`, async (t) => {
    const parent = resolve(".agent-artifacts/verification");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "timing-boundaries-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const outputDirectory = join(root, "aggregate"),
      summary = join(root, "summary.md");
    const commit = passingCloudJobs()[0].head_sha;
    const env = {
      GITHUB_SHA: commit,
      DOHC_WORKFLOW_HEAD_SHA: commit,
      GITHUB_STEP_SUMMARY: summary,
    };
    writeTimingReceipts(root, scope, commit);
    t.mock.method(console, "log", () => {});
    const warn = t.mock.method(console, "warn", () => {});
    for (const seconds of [target, target + 1, ceiling, ceiling + 1])
      for (const wait of [0, 30, 31]) {
        await t.test(`${seconds}s with ${wait}s runner wait`, async () => {
          const jobs = withoutWaits(),
            start = Date.parse(jobs[0].started_at);
          const final = jobs.find((job) => job.name === finalJob);
          final.completed_at = new Date(start + seconds * 1000).toISOString();
          withRunnerWait(jobs, finalJob, wait);
          const timing =
            seconds <= target
              ? "within budget"
              : wait > 30
                ? "unmeasured"
                : seconds <= ceiling
                  ? "over target"
                  : "over budget";
          const fails = timing === "over budget";
          const warning =
            timing === "over target"
              ? `${scope} timing over target: ${seconds}s exceeds the ${target}s target; the gate fails above ${ceiling}s.`
              : timing === "unmeasured"
                ? `${scope} timing unmeasured: ${seconds}s exceeds the ${target}s target; longest runner wait ${finalJob}: ${wait}s.`
                : undefined;
          const before = warn.mock.calls.length;
          const completedRun = verifyCompletedCloud(scope, {
            directory: root,
            env,
            outputDirectory,
            readJobs: async () => jobs,
          });
          if (fails) await assert.rejects(completedRun, /exceeding.*budget/u);
          else await completedRun;
          const full = JSON.parse(
            readFileSync(join(outputDirectory, `${scope}-result.json`), "utf8"),
          );
          const completed = JSON.parse(
            readFileSync(join(outputDirectory, `${scope}-completed-result.json`), "utf8"),
          );
          for (const report of [full, completed]) {
            assert.equal(report.complete, true);
            assert.equal(report.verdict, fails ? "FAIL" : "PASS");
            assert.equal(report.seconds, seconds);
            assert.equal(report.spanSeconds, seconds);
            assert.equal(report.targetSeconds, target);
            assert.equal(report.budgetSeconds, ceiling);
            assert.equal(report.contended, wait > 30);
            assert.equal(report.timing, timing);
            assert.equal(report.warning, warning);
          }
          assert.deepEqual(
            warn.mock.calls.slice(before).map((call) => call.arguments[0]),
            warning ? [`::warning::${warning}`] : [],
          );
          if (warning) {
            assert.equal(readFileSync(summary, "utf8"), warning + "\n");
            rmSync(summary);
          } else assert.equal(existsSync(summary), false);
        });
      }
  });
}

test("JavaScript flaky evidence survives final verification without relaxing coverage", async (t) => {
  const parent = resolve(".agent-artifacts/verification");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "cloud-flaky-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outputDirectory = join(root, "aggregate"),
    summary = join(root, "summary.md"),
    jobs = passingCloudJobs();
  const commit = "checkout-merge-head",
    env = {
      GITHUB_SHA: commit,
      DOHC_WORKFLOW_HEAD_SHA: jobs[0].head_sha,
      GITHUB_STEP_SUMMARY: summary,
    };
  const flaky = [{ id: "task-1", test: "recovered test", errors: ["first try"], retries: 1 }];
  const records = [
    { scope: "js", part: "prepare-0", commit, verdict: "PASS" },
    ...Array.from({ length: JS_SHARDS }, (_, index) => ({
      scope: "js",
      part: "worker-" + index,
      commit,
      verdict: "PASS",
      planned: Array.from({ length: JS_SHARDS }, (_, id) => "task-" + id),
      assigned: ["task-" + index],
      completed: ["task-" + index],
      tests: [],
      flaky: index === 1 ? flaky : [],
      ...(!index ? { selfHostNative: {} } : {}),
    })),
  ];
  assert.deepEqual(aggregateJavascript(records).flaky, flaky);
  for (const mutate of [
    (rows) => rows[2].completed.pop(),
    (rows) => rows[2].completed.push("task-0"),
  ]) {
    const broken = structuredClone(records);
    mutate(broken);
    assert.throws(() => aggregateJavascript(broken));
  }
  for (const record of records) {
    const directory = join(root, `${record.part}-1`);
    mkdirSync(directory);
    writeFileSync(join(directory, "result.json"), JSON.stringify(record));
  }
  const log = t.mock.method(console, "log", () => {});
  await verifyCompletedCloud("js", {
    directory: root,
    env,
    readJobs: async () => jobs,
    outputDirectory,
  });
  const completed = JSON.parse(
    readFileSync(join(outputDirectory, "js-completed-result.json"), "utf8"),
  );
  assert.equal(completed.verdict, "PASS");
  assert.deepEqual(completed.flaky, flaky);
  assert.equal(completed.commit, jobs[0].head_sha);
  assert.deepEqual(
    log.mock.calls
      .map((call) => call.arguments[0])
      .filter((line) => line.startsWith("Passed on retry:")),
    ["Passed on retry: task-1 › recovered test"],
  );
  assert.equal(readFileSync(summary, "utf8"), "Passed on retry: task-1 › recovered test\n");
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]).filter((line) => line.startsWith("::warning")),
    ["::warning title=Passed on retry::task-1 › recovered test"],
  );
  await assert.rejects(
    verifyCompletedCloud("js", {
      directory: root,
      env: { ...env, GITHUB_SHA: "another-checkout" },
      readJobs: async () => jobs,
      outputDirectory,
    }),
    /requested commit/u,
  );
});
test("preparation spends only artifact requests before two minutes", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  for (const [scope, readyAt, expectedJobs, expectedCounted, jobsAt] of [
    ["js", 0, 0, 2],
    ["js", 90_000, 0, 3],
    ["js", 130_000, 1, 4, 120_000],
  ]) {
    const [job, artifact] = ["shared preparation", "javascript-prepared-1"];
    let clock = 0,
      jobs = 0,
      lists = 0,
      downloads = 0;
    await waitForPreparation(scope, {
      env: apiEnv,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      request: async (url, { headers }) => {
        if (url.includes("/jobs?")) {
          jobs++;
          assert.equal(clock, jobsAt);
          return apiResponse({ jobs: [{ name: job, status: "in_progress" }] });
        }
        if (url.endsWith("/zip")) {
          downloads++;
          return apiResponse("archive");
        }
        lists++;
        assert.equal(headers["If-None-Match"], lists === 1 ? undefined : '"fixture"');
        return clock >= readyAt
          ? apiResponse({ artifacts: [{ id: 42, name: artifact }] })
          : lists === 1
            ? apiResponse({ artifacts: [] })
            : apiResponse(null, 304);
      },
    });
    assert.equal(clock, readyAt);
    assert.equal(jobs, expectedJobs);
    assert.equal(downloads, 1);
    assert.equal(lists, readyAt / 2_500 + 1);
    assert.match(
      log.mock.calls.at(-1).arguments[0],
      new RegExp(`counted=${expectedCounted} 304=`, "u"),
    );
  }
});

test("a re-run of failed jobs reads a passed build from the attempt that ran it", async (t) => {
  t.mock.method(console, "log", () => {});
  const env = { ...apiEnv, GITHUB_RUN_ATTEMPT: "3" };
  for (const [scope, job, artifact] of [["js", "shared preparation", "javascript-prepared"]])
    for (const [carried, published, expected] of [
      [true, ["1"], `${artifact}-1`],
      [true, ["1", "2"], `${artifact}-2`],
      [false, ["1", "3"], `${artifact}-3`],
      [true, [], /passed in an earlier attempt, but no earlier/u],
    ]) {
      let clock = 0;
      const requested = [];
      const waiting = waitForPreparation(scope, {
        env,
        now: () => clock,
        pause: async (ms) => {
          clock += ms;
        },
        request: async (url) => {
          if (url.includes("/jobs?")) {
            assert.match(url, /\/attempts\/3\/jobs/u);
            return apiResponse({
              jobs: [
                carried
                  ? {
                      name: job,
                      status: "completed",
                      conclusion: "success",
                      created_at: "2026-11-17T09:30:37Z",
                      started_at: "2026-11-17T09:13:58Z",
                    }
                  : {
                      name: job,
                      status: "in_progress",
                      created_at: "2026-11-17T09:30:37Z",
                      started_at: "2026-11-17T09:30:40Z",
                    },
              ],
            });
          }
          if (url.endsWith("/zip")) return apiResponse("archive");
          const name = new URL(url).searchParams.get("name");
          requested.push(name);
          const attempt = name.slice(artifact.length + 1);
          return apiResponse({
            artifacts: published.includes(attempt) ? [{ id: Number(attempt), name }] : [],
          });
        },
      });
      if (expected instanceof RegExp) {
        await assert.rejects(waiting, expected);
        assert.equal(clock, 0);
        continue;
      }
      assert.equal((await waiting).artifact.name, expected);
      assert.equal(clock, 0);
      assert.equal(requested.includes(`${artifact}-3`), !carried);
    }
});

test("conditional jobs cache each page independently without slowing gate polls", async () => {
  const pages = [Array.from({ length: 100 }, (_, id) => ({ id })), [{ id: 100 }]];
  let poll = 0;
  const api = cloudApi({
    env: apiEnv,
    request: async (url, { headers }) => {
      const page = Number(new URL(url).searchParams.get("page"));
      assert.equal(headers["If-None-Match"], poll ? `"page-${page}"` : undefined);
      return poll === 1
        ? apiResponse(null, 304)
        : apiResponse({ jobs: pages[page - 1] }, 200, `"page-${page}"`);
    },
  });
  for (; poll < 3; poll++) {
    assert.deepEqual(await api.jobs({ conditional: true, slowUnchanged: false }), pages.flat());
    assert.equal(api.pollMs, 2_500);
  }
});

test("exhausted workflow allowance fails reads and downloads immediately with one annotation", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const message =
    "The repository's hourly GitHub API allowance for workflow runs is used up. Re-run all jobs after 2026-11-13T16:30:00.000Z.";
  for (const status of [403, 429])
    for (const operation of ["read", "download", "preparation download"]) {
      let requests = 0,
        pauses = 0;
      const request = async (url) => {
        requests++;
        if (operation === "preparation download" && url.includes("/artifacts?"))
          return apiResponse({ artifacts: [{ id: 42, name: "javascript-prepared-1" }] });
        return new Response(null, {
          status,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1794587400" },
        });
      };
      const options = {
        env: apiEnv,
        request,
        pause: async () => {
          pauses++;
        },
      };
      const api = cloudApi(options);
      const before = log.mock.calls.length;
      await assert.rejects(
        operation === "read"
          ? api.read("/artifacts")
          : operation === "download"
            ? api.download(42, 30_000, 60_000)
            : waitForPreparation("js", options),
        { message },
      );
      assert.equal(requests, operation === "preparation download" ? 2 : 1);
      assert.equal(pauses, 0);
      assert.equal(log.mock.calls.length, before + 1);
      assert.equal(
        log.mock.calls.at(-1).arguments[0],
        `::error title=GitHub API allowance used up::${message}`,
      );
    }
  for (const reset of [undefined, "soon"]) {
    const api = cloudApi({
      env: apiEnv,
      request: async () =>
        new Response("{}", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            ...(reset ? { "x-ratelimit-reset": reset } : {}),
          },
        }),
    });
    await assert.rejects(api.read("/artifacts"), {
      message:
        "The repository's hourly GitHub API allowance for workflow runs is used up. Re-run all jobs after the reset time.",
    });
  }
});
