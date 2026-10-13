import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

it("keeps admitted identity readers out of renderer and other main modules", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const contract = await readFile(new URL("../../../../packages/workspace-contracts/src/actorIdentity.ts", import.meta.url), "utf8");
  const helpers = [...contract.matchAll(/export function (\w+)/g)].map(match => match[1]);
  const forbidden = new RegExp("\\b(?:ActorKey|ActorRef|authorActorKey|" + helpers.join("|") + ")\\b|actor-identity|actorIdentity");
  const allowed = new Set(["workspaces/actorPresentation.ts", "workspaces/chatWrites.ts", "workspaces/chatRelayIdentity.ts", "ipc/directMessagesIpc.ts"]);
  const violations: string[] = [];
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const name = relative(root, path).replaceAll("\\", "/");
        if (allowed.has(name) || (!name.startsWith("renderer/") && /\.test\./.test(name))) continue;
        if (forbidden.test(await readFile(path, "utf8"))) violations.push(name);
      }
    }
  }
  await scan(root); expect(violations).toEqual([]);
});
