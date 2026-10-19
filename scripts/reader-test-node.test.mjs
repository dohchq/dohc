import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageReaderTestNode } from "../tools/rust-engine-program/reader-test-node.mjs";
import { testScratchParent } from "../tools/rust-engine-program/scratch-leak-report.mjs";

const bytes = Buffer.from("a stand-in for the pinned Node");
const hash = createHash("sha256").update(bytes).digest("hex");
const readNode = async () => bytes;

function scratch(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dohc-reader-node-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

// The ancestor rule of check_owner in crates/dohc-engine-reader/src/platform.rs.
function readerAccepts(path) {
  for (let current = path; ; current = dirname(current)) {
    const stats = lstatSync(current);
    const stickyRoot = stats.isDirectory() && stats.uid === 0 && (stats.mode & 0o1000) !== 0;
    if (stats.isSymbolicLink() || (!stickyRoot && ((stats.mode & 0o022) !== 0 || ![0, process.getuid()].includes(stats.uid)))) return false;
    if (current === dirname(current)) return true;
  }
}

test("a checkout under a group-writable folder still stages a Node the reader accepts", { skip: process.platform === "win32" }, async t => {
  const base = scratch(t);
  const shared = join(base, "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o775);
  const root = join(shared, "checkout");
  mkdirSync(root);
  assert.equal(readerAccepts(root), false, "the checkout's own folders are refused");
  const node = await stageReaderTestNode({ root, parent: testScratchParent({ base }), hash, readNode });
  assert.ok(!node.startsWith(root), node);
  assert.ok(readerAccepts(node), node);
  assert.deepEqual(readFileSync(node), bytes);
});

test("concurrent stagers publish one Node, and later stagers reuse it", async t => {
  const parent = scratch(t);
  let release;
  const firstPublished = new Promise(resolve => { release = resolve; });
  let secondRead = false;
  const first = stageReaderTestNode({ parent, hash, readNode });
  const second = stageReaderTestNode({ parent, hash, readNode: async () => { secondRead = true; await firstPublished; return bytes; } });
  const node = await first;
  const published = statSync(node).ino;
  release();
  assert.equal(await second, node);
  assert.ok(secondRead, "the second stager found no Node before the first published one");
  assert.equal(statSync(node).ino, published, "a published Node is never replaced");
  assert.equal(await stageReaderTestNode({ parent, hash, readNode: () => assert.fail("a published Node is reused") }), node);
  assert.deepEqual(readdirSync(dirname(node)), ["node"]);
});

test("a damaged published Node is reported, never replaced", async t => {
  const parent = scratch(t);
  const node = join(parent, "reader-test-node", hash, "node");
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, "damaged");
  await assert.rejects(stageReaderTestNode({ parent, hash, readNode }), /does not hold the pinned Node/);
  assert.equal(readFileSync(node, "utf8"), "damaged");
  assert.deepEqual(readdirSync(dirname(node)), ["node"]);
});
