// Stage this script and the remote MCP inventory fixture in a clean worktree at BASE.
// Run: pnpm --filter @dohc/cli exec tsx ../../scripts/capabilities/generate-main-inventories.ts <absolute-output-directory>
// Desktop, CLI, and MCP main inventories are hand-reviewed baselines. Edit them by hand.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { advertisedRemoteTools, REMOTE_MCP_INVENTORY_CASES } from "../../services/share-web/src/remoteMcpInventory.fixture";

const BASE = "a4be19d5bc2c3581aca2d4b2bfb66af8b06b9945";
process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("rev-parse", "HEAD") !== BASE) throw new Error(`Generate inventories only at main ${BASE}.`);
if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("Main's tracked sources must be clean.");
const output = process.argv[2];
if (!output) throw new Error("Supply an output directory.");
mkdirSync(output, { recursive: true });
const hashes: Record<string, string> = {};
function save(name: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(resolve(output, name), bytes);
  hashes[name] = createHash("sha256").update(bytes).digest("hex");
}
const remote: Record<string, unknown> = {};
for (const condition of REMOTE_MCP_INVENTORY_CASES) remote[condition.key] = await advertisedRemoteTools(condition);
save("remoteMcpTools.main.json", remote);
save("generation.json", {
  sourceCommit: BASE, trackedSourcesClean: true, checkout: process.cwd(),
  command: `pnpm --filter @dohc/cli exec tsx ../../scripts/capabilities/generate-main-inventories.ts ${output}`,
  generatorSha256: createHash("sha256").update(readFileSync("scripts/capabilities/generate-main-inventories.ts")).digest("hex"),
  fixtureSha256: Object.fromEntries([
    "packages/mcp/src/capabilityExposure.fixture.ts",
    "services/share-web/src/remoteMcpInventory.fixture.ts",
  ].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])),
  files: hashes,
});
console.log(JSON.stringify({ sourceCommit: BASE, files: hashes }, null, 2));
