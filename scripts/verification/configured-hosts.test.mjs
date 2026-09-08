import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(import.meta.dirname, "configured-hosts.mjs");
test("configured host verification explains its explicit native inputs", () => {
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--binary.*--build-receipt/);
  assert.doesNotMatch(result.stdout, /\[run\]/);
});
test("configured host verification refuses missing native inputs before any build or proof", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--binary/);
  assert.doesNotMatch(result.stdout, /\[run\]/);
});
test("configured host verification refuses a changed binary before any build or proof", () => {
  const root = mkdtempSync(join(tmpdir(), "configured-host-inputs-"));
  try {
    const binary = join(root, "engine"), evidence = join(root, "build.json");
    writeFileSync(binary, "changed executable");
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
    writeFileSync(evidence, JSON.stringify({ version: 1, engine: { artifact: "0".repeat(64), commit } }));
    const result = spawnSync(process.execPath, [script, "--binary", binary, "--build-receipt", evidence], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /differs from the supplied build hash/);
    assert.doesNotMatch(result.stdout, /\[run\]/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
