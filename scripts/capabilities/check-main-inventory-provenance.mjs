import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run: node scripts/capabilities/check-main-inventory-provenance.mjs
const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("./generation.main.json", import.meta.url), "utf8"));
const hash = path => createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
assert.equal(manifest.sourceCommit, "a4be19d5bc2c3581aca2d4b2bfb66af8b06b9945");
assert.equal(manifest.trackedSourcesClean, true);
assert.equal(hash("scripts/capabilities/generate-main-inventories.ts"), manifest.generatorSha256, "generator hash");
assert.deepEqual(Object.keys(manifest.fixtureSha256).sort(), [
  "services/share-web/src/remoteMcpInventory.fixture.ts",
]);
for (const [path, expected] of Object.entries(manifest.fixtureSha256)) assert.equal(hash(path), expected, path);
for (const [name, prefix] of Object.entries({
  "remoteMcpTools.main.json": "services/share-web/src/",
})) assert.equal(hash(prefix + name), manifest.files[name], name);
console.log("Main inventory provenance passed: generator, remote MCP fixture, and remote MCP inventory.");
