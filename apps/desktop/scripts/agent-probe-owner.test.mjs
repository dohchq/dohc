import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileOwner } from "./stage-agent-probe.mjs";

const source = name => fileURLToPath(new URL(`../src/agents/${name}`, import.meta.url));

test("the probe owner settles only on observed drainage and admits nothing before assignment",
  { skip: process.platform !== "win32" || process.arch !== "x64", timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-agent-probe-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "agentProbeOwnerTests.exe");
  await compileOwner([source("agentProbeOwner.cs"), source("agentProbeOwner.test.cs")], executable, "AgentProbeOwnerTests");
  const result = await promisify(execFile)(executable, [process.execPath, source("agentProbeRelay.mjs"), directory], { windowsHide: true })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), ({ code, stdout, stderr }) => ({ code, stdout, stderr }));
  assert.equal(result.code, 0, result.stdout + result.stderr);
});
