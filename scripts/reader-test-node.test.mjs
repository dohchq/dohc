import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageReaderTestNode } from "../tools/rust-engine-program/reader-test-node.mjs";
import { testScratchParent } from "../tools/rust-engine-program/scratch-leak-report.mjs";

const bytes = Buffer.from("a stand-in for the pinned Node");
const hash = createHash("sha256").update(bytes).digest("hex");
const readNode = async () => bytes;
// Staging is macOS-only; Windows refuses to rename a folder onto another one.
const posix = { skip: process.platform === "win32" };
// What a starting reader compares, plus the write time.
const identity = path => { const { ino, ctimeNs, mtimeNs } = statSync(path, { bigint: true }); return { ino, ctimeNs, mtimeNs }; };

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

test("a checkout under a group-writable folder still stages a Node the reader accepts", posix, async t => {
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

test("concurrent stagers publish one Node, and later stagers never touch it", posix, async t => {
  const parent = scratch(t);
  let release;
  const firstPublished = new Promise(resolve => { release = resolve; });
  let secondRead = false;
  const first = stageReaderTestNode({ parent, hash, readNode });
  const second = stageReaderTestNode({ parent, hash, readNode: async () => { secondRead = true; await firstPublished; return bytes; } });
  const node = await first;
  const published = identity(node);
  // Nothing changed the file after its bytes were written: no link, unlink or chmod.
  assert.equal(published.ctimeNs, published.mtimeNs);
  release();
  assert.equal(await second, node);
  assert.ok(secondRead, "the second stager found no Node before the first published one");
  assert.deepEqual(identity(node), published, "a later stager changes nothing a starting reader compares");
  assert.equal(await stageReaderTestNode({ parent, hash, readNode: () => assert.fail("a published Node is reused") }), node);
  assert.deepEqual(identity(node), published);
  assert.deepEqual(readdirSync(dirname(node)), ["node"]);
  assert.deepEqual(readdirSync(dirname(dirname(node))), [hash]);
});

test("a damaged published Node is reported before any download, and never replaced", posix, async t => {
  const parent = scratch(t);
  const node = join(parent, "reader-test-node", hash, "node");
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(node, "damaged");
  await assert.rejects(stageReaderTestNode({ parent, hash, readNode: () => assert.fail("no download before the report") }),
    new RegExp(`does not hold the pinned Node. Remove ${dirname(node)}`));
  assert.equal(readFileSync(node, "utf8"), "damaged");
  assert.deepEqual(readdirSync(dirname(dirname(node))), [hash]);
});

test("a stager removes temporary folders abandoned over an hour ago", posix, async t => {
  const parent = scratch(t);
  const folder = join(parent, "reader-test-node");
  const abandoned = join(folder, `${hash}.tmp-crashed`);
  const recent = join(folder, `${hash}.tmp-working`);
  for (const path of [abandoned, recent]) mkdirSync(path, { recursive: true });
  writeFileSync(join(abandoned, "node"), "partial");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(abandoned, twoHoursAgo, twoHoursAgo);
  await stageReaderTestNode({ parent, hash, readNode });
  assert.equal(existsSync(abandoned), false);
  assert.equal(existsSync(recent), true, "another stager may still be writing here");
});
