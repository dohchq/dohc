import { describe, expect, it } from "vitest";
import type {
  Actor,
  SaveAssetInput,
  WorkspaceBackend,
  WorkspaceFile,
  WriteAtomInput,
} from "@dohc/workspace-contracts";
import { createWorkspaceApiHandler } from "./server";

const actor: Actor = { userId: "user_1", workspaceId: "ws_api" };

function file(path: string, kind: WorkspaceFile["kind"], contentType = "text/plain"): WorkspaceFile {
  return {
    id: `${kind}:${path}`,
    workspaceId: actor.workspaceId,
    path,
    kind,
    contentType,
    revision: "rev-1",
    updatedAt: 1,
  };
}

function memoryBackend() {
  const text = new Map<string, { body: string; revision: string }>([
    ["notes/day.md", { body: "# Day\n", revision: "rev-1" }],
  ]);
  const assets = new Map<string, { bytes: Uint8Array; revision: string; mediaType: string }>();
  const calls: Array<{ method: string; input: unknown; actor: Actor }> = [];
  const backend: WorkspaceBackend = {
    async listFiles(resolvedActor) {
      calls.push({ method: "listFiles", input: null, actor: resolvedActor });
      return [
        ...Array.from(text.keys()).map((path) => file(path, "atom", "text/markdown")),
        ...Array.from(assets.entries()).map(([path, asset]) => file(path, "asset", asset.mediaType)),
      ];
    },
    async readText(resolvedActor, path) {
      calls.push({ method: "readText", input: path, actor: resolvedActor });
      const row = text.get(path);
      if (!row) throw new Error("not found");
      return row;
    },
    async readAsset(resolvedActor, path) {
      calls.push({ method: "readAsset", input: path, actor: resolvedActor });
      const row = assets.get(path);
      if (!row) throw new Error("not found");
      return {
        mediaType: row.mediaType,
        kind: "image",
        bytes: row.bytes,
        revision: row.revision,
      };
    },
    async createAtom(resolvedActor, input) {
      calls.push({ method: "createAtom", input, actor: resolvedActor });
      text.set(input.path, { body: input.body, revision: "rev-created" });
      return file(input.path, "atom", "text/plain");
    },
    async writeAtom(resolvedActor, input: WriteAtomInput) {
      calls.push({ method: "writeAtom", input, actor: resolvedActor });
      const row = text.get(input.path);
      if (!row) throw new Error("not found");
      if (row.revision !== input.expectedRevision) throw new Error("stale revision");
      text.set(input.path, { body: input.body, revision: "rev-updated" });
      return file(input.path, "atom", "text/markdown");
    },
    async saveAsset(resolvedActor, input: SaveAssetInput) {
      calls.push({ method: "saveAsset", input, actor: resolvedActor });
      assets.set(input.path, {
        bytes: input.bytes,
        mediaType: input.mediaType,
        revision: "rev-asset",
      });
      return file(input.path, "asset", input.mediaType);
    },
    async renameFile() {
      throw new Error("not used");
    },
    async deleteFile(resolvedActor, path) {
      calls.push({ method: "deleteFile", input: path, actor: resolvedActor });
      text.delete(path);
      assets.delete(path);
    },
  };
  return { backend, calls, text, assets };
}

async function json(response: Response) {
  return await response.json() as any;
}

describe("workspace API service", () => {
  it("lists, reads, writes, uploads, applies sync, and streams events through server-derived actor identity", async () => {
    const fixture = memoryBackend();
    const observedHeaders: Array<string | null> = [];
    const handler = createWorkspaceApiHandler({
      backend: fixture.backend,
      resolveActor: async (request, workspaceId) => {
        observedHeaders.push(request.headers.get("x-user-id"));
        return { userId: "server_user", workspaceId };
      },
    });

    await expect(
      json(await handler(new Request("http://api.test/workspaces/ws_api/files", {
        headers: { "x-user-id": "browser-spoof" },
      }))),
    ).resolves.toMatchObject({
      ok: true,
      files: [expect.objectContaining({ path: "notes/day.md" })],
    });

    await expect(
      json(await handler(new Request("http://api.test/workspaces/ws_api/files/notes/day.md"))),
    ).resolves.toMatchObject({
      ok: true,
      file: {
        path: "notes/day.md",
        body: "# Day\n",
        revision: "rev-1",
      },
    });

    await expect(
      json(await handler(new Request("http://api.test/workspaces/ws_api/files/notes/day.md", {
        method: "POST",
        body: JSON.stringify({
          expectedRevision: "rev-1",
          body: "# Day\nUpdated\n",
        }),
      }))),
    ).resolves.toMatchObject({ ok: true, file: { path: "notes/day.md" } });

    await expect(
      json(await handler(new Request("http://api.test/workspaces/ws_api/assets", {
        method: "POST",
        body: JSON.stringify({
          path: "uploads/photo.png",
          kind: "image",
          mediaType: "image/png",
          bytesBase64: Buffer.from([1, 2, 3]).toString("base64"),
        }),
      }))),
    ).resolves.toMatchObject({ ok: true, file: { path: "uploads/photo.png" } });

    await expect(
      json(await handler(new Request("http://api.test/workspaces/ws_api/sync/apply", {
        method: "POST",
        body: JSON.stringify({
          operations: [
            {
              op: "delete",
              path: "notes/day.md",
              expectedRevision: "rev-updated",
            },
          ],
        }),
      }))),
    ).resolves.toMatchObject({ ok: true, applied: 1 });

    await expect(
      json(await handler(new Request("http://api.test/workspaces/ws_api/events"))),
    ).resolves.toMatchObject({ ok: true, events: [] });

    expect(observedHeaders).toContain("browser-spoof");
    expect(fixture.calls.every((call) => call.actor.userId === "server_user")).toBe(true);
  });
});
