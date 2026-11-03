#!/usr/bin/env node
// The Rust gate's reader phase. The Markdown reader regressions need a real
// reader, so they are ignored and the workspace test run skips them. This
// builds the reader bundle for the Node that runs it, names both in
// DOHC_ENGINE_READER_CONFIG, and runs exactly those regressions:
//
//   node tools/rust-engine-program/reader-tests.mjs
//
// Each regression runs as its own nextest run that must find it, so a renamed
// or deleted regression fails the phase instead of dropping out of it. The
// runs share the workspace test step's build.
//
// The bundle is built into this user's private scratch parent and removed
// afterwards. On macOS the reader runs the staged pinned Node, as the reader's
// own tests do; Linux and Windows use the Node running this script.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nextest } from "./gate-commands.mjs";
import { testScratchParent } from "./scratch-leak-report.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The ignored regressions that need a real reader, by their full test names. */
export const READER_TESTS = [
  "live_update_application::adoption::tests::a_reader_built_lineage_adopts_its_successor",
  "live_update_application::adoption::tests::a_reader_built_lineage_checkpoints_at_the_native_cadence",
  "live_update_application::adoption::tests::a_reader_built_note_resumes_over_the_file_its_predecessor_settled",
];

/** The nextest arguments that run `name` and nothing else. */
export function readerTestArgs(name) {
  return [...nextest, "--run-ignored", "ignored-only", "--no-tests=fail",
    "-E", `package(dohc-engine-collab) & test(=${name})`];
}

async function readerNode() {
  if (process.platform !== "darwin") return process.execPath;
  const { stageReaderTestNode } = await import("./reader-test-node.mjs");
  return stageReaderTestNode();
}

export async function runReaderTests() {
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
    const failed = READER_TESTS.filter(name => {
      const run = spawnSync("cargo", readerTestArgs(name), { cwd: repoRoot, env, stdio: "inherit" });
      if (run.error) console.error(`  ${name}: ${run.error.message}`);
      return run.status !== 0;
    });
    if (failed.length) throw new Error(`Reader regressions failed: ${failed.join(", ")}.`);
  } finally {
    // Windows can hold the bundle a moment after the last reader exits.
    await rm(bundle, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runReaderTests().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
