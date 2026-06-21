import { describe, expect, it } from "vitest";
import { COLLAB_TOKEN_TTL_SECONDS, verifyCollabToken } from "@dohc/hocuspocus/auth";
import { decodeDocName } from "@dohc/hocuspocus/doc-name";
import type {
  Actor,
  SaveAssetInput,
  WorkspaceBackend,
  WorkspaceFile,
  WriteAtomInput,
} from "@dohc/workspace-contracts";
import { DEFAULT_APPROVAL_ERROR_REASON, WorkspaceError } from "@dohc/workspace-contracts";
import type pg from "pg";
import { createWorkspaceApiHandler } from "./server";

const actor: Actor = { userId: "user_1", workspaceId: "ws_api" };
const SYNC_APPROVAL_REQUIRED_REASON = DEFAULT_APPROVAL_ERROR_REASON;

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
    async getFileMetadata(resolvedActor, path) {
      calls.push({ method: "getFileMetadata", input: path, actor: resolvedActor });
      const textRow = text.get(path);
      if (textRow) return { ...file(path, "atom", "text/markdown"), revision: textRow.revision };
      const asset = assets.get(path);
      if (asset) return { ...file(path, "asset", asset.mediaType), revision: asset.revision };
      return null;
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
      if (assets.has(input.path)) throw new WorkspaceError("conflict", "File path already exists");
      assets.set(input.path, {
        bytes: input.bytes,
        mediaType: input.mediaType,
        revision: "rev-asset",
      });
      return file(input.path, "asset", input.mediaType);
    },
    async updateAsset(resolvedActor, input) {
      calls.push({ method: "updateAsset", input, actor: resolvedActor });
      const row = assets.get(input.path);
      if (!row) throw new WorkspaceError("not_found", "Asset not found");
      if (row.revision !== input.expectedRevision) {
        throw new WorkspaceError("conflict", "Expected revision is stale");
      }
      assets.set(input.path, {
        bytes: input.bytes,
        mediaType: input.mediaType,
        revision: "rev-asset-updated",
      });
      return file(input.path, "asset", input.mediaType);
    },
    async renameFile() {
      throw new Error("not used");
    },
    async deleteFile(resolvedActor, path, expectedRevision) {
      calls.push({ method: "deleteFile", input: { path, expectedRevision }, actor: resolvedActor });
      if (path === "shared/locked.md") {
        const error = new Error("approval required for locked/shared file");
        (error as Error & { code?: string }).code = SYNC_APPROVAL_REQUIRED_REASON;
        throw error;
      }
      text.delete(path);
      assets.delete(path);
    },
  };
  return { backend, calls, text, assets };
}

async function json(response: Response) {
  return await response.json() as any;
}

// Collab token deps stub: first query is the membership check, second the
// path->atoms.id resolve (mintCollabToken's only two statements).
function stubCollabPool(state: { member: boolean; atomId?: string }): pg.Pool {
  return {
    async query(sql: string) {
      if (/workspace_members/.test(sql)) {
        return { rowCount: state.member ? 1 : 0, rows: [] };
      }
      return {
        rowCount: state.atomId ? 1 : 0,
        rows: state.atomId ? [{ id: state.atomId, kind: "markdown", body: "# Day\n" }] : [],
      };
    },
  } as unknown as pg.Pool;
}

function collabHandler(state: { member: boolean; atomId?: string }, jwtSecret?: string) {
  return createWorkspaceApiHandler({
    backend: memoryBackend().backend,
    resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
    collab: jwtSecret === undefined ? undefined : { pool: stubCollabPool(state), jwtSecret },
  });
}

function postCollabToken(handler: ReturnType<typeof createWorkspaceApiHandler>, body: unknown) {
  return handler(new Request("http://api.test/workspaces/ws_api/collab/token", {
    method: "POST",
    body: JSON.stringify(body),
  }));
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

  it("returns 409 for stale text writes and preserves the existing atom", async () => {
    const fixture = memoryBackend();
    const handler = createWorkspaceApiHandler({
      backend: fixture.backend,
      resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
    });

    const response = await handler(new Request("http://api.test/workspaces/ws_api/files/notes/day.md", {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: "rev-stale",
        body: "# Day\nWrong update\n",
      }),
    }));

    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toMatchObject({
      ok: false,
      error: "stale revision",
    });
    expect(fixture.text.get("notes/day.md")).toEqual({ body: "# Day\n", revision: "rev-1" });
  });

  it("creates workspaces through POST /workspaces with the server-resolved actor", async () => {
    const created: Array<{ actor: Actor; input: unknown }> = [];
    const handler = createWorkspaceApiHandler({
      backend: memoryBackend().backend,
      resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
      createWorkspace: async (resolvedActor, input) => {
        created.push({ actor: resolvedActor, input });
        return { created: created.length === 1 };
      },
    });
    const post = (body: unknown) =>
      handler(new Request("http://api.test/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
      }));

    await expect(json(await post({ workspaceId: "ws-local-1" }))).resolves.toEqual({
      ok: true,
      created: true,
      workspaceId: "ws-local-1",
    });
    await expect(
      json(await post({ workspaceId: "ws-local-1", name: "Notes", kind: "shared" })),
    ).resolves.toEqual({ ok: true, created: false, workspaceId: "ws-local-1" });
    expect(created).toEqual([
      {
        actor: { userId: "server_user", workspaceId: "ws-local-1" },
        input: { workspaceId: "ws-local-1", name: "ws-local-1", kind: "personal" },
      },
      {
        actor: { userId: "server_user", workspaceId: "ws-local-1" },
        input: { workspaceId: "ws-local-1", name: "Notes", kind: "shared" },
      },
    ]);

    for (const body of [{ workspaceId: "Bad_ID!" }, {}, { workspaceId: "ws", kind: "team" }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(created).toHaveLength(2);
  });

  it("lists the session user's workspaces through GET /workspaces", async () => {
    // listUserWorkspaces issues one parameterized select; stub the pool rows.
    const pool = {
      async query(_sql: string, params: unknown[]) {
        expect(params).toEqual(["server_user"]);
        return { rows: [{ workspace_id: "ws-a", name: "Notes" }], rowCount: 1 };
      },
    } as unknown as pg.Pool;
    const handler = createWorkspaceApiHandler({
      backend: memoryBackend().backend,
      resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
      shared: { pool },
    });

    await expect(json(await handler(new Request("http://api.test/workspaces")))).resolves.toEqual({
      ok: true,
      workspaces: [{ workspaceId: "ws-a", name: "Notes" }],
    });

    // Deployments without the shared/cloud pool 404 both workspace-less routes.
    const bare = createWorkspaceApiHandler({
      backend: memoryBackend().backend,
      resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
    });
    expect((await bare(new Request("http://api.test/workspaces"))).status).toBe(404);
    expect((await bare(new Request("http://api.test/shared/atoms/atom-1"))).status).toBe(404);
  });

  it("maps workspace id collisions to 403", async () => {
    const handler = createWorkspaceApiHandler({
      backend: memoryBackend().backend,
      resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
      createWorkspace: async () => {
        throw new WorkspaceError("forbidden", "workspace id belongs to another user");
      },
    });

    const response = await handler(new Request("http://api.test/workspaces", {
      method: "POST",
      body: JSON.stringify({ workspaceId: "stolen-id" }),
    }));
    expect(response.status).toBe(403);
  });

  it("mints hocuspocus-verifiable collab tokens for the server-resolved actor", async () => {
    const handler = collabHandler({ member: true, atomId: "atom-uuid-1" }, "collab-test-secret");
    const body = await json(await postCollabToken(handler, { atomPath: "notes/day.md" }));

    expect(body.ok).toBe(true);
    expect(decodeDocName(body.documentName)).toEqual({
      workspaceId: "ws_api",
      atomId: "atom-uuid-1",
    });
    const claims = await verifyCollabToken(body.token, "collab-test-secret");
    expect(claims).toMatchObject({
      sub: "server_user",
      ws: "ws_api",
      actorKind: "user",
      authzVersion: 1,
    });
    expect(claims.exp - claims.iat).toBe(COLLAB_TOKEN_TTL_SECONDS);
  });

  it("rejects collab token requests for non-members, missing atoms, and disabled deployments", async () => {
    const cases: Array<{ handler: ReturnType<typeof createWorkspaceApiHandler>; body: unknown; status: number; code: string }> = [
      { handler: collabHandler({ member: false, atomId: "a" }, "s"), body: { atomPath: "x.md" }, status: 403, code: "forbidden" },
      { handler: collabHandler({ member: true }, "s"), body: { atomPath: "x.md" }, status: 404, code: "not-found" },
      { handler: collabHandler({ member: true, atomId: "a" }, "s"), body: { workspaceId: "other", atomPath: "x.md" }, status: 403, code: "forbidden" },
      { handler: collabHandler({ member: true, atomId: "a" }, "s"), body: {}, status: 400, code: "invalid-path" },
      { handler: collabHandler({ member: true, atomId: "a" }), body: { atomPath: "x.md" }, status: 400, code: "collab-disabled" },
    ];
    for (const testCase of cases) {
      const response = await postCollabToken(testCase.handler, testCase.body);
      expect(response.status).toBe(testCase.status);
      await expect(json(response)).resolves.toMatchObject({ ok: false, code: testCase.code });
    }
  });

  it("rejects cross-folder sync renames", async () => {
    const fixture = memoryBackend();
    const handler = createWorkspaceApiHandler({
      backend: fixture.backend,
      resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
    });

    const response = await handler(new Request("http://api.test/workspaces/ws_api/sync/apply", {
      method: "POST",
      body: JSON.stringify({
        operations: [{
          op: "rename",
          fromPath: "notes/day.md",
          toPath: "archive/day.md",
          expectedRevision: "rev-1",
        }],
      }),
    }));

    expect(response.status).toBe(400);
    await expect(json(response)).resolves.toMatchObject({
      ok: false,
      error: "cross-folder renames are not supported by workspace sync",
      path: "notes/day.md",
    });
  });

  it("applies a batch resiliently: a failing op reports per-op ok=false without blocking the rest", async () => {
    const fixture = memoryBackend();
    const handler = createWorkspaceApiHandler({
      backend: fixture.backend,
      resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
    });

    const response = await handler(new Request("http://api.test/workspaces/ws_api/sync/apply", {
      method: "POST",
      body: JSON.stringify({
        operations: [
          // Fails: stale revision for the existing atom.
          { op: "update", path: "notes/day.md", expectedRevision: "rev-stale", body: "x" },
          // Succeeds even though it follows the failed op (not fail-fast).
          { op: "create", path: "notes/new.md", body: "# New" },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ ok: true, applied: 1 });
    expect(body.results).toEqual([
      expect.objectContaining({ path: "notes/day.md", ok: false }),
      expect.objectContaining({ path: "notes/new.md", ok: true }),
    ]);
    // The failed op left the original atom untouched; the later op still landed.
    expect(fixture.text.get("notes/day.md")).toEqual({ body: "# Day\n", revision: "rev-1" });
    expect(fixture.text.get("notes/new.md")?.body).toBe("# New");
  });

  it("returns canonical approval codes for per-op sync approval failures", async () => {
    const fixture = memoryBackend();
    fixture.text.set("shared/locked.md", { body: "# Locked\n", revision: "rev-locked" });
    const handler = createWorkspaceApiHandler({
      backend: fixture.backend,
      resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
    });

    const response = await handler(new Request("http://api.test/workspaces/ws_api/sync/apply", {
      method: "POST",
      body: JSON.stringify({
        operations: [
          { op: "delete", path: "shared/locked.md", expectedRevision: "rev-locked" },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      ok: true,
      applied: 0,
      results: [
        {
          path: "shared/locked.md",
          ok: false,
          error: "approval-required",
        },
      ],
    });
  });

  it("routes a binary update through updateAsset, not saveAsset", async () => {
    const fixture = memoryBackend();
    const handler = createWorkspaceApiHandler({
      backend: fixture.backend,
      resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
    });
    const apply = (operations: unknown[]) =>
      handler(new Request("http://api.test/workspaces/ws_api/sync/apply", {
        method: "POST",
        body: JSON.stringify({ operations }),
      }));

    await apply([
      { op: "create", path: "img/p.png", kind: "image", mediaType: "image/png", bytesBase64: Buffer.from([1]).toString("base64") },
    ]);
    await apply([
      { op: "update", path: "img/p.png", expectedRevision: "rev-asset", kind: "image", mediaType: "image/png", bytesBase64: Buffer.from([2]).toString("base64") },
    ]);

    expect(fixture.calls.some((call) => call.method === "updateAsset")).toBe(true);
    expect([...(fixture.assets.get("img/p.png")?.bytes ?? [])]).toEqual([2]);
  });
});
