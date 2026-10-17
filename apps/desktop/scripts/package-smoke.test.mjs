import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const script = new URL("./package-smoke.mjs", import.meta.url);
const source = readFileSync(script, "utf8").replace(/^import .*;\n/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(script.href));
function smoke(missing) {
  const messages = [];
  let exitCode = 0;
  const stopped = new Error("exit");
  try {
    runInNewContext(source, {
      readFileSync, createRequire, dirname, join, fileURLToPath,
      existsSync: path => !missing || !path.endsWith(missing),
      console: { log: line => messages.push(line), error: line => messages.push(line) },
      process: { platform: process.platform, env: {}, exit(code) { exitCode = code; throw stopped; } },
    });
  } catch (error) { if (error !== stopped) throw error; }
  return { exitCode, messages };
}
test("package smoke accepts complete outputs and rejects every missing worker", () => {
  assert.equal(smoke().exitCode, 0);
  for (const worker of ["workspace-database-worker", "document-projection-worker", "workspace-files-worker", "collection-history-worker"]) {
    const result = smoke(`${worker}.js`);
    assert.equal(result.exitCode, 1, `${worker} must be required`);
    assert.ok(result.messages.some(line => line.startsWith("FAIL") && line.includes(`${worker}.js`)));
  }
});
