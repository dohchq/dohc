import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfiguredHostProof } from "./configured-hosts.mjs";

for (const [kind, count] of [["service", 2], ["device", 1]]) {
  test(`${kind} host proof requires every case to pass with the supplied binary`, () => {
    const root = mkdtempSync(join(tmpdir(), "configured-host-proof-"));
    const binary = join(root, "engine"), sha256 = "a".repeat(64), tests = join(root, "vitest.json");
    const result = { success: true, numTotalTests: count, numPassedTests: count, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
    const proof = { verdict: "PASS", executable: binary, sha256 };
    const casePath = index => join(root, `case-${index}`, "result.json");
    const verify = () => readConfiguredHostProof(kind, tests, root, binary, sha256);
    const write = (report = result) => writeFileSync(tests, JSON.stringify(report));
    try {
      for (let index = 0; index < count; index++) {
        mkdirSync(join(root, `case-${index}`));
        writeFileSync(casePath(index), JSON.stringify(proof));
      }
      write(); assert.doesNotThrow(verify);
      for (const delta of [{ success: false }, { numTotalTests: count - 1 }, { numPassedTests: count - 1 },
        { numPendingTests: 1 }, { numTodoTests: 1 }, { numFailedTests: 1 }]) {
        write({ ...result, ...delta }); assert.throws(verify, undefined, JSON.stringify(delta));
      }
      write();
      for (let index = 0; index < count; index++) {
        for (const delta of [{ verdict: "FAIL" }, { sha256: "b".repeat(64) }, { executable: join(root, "another-engine") }]) {
          writeFileSync(casePath(index), JSON.stringify({ ...proof, ...delta }));
          assert.throws(verify, undefined, `case ${index}: ${JSON.stringify(delta)}`);
        }
        rmSync(casePath(index)); assert.throws(verify, /ENOENT/);
        writeFileSync(casePath(index), JSON.stringify(proof));
      }
      mkdirSync(join(root, "case-extra")); assert.throws(verify);
      rmSync(join(root, "case-extra"), { recursive: true });
      rmSync(join(root, `case-${count - 1}`), { recursive: true }); assert.throws(verify);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

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
