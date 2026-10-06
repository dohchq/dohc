import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkRawBridge } from "./check-raw-bridge.mjs";

const checker = resolve("scripts/check-renderer-async.mjs");
const fixtures = resolve("scripts/fixtures/renderer-async");
test("RA1–RA7 reject exactly the reviewed 40 findings in 37 files", () => {
  const run = spawnSync(process.execPath, [checker, join(fixtures, "reject"), "--strict"], { encoding: "utf8" });
  assert.equal(run.status, 1, run.stderr);
  const findings = run.stdout.split(/\r?\n/u).filter(line => /^RA[1-7] /u.test(line));
  const expected = readFileSync(join(fixtures, "expected-reject.txt"), "utf8").trim().split("\n").sort();
  assert.equal(findings.length, 40);
  assert.deepEqual(findings.map(line => line.match(/^RA[1-7] .+?:\d+/u)[0]).sort(), expected);
  assert.equal(new Set(findings.map(line => line.match(/^RA[1-7] (.+?):\d+/u)[1])).size, 37);
});
test("accepted caller and owner shapes have zero findings", () => {
  const output = execFileSync(process.execPath, [checker, join(fixtures, "accept"), "--strict"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(output.trim()), { files: 12, findings: 0 });
});
test("the raw-call ratchet rejects an added call in a legacy file", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-u4-ratchet-"));
  try {
    writeFileSync(join(root, "Legacy.tsx"), 'import { bridge } from "./bridge";\nbridge().read();\n');
    const inventory = { counts: { "Legacy.tsx": 1 }, migrated: [] };
    assert.deepEqual(checkRawBridge(root, inventory), []);
    writeFileSync(join(root, "Legacy.tsx"), 'import { bridge } from "./bridge";\nbridge().read(); bridge().read();\n');
    assert.deepEqual(checkRawBridge(root, inventory), ["RATCHET Legacy.tsx: raw bridge() calls 1 -> 2. Use desktopAction or the operation's owner."]);
    assert.deepEqual(checkRawBridge(root, { ...inventory, migrated: ["Legacy.tsx"] }), ["RATCHET Legacy.tsx: raw bridge() calls 0 -> 2. Use desktopAction or the operation's owner."]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
