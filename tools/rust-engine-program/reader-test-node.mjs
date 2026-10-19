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
// whatever folder holds the checkout. A published Node is never replaced: a
// reader that is starting compares the identity of the file it hashed.
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PINNED_NODE } from "../../apps/desktop/scripts/pinned-node.mjs";
import { testScratchParent } from "./scratch-leak-report.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

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

async function holds(path, hash) {
  const bytes = await readFile(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  return bytes !== null && sha256(bytes) === hash;
}

export async function stageReaderTestNode({ root = repoRoot, parent, hash = pinnedHash(), readNode = readPinnedNode } = {}) {
  const node = readerTestNode({ parent, hash });
  if (await holds(node, hash)) return node;
  const bytes = await readNode([join(root, "apps/desktop/resources/app-compiler/node")]);
  if (sha256(bytes) !== hash) throw new Error("The reader test Node does not match its pin.");
  await mkdir(dirname(node), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(node), `.node-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    await writeFile(temporary, bytes, { mode: 0o555, flag: "wx" });
    // link refuses an existing name, so a concurrent stager's Node stays in place.
    await link(temporary, node).catch(async error => {
      if (error.code !== "EEXIST") throw error;
      if (!(await holds(node, hash))) throw new Error(`${node} does not hold the pinned Node. Remove its folder, then run again.`);
    });
  } finally {
    await rm(temporary, { force: true });
  }
  return node;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(await stageReaderTestNode());
}
