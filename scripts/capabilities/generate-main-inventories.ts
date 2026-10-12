// Stage this script and the two inventory fixtures in a clean worktree at BASE.
// Run: pnpm --filter @dohc/cli exec tsx ../../scripts/capabilities/generate-main-inventories.ts <absolute-output-directory>
// B5 must not regenerate these baselines. Edit operationAdmission.json by hand.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_COMMANDS } from "../../packages/cli/src/args";
import { renderCliHelp } from "../../packages/cli/src/help";
import { cliRequestSchema } from "../../packages/cli/src/protocol";
import { advertisedCapabilityTools } from "../../packages/mcp/src/capabilityExposure.fixture";
import { CHANNELS } from "../../apps/desktop/src/ipc/channels";
import {
  workspaceVersionOperations, workspaceSearchOperations, crashReportOperations,
  chatDispatchNoticeOperations, scheduleHostOperations, noticeOperations,
} from "../../apps/desktop/src/ipc/bridgeContract";
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
const rows = [workspaceVersionOperations, workspaceSearchOperations, crashReportOperations,
  chatDispatchNoticeOperations, scheduleHostOperations, noticeOperations].flatMap(table => Object.values(table));
save("ipcExposure.main.json", {
  names: [...Object.values(CHANNELS), ...rows.map(row => row.channel)].sort(),
  guards: Object.fromEntries(rows.map(row => [row.channel, row.guard])),
});
save("channelKeys.main.json", Object.keys(CHANNELS).sort());
const socketVerbs = cliRequestSchema.options.map(option => option.shape.verb.value).sort();
const internal = new Set(["fileChats", "chat", "groupsFull", "collectionQuery", "collectionRecord", "collectionSetFields",
  "collectionCreateRecord", "fileWrite", "fileMove", "fileDelete", "keptCopies", "saveKeptCopy", "fileChatStart"]);
const help: Record<string, string> = { top: renderCliHelp({ help: [] }) };
for (const [group, command] of Object.entries(CLI_COMMANDS)) {
  help[group] = renderCliHelp({ help: [group] });
  for (const verb of Object.keys(command.verbs)) help[`${group} ${verb}`] = renderCliHelp({ help: [group, verb] });
}
save("cliExposure.main.json", {
  socketVerbs, internalVerbs: socketVerbs.filter(verb => internal.has(verb)),
  publicSocketVerbs: socketVerbs.filter(verb => !internal.has(verb)), publicGroups: Object.keys(CLI_COMMANDS),
  publicVerbs: Object.entries(CLI_COMMANDS).flatMap(([group, command]) => Object.keys(command.verbs).map(verb => `${group} ${verb}`)), help,
});
const mcp: Record<string, unknown> = {};
for (const level of ["owner", "view", "comment", "edit"] as const) mcp[level] = await advertisedCapabilityTools(level === "owner" ? undefined : level);
save("toolsList.main.json", mcp);
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
