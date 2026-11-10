#!/usr/bin/env node
// The Rust gate's reader phase. The Markdown reader regressions need a real
// reader, so they are ignored and the workspace test run skips them. This
// builds the reader bundle for the Node that runs it, names both in
// DOHC_ENGINE_READER_CONFIG, and runs exactly those regressions:
//
//   node tools/rust-engine-program/reader-tests.mjs
//
// A regression joins the phase through its ignore reason, READER_PHASE, so no
// list here can miss one. Before running them, the phase lists the tests its
// filter selects and fails unless each regression's name selects exactly as
// many tests as the sources declare. The run shares the workspace test step's
// build.
//
// The bundle is built into this user's private scratch parent and removed
// afterwards. Desktop-pinned POSIX targets use a private Node, as the reader's own tests do.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { stagesReaderNode } from "./reader-test-node.mjs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nextest } from "./gate-commands.mjs";
import { testScratchParent } from "./scratch-leak-report.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The ignore reason of every regression this phase runs. */
export const READER_PHASE = "the Rust gate's reader phase runs it with DOHC_ENGINE_READER_CONFIG";
const PHASE_TEST = new RegExp(String.raw`#\[ignore = "${READER_PHASE}"\](?:\s*#\[[^\]]*\])*\s*(?:async\s+)?fn\s+(\w+)`, "gu");

/** The function names of the regressions this phase runs, sorted, from the sources under `crates`. */
export function readerTests(crates = join(repoRoot, "crates")) {
  const names = [];
  for (const path of readdirSync(crates, { recursive: true })) {
    if (!path.endsWith(".rs")) continue;
    for (const [, name] of readFileSync(join(crates, path), "utf8").matchAll(PHASE_TEST)) names.push(name);
  }
  return names.sort();
}

/** The cargo arguments that `list` or `run` the ignored tests named `names`, in any module, and nothing else. */
export function readerTestArgs(command, names, buildArgs = nextest.slice(2)) {
  if (!names.length) throw new Error("No test has the reader phase's ignore reason.");
  const filter = [...new Set(names)].map(name => `test(/(^|::)${name}$/)`).join(" | ");
  return ["nextest", command, ...buildArgs, "--run-ignored", "ignored-only", "-E", filter];
}

/**
 * The regressions in `names` that nextest's JSON test list did not select as
 * often as the sources declare them, each with the count it found.
 */
export function readerTestMismatches(names, list) {
  const found = new Map();
  for (const suite of Object.values(list["rust-suites"] ?? {})) {
    for (const [test, testcase] of Object.entries(suite.testcases ?? {})) {
      if (testcase["filter-match"]?.status !== "matches") continue;
      const name = test.split("::").at(-1);
      found.set(name, (found.get(name) ?? 0) + 1);
    }
  }
  const declared = new Map();
  for (const name of names) declared.set(name, (declared.get(name) ?? 0) + 1);
  return [...new Set([...declared.keys(), ...found.keys()])]
    .filter(name => declared.get(name) !== found.get(name))
    .map(name => `${name} (declared ${declared.get(name) ?? 0}, found ${found.get(name) ?? 0})`);
}

async function readerNode() {
  if (process.env.DOHC_READER_TEST_NODE) return process.env.DOHC_READER_TEST_NODE;
  if (!stagesReaderNode()) return process.execPath;
  const { stageReaderTestNode } = await import("./reader-test-node.mjs");
  return stageReaderTestNode();
}

export async function runReaderTests(buildArgs = nextest.slice(2)) {
  const names = readerTests();
  const listed = spawnSync("cargo", [...readerTestArgs("list", names, buildArgs), "--message-format", "json"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] });
  if (listed.status !== 0) throw new Error(`The reader regressions did not list: ${listed.error?.message ?? `exit ${listed.status}`}.`);
  const mismatches = readerTestMismatches(names, JSON.parse(listed.stdout));
  if (mismatches.length) throw new Error(`The reader phase's filter does not select exactly its regressions: ${mismatches.join(", ")}.`);
  const node = await readerNode();
  const parent = testScratchParent();
  await mkdir(parent, { recursive: true });
  const bundle = await mkdtemp(join(parent, "reader-test-bundle-"));
  try {
    // The manifest names the runtime that built it, so the reader's Node builds it.
    const built = spawnSync(node, [join(repoRoot, "packages/ydoc-projection/scripts/build-engine-reader.mjs"), bundle],
      { cwd: repoRoot, stdio: "inherit" });
    if (built.status !== 0) throw new Error(`The reader bundle did not build: ${built.error?.message ?? `exit ${built.status}`}.`);
    const env = { ...process.env, DOHC_ENGINE_READER_CONFIG: JSON.stringify({
      node, bundle: join(bundle, "reader.cjs"), manifest: join(bundle, "manifest.json"),
    }) };
    const run = spawnSync("cargo", [...readerTestArgs("run", names, buildArgs), "--no-tests=fail", "--no-fail-fast", "--retries=0"],
      { cwd: repoRoot, env, stdio: "inherit" });
    if (run.status !== 0) throw new Error(`Reader regressions failed: ${run.error?.message ?? `exit ${run.status}`}.`);
  } finally {
    // Windows can hold the bundle a moment after the last reader exits.
    await rm(bundle, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runReaderTests(process.argv.length > 2 ? process.argv.slice(2) : undefined).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
