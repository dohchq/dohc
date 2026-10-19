#!/usr/bin/env node
// Stages the Node that the Markdown reader's tests run on macOS, and prints its
// path. The reader refuses a runtime under a linked or shared-writable
// directory, which includes Homebrew's Cellar, so the tests take the app
// compiler's pinned, hash-checked Node from DOHC_READER_TEST_NODE instead:
//
//   DOHC_READER_TEST_NODE="$(node tools/rust-engine-program/reader-test-node.mjs)" \
//     cargo nextest run -p dohc-engine-reader
//
// The Rust gate runs it before its macOS test step. Linux and Windows tests use
// node on PATH.
//
// The Node lives in this user's private scratch parent under its own hash,
// whatever folder holds the checkout. A stager writes it into a private
// temporary folder and renames that folder into place, so nothing ever
// touches a published file: a reader that is starting compares the inode and
// change time of the file it hashed.
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PINNED_NODE } from "../../apps/desktop/scripts/pinned-node.mjs";
import { testScratchParent } from "./scratch-leak-report.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
// No stager takes this long, so an older temporary folder belongs to one that stopped.
const abandonedMs = 60 * 60 * 1000;

function pinnedHash() {
  const pin = process.platform === "darwin" && PINNED_NODE[`darwin-${process.arch}`];
  if (!pin) throw new Error(`No reader test Node is pinned for ${process.platform}-${process.arch}; Linux and Windows tests use node on PATH.`);
  return pin.sha256;
}

export function readerTestNode({ parent = testScratchParent(), hash = pinnedHash() } = {}) {
  return join(parent, "reader-test-node", hash, "node");
}

// Loaded on use: the gate imports this file, and its wiring test copies only what the gate reads.
async function readPinnedNode(stagedNodePaths) {
  const { readPinnedCompilerNode } = await import("../../apps/desktop/scripts/stage-app-compiler.mjs");
  return readPinnedCompilerNode({ stagedNodePaths });
}

/** Whether the Node is published. A damaged one is reported, never replaced. */
async function published(node, hash) {
  const bytes = await readFile(node).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (bytes === null) return false;
  if (sha256(bytes) !== hash) throw new Error(`${node} does not hold the pinned Node. Remove ${dirname(node)}, then run again.`);
  return true;
}

async function removeAbandoned(folder) {
  for (const name of await readdir(folder)) {
    if (!name.includes(".tmp-")) continue;
    const stats = await lstat(join(folder, name)).catch(() => null);
    if (stats?.isDirectory() && Date.now() - stats.mtimeMs > abandonedMs) await rm(join(folder, name), { recursive: true, force: true });
  }
}

export async function stageReaderTestNode({ root = repoRoot, parent, hash = pinnedHash(), readNode = readPinnedNode } = {}) {
  const node = readerTestNode({ parent, hash });
  const folder = dirname(dirname(node));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await removeAbandoned(folder);
  if (await published(node, hash)) return node;
  const bytes = await readNode([join(root, "apps/desktop/resources/app-compiler/node")]);
  if (sha256(bytes) !== hash) throw new Error("The reader test Node does not match its pin.");
  const temporary = await mkdtemp(join(folder, `${hash}.tmp-`));
  try {
    await writeFile(join(temporary, "node"), bytes, { mode: 0o555, flag: "wx" });
    // A non-empty folder already in place means another stager published first.
    await rename(temporary, dirname(node)).catch(async error => {
      if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
      if (!(await published(node, hash))) throw new Error(`${dirname(node)} holds no Node. Remove it, then run again.`);
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return node;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(await stageReaderTestNode());
}
