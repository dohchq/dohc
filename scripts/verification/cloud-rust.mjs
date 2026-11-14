import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { git, repoRoot, run } from "./process.mjs";
import { withBuildBudget } from "./build.mjs";
import { startTiming, timed } from "./timing.mjs";
import {
  readTreeState,
  classifyTreeProvenance,
} from "../../tools/rust-engine-program/tree-provenance.mjs";
import {
  SCRATCH_SENTINEL,
  inspectScratchRun,
  testScratchParent,
} from "../../tools/rust-engine-program/scratch-leak-report.mjs";
import { stageReaderTestNode } from "../../tools/rust-engine-program/reader-test-node.mjs";
import rustTestTimes from "./rust-test-times.json" with { type: "json" };

export const RUST_SHARDS = 8;
export const RUST_READER_SHARD = 1;
// The reader shard runs the reader tests after its partition; they took 27 to 49 s in CI.
export const RUST_READER_SECONDS = 43;
export const RUST_POLICY_STEPS = [
  "tree provenance",
  "native target",
  "fixture drift",
  "fmt --check",
  "clippy -D warnings",
  "doctests",
  "build daemon",
  "cargo-deny",
  "cargo-audit",
  "scratch leak",
];
export const RUST_ARCHIVE_PROOFS = ["test fixtures"];
export const RUST_TEST_PROOFS = ["reader tests"];

export function rustTestInventory(list) {
  const suites = list["rust-suites"];
  if (!suites || typeof suites !== "object")
    throw new Error("The nextest test inventory is missing.");
  const tasks = Object.entries(suites).flatMap(([binary, suite]) =>
    Object.entries(suite.testcases ?? {})
      .filter(([, test]) => !test.ignored && test["filter-match"]?.status === "matches")
      .map(([name]) => ({ id: `${binary} ${name}` })),
  );
  if (!tasks.length || new Set(tasks.map((task) => task.id)).size !== tasks.length)
    throw new Error("The nextest test inventory is empty or duplicated.");
  return tasks;
}

export function passedRustTests(log) {
  return [
    ...log
      .replace(/\x1b\[[0-9;]*m/gu, "")
      .matchAll(/^\s*PASS\s+\[\s*[\d.]+s\]\s+(?:\([^)]*\)\s+)?(.+?)\s*$/gmu),
  ].map((match) => match[1]);
}

export function partitionRustTests(
  inventory,
  count = RUST_SHARDS,
  times = rustTestTimes,
  readerSeconds = RUST_READER_SECONDS,
) {
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error("A Rust partition count must be a positive integer.");
  if (new Set(inventory).size !== inventory.length) throw new Error("Duplicate Rust test IDs.");
  const tasks = inventory.map((id) => ({
    id,
    seconds:
      times.tests[id] ??
      (Object.hasOwn(times.binaries, id.split(" ")[0])
        ? times.binaries[id.split(" ")[0]]
        : times.defaultSeconds),
  }));
  if (tasks.some((task) => !Number.isFinite(task.seconds) || task.seconds <= 0))
    throw new Error("Rust test estimates must be positive seconds.");
  const partitions = Array.from({ length: count }, (_, index) => ({
    seconds: index === RUST_READER_SHARD ? readerSeconds : 0,
    tests: [],
  }));
  for (const task of tasks.sort(
    (a, b) => b.seconds - a.seconds || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )) {
    const least = partitions.reduce((a, b) => (b.seconds < a.seconds ? b : a));
    least.tests.push(task.id);
    least.seconds += task.seconds;
  }
  return partitions.map((partition) => partition.tests);
}

export function rustPartitionFilters(assigned) {
  // https://nexte.st/docs/filtersets/reference/#name-matchers
  const escape = (name) =>
    name.replace(/[^a-zA-Z0-9_:.-]/gu, (char) => `\\u{${char.codePointAt(0).toString(16)}}`);
  const expressions = [];
  let expression = "";
  for (const id of assigned) {
    const split = id.indexOf(" ");
    if (split < 1 || split === id.length - 1) throw new Error(`Invalid Rust test ID: ${id}`);
    const clause = `(binary_id(=${escape(id.slice(0, split))}) & test(=${escape(id.slice(split + 1))}))`;
    // Linux limits each argument to 128 KiB, including its terminating NUL.
    if (Buffer.byteLength(clause) >= 32 * 1024)
      throw new Error(`Rust test filter is too long: ${id}`);
    if (expression && Buffer.byteLength(expression) + 3 + Buffer.byteLength(clause) >= 32 * 1024) {
      expressions.push(expression);
      expression = "";
    }
    expression += (expression ? " | " : "") + clause;
  }
  if (expression) expressions.push(expression);
  return (expressions.length ? expressions : ["none()"]).flatMap((filter) => ["-E", filter]);
}

export function assertRustPartitionInventory(assigned, listed) {
  if (JSON.stringify([...assigned].sort()) !== JSON.stringify([...listed].sort()))
    throw new Error("The listed Rust partition inventory differs from its assignment.");
}

export async function cloudRust(part, index = 0) {
  if (!process.env.GITHUB_ACTIONS)
    throw new Error(
      "Distributed gates run on GitHub Actions. Use pnpm verify:pr on a development host.",
    );
  const output = resolve(repoRoot, ".agent-artifacts/verification/cloud-rust", part, String(index));
  mkdirSync(output, { recursive: true });
  const report = {
    version: 1,
    scope: "rust",
    part: `${part}-${index}`,
    commit: git(["rev-parse", "HEAD"]),
    steps: [],
    completed: [],
    verdict: "RUNNING",
  };
  const finish = startTiming(report);
  const save = () =>
    writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2) + "\n");
  const headLog = resolve(repoRoot, git(["rev-parse", "--git-path", "logs/HEAD"]));
  const readings = [];
  const readTree = (step) =>
    readings.push({
      step,
      state: readTreeState(
        (command) => git(command.split(" ").slice(1)),
        () => existsSync(headLog),
      ),
    });
  async function step(name, command, args, options) {
    const row = { name };
    report.steps.push(row);
    try {
      return await timed(
        row,
        () =>
          run(command, args, {
            log: join(output, `${name.replaceAll(/[^\w.-]/gu, "_")}.log`),
            ...options,
          }),
        save,
      );
    } finally {
      readTree(name);
    }
  }
  const archive = resolve(".agent-artifacts/verification/rust-tests.tar.zst");
  const image = resolve(".agent-artifacts/verification/empty-store.db");
  let scratch;
  try {
    readTree("start");
    process.env.DOHC_READER_TEST_NODE = await stageReaderTestNode();
    if (part === "archive") {
      scratch = join(testScratchParent(), `cloud-${randomUUID()}`);
      mkdirSync(scratch);
      writeFileSync(join(scratch, SCRATCH_SENTINEL), "cloud");
      await withBuildBudget(async (env) => {
        await step(
          "archive",
          "cargo",
          [
            "nextest",
            "archive",
            "--locked",
            "--workspace",
            "--archive-file",
            archive,
            "--zstd-level=-1",
          ],
          { env },
        );
        const listed = await step(
          "inventory",
          "cargo",
          ["nextest", "list", "--locked", "--workspace", "--message-format=json"],
          { env },
        );
        report.planned = rustTestInventory(JSON.parse(listed.stdout)).map((task) => task.id);
        const fixtureEnv = {
          ...env,
          DOHC_TEST_EMPTY_STORE_IMAGE: image,
          DOHC_TEST_SCRATCH_ROOT: scratch,
        };
        await step(
          "test fixtures",
          "cargo",
          [
            "nextest",
            "run",
            "--locked",
            "--workspace",
            "--run-ignored",
            "only",
            "--no-tests=fail",
            "--retries=0",
            "-E",
            "binary_id(=dohc-engine-testkit::empty_store_image) & test(=prepare_empty_store_image)",
          ],
          { env: fixtureEnv },
        );
      });
      writeFileSync(
        resolve(".agent-artifacts/verification/rust-inventory.json"),
        JSON.stringify(report.planned),
      );
    } else if (
      part === "tests" &&
      Number.isSafeInteger(index) &&
      index >= 0 &&
      index < RUST_SHARDS
    ) {
      const all = JSON.parse(
        readFileSync(resolve(".agent-artifacts/verification/rust-inventory.json"), "utf8"),
      );
      report.planned = all;
      report.assigned = [];
      // CARGO_BIN_EXE in the integration binary retains the build's target path.
      // Extract once into this checkout, then reuse its metadata for execution.
      const listed = await step("inventory", "cargo", [
        "nextest",
        "list",
        "--archive-file",
        archive,
        "--workspace-remap",
        repoRoot,
        "--extract-to",
        repoRoot,
        "--message-format=json",
      ]);
      const extracted = rustTestInventory(JSON.parse(listed.stdout)).map((task) => task.id);
      if (JSON.stringify(extracted.sort()) !== JSON.stringify([...all].sort()))
        throw new Error("The extracted Rust archive inventory differs from its build.");
      const reused = [
        "--cargo-metadata",
        join(repoRoot, "target/nextest/cargo-metadata.json"),
        "--binaries-metadata",
        join(repoRoot, "target/nextest/binaries-metadata.json"),
        "--workspace-remap",
        repoRoot,
        "--target-dir-remap",
        join(repoRoot, "target"),
      ];
      scratch = join(testScratchParent(), `cloud-${randomUUID()}`);
      mkdirSync(scratch);
      writeFileSync(join(scratch, SCRATCH_SENTINEL), "cloud");
      report.assigned = partitionRustTests(all)[index];
      save();
      const filters = rustPartitionFilters(report.assigned);
      const selected = await step("partition inventory", "cargo", [
        "nextest",
        "list",
        ...reused,
        ...filters,
        "--message-format=json",
      ]);
      assertRustPartitionInventory(
        report.assigned,
        rustTestInventory(JSON.parse(selected.stdout)).map((task) => task.id),
      );
      const result = await step(
        "test-workspace",
        "cargo",
        [
          "nextest",
          "run",
          ...reused,
          ...filters,
          "--no-fail-fast",
          "--no-tests=fail",
          "--retries=0",
          "--status-level=pass",
          "--final-status-level=none",
        ],
        {
          env: {
            ...process.env,
            DOHC_TEST_EMPTY_STORE_IMAGE: image,
            DOHC_TEST_SCRATCH_ROOT: scratch,
          },
        },
      );
      report.completed = passedRustTests(result.stdout + "\n" + result.stderr);
      save();
      if (
        JSON.stringify([...report.completed].sort()) !== JSON.stringify([...report.assigned].sort())
      )
        throw new Error("The Rust shard did not pass every assigned test exactly once.");
      if (index === RUST_READER_SHARD)
        await step(
          "reader tests",
          process.execPath,
          ["tools/rust-engine-program/reader-tests.mjs", ...reused],
          {
            env: {
              ...process.env,
              DOHC_TEST_EMPTY_STORE_IMAGE: image,
              DOHC_TEST_SCRATCH_ROOT: scratch,
            },
          },
        );
    } else throw new Error("Use archive or tests with a valid shard index.");
    report.verdict = "PASS";
  } catch (error) {
    report.verdict = "FAIL";
    report.error = error.stack;
    throw error;
  } finally {
    if (scratch) {
      report.scratch = await inspectScratchRun(scratch);
      if (report.scratch.status !== "PASS") {
        report.verdict = "FAIL";
        process.exitCode = 1;
      }
    }
    readTree("finish");
    report.provenance = classifyTreeProvenance(readings);
    if (report.provenance.status !== "PASS") {
      report.verdict = "FAIL";
      process.exitCode = 1;
    }
    report.treeReadings = readings;
    finish();
    save();
    console.log(`[verification] ${report.verdict} (rust ${report.part}): ${report.seconds}s`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  cloudRust(process.argv[2], Number(process.argv[3] ?? 0)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
