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
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const readerTestNode = join(repoRoot, "target/reader-test-node/node");

export async function stageReaderTestNode() {
  if (process.platform !== "darwin") throw new Error("Only macOS stages a reader test Node; Linux and Windows use node on PATH.");
  // Loaded on use, so the gate can import this file without the desktop's sources.
  const { readPinnedCompilerNode } = await import("../../apps/desktop/scripts/stage-app-compiler.mjs");
  const compilerNode = join(repoRoot, "apps/desktop/resources/app-compiler/node");
  const bytes = await readPinnedCompilerNode({ stagedNodePaths: [readerTestNode, compilerNode] });
  if (!(await readFile(readerTestNode).catch(() => null))?.equals(bytes)) {
    await mkdir(dirname(readerTestNode), { recursive: true });
    const temporary = `${readerTestNode}.${process.pid}`;
    await writeFile(temporary, bytes, { mode: 0o755 });
    await rename(temporary, readerTestNode);
  }
  return readerTestNode;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(await stageReaderTestNode());
}
