import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

it("keeps admitted identity readers out of renderer and other main modules", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const contract = await readFile(new URL("../../../../packages/workspace-contracts/src/actorIdentity.ts", import.meta.url), "utf8");
  const helpers = [...contract.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)].map(match => match[1]);
  const forbidden = new RegExp("\\b(?:ActorKey|ActorOwnerKey|ActorRef|authorActorKey|readLocalChatActor|chatActorForPresentation|" + helpers.join("|") + ")\\b|actor-identity|actorIdentity");
  const allowed = new Set(["workspaces/actorPresentation.ts", "workspaces/chatWrites.ts", "workspaces/chatRelayIdentity.ts", "ipc/directMessagesIpc.ts"]);
  const violations: string[] = [];
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (/\.tsx?$/.test(entry.name)) {
        const name = relative(root, path).replaceAll("\\", "/");
        if (allowed.has(name) || (!name.startsWith("renderer/") && /\.test\./.test(name))) continue;
        let source = await readFile(path, "utf8");
        // URL canonicalization reads no actor key. Keep this exception to this import.
        if (name === "workspaces/dmRequests.ts") source = source
          .replace('import { createActorIssuer } from "@dohc/workspace-contracts/actor-identity";', "")
          .replace(/\bcreateActorIssuer\b/g, "");
        if (forbidden.test(source)) violations.push(name);
      }
    }
  }
  await scan(root); expect(violations).toEqual([]);
});
