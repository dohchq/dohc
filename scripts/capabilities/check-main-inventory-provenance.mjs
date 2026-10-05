import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run: node scripts/capabilities/check-main-inventory-provenance.mjs <generation.json>
const root = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = process.argv[2];
assert.ok(manifestPath, "Supply the main generation manifest.");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const hash = path => createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
assert.equal(manifest.sourceCommit, "a4be19d5bc2c3581aca2d4b2bfb66af8b06b9945");
assert.equal(manifest.trackedSourcesClean, true);
assert.equal(hash("scripts/capabilities/generate-main-inventories.ts"), manifest.generatorSha256, "generator hash");
assert.deepEqual(Object.keys(manifest.fixtureSha256).sort(), [
  "packages/mcp/src/capabilityExposure.fixture.ts",
  "services/share-web/src/remoteMcpInventory.fixture.ts",
]);
for (const [path, expected] of Object.entries(manifest.fixtureSha256)) assert.equal(hash(path), expected, path);
for (const [name, prefix] of Object.entries({
  "ipcExposure.main.json": "apps/desktop/src/ipc/",
  "cliExposure.main.json": "apps/desktop/src/ipc/",
  "channelKeys.main.json": "apps/desktop/src/ipc/",
  "toolsList.main.json": "packages/mcp/src/",
  "remoteMcpTools.main.json": "services/share-web/src/",
})) assert.equal(hash(prefix + name), manifest.files[name], name);
console.log("Main inventory provenance passed: generator, both staged fixtures, and five JSON inventories.");
