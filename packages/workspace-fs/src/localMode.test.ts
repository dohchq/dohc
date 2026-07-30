import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Actor,
  AssetKind,
  AtomKind,
  WorkspaceBackend,
  WorkspaceFile,
} from "@dohc/workspace-contracts";
import { isApprovalErrorReason } from "@dohc/workspace-contracts";
import { createLocalSyncClient } from "./syncClient";

const actor: Actor = { userId: "user_1", workspaceId: "ws_local" };

// This stub implements the slice of the local sync contract that
// createLocalSyncClient drives — GET files, GET/POST files/:path,
// POST assets, POST sync/apply — over a WorkspaceBackend, so the local-sync
// integration coverage (materialize, push, pull, conflict + approval surfacing)
// survives without a dependency on @dohc/workspace-api.
type StubResolveActor = (request: Request, workspaceId: string) => Actor | Promise<Actor>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readFileResponse(backend: WorkspaceBackend, resolvedActor: Actor, path: string) {
  const files = await backend.listFiles(resolvedActor);
  const metadata = files.find((candidate) => candidate.path === path);
  if (!metadata) throw new Error(`file not found: ${path}`);
  if (metadata.kind === "atom") {
    const read = await backend.readText(resolvedActor, path);
    return { ...metadata, body: read.body, revision: read.revision };
  }
  const read = await backend.readAsset(resolvedActor, path);
  return {
    ...metadata,
    contentType: read.mediaType,
    revision: read.revision,
    bytesBase64: Buffer.from(read.bytes).toString("base64"),
  };
}

// Per-op, non-fail-fast: mirrors the retired applyWorkspaceSync so approval
// failures surface as per-op results[] (ok:false with the approval code) rather
// than a thrown batch error.
async function applyStubSync(
  backend: WorkspaceBackend,
  resolvedActor: Actor,
  operations: Array<Record<string, any>>,
) {
  for (const operation of operations) {
    if (operation.op === "rename" && dirname(operation.fromPath) !== dirname(operation.toPath)) {
      const error = new Error("cross-folder renames are not supported by workspace sync") as Error & { path?: string };
      error.path = operation.fromPath;
      throw error;
    }
  }
  const files: WorkspaceFile[] = [];
  const results: Array<{ path: string; ok: boolean; error?: string; file?: WorkspaceFile | null }> = [];
  let applied = 0;
  for (const operation of operations) {
    const path = operation.op === "rename" ? operation.toPath : operation.path;
    try {
      let file: WorkspaceFile | null = null;
      if (operation.op === "create") {
        file = operation.body !== undefined
          ? await backend.createAtom(resolvedActor, { path: operation.path, kind: (operation.kind as AtomKind) ?? "markdown", body: operation.body })
          : await backend.saveAsset(resolvedActor, { path: operation.path, kind: (operation.kind as AssetKind) ?? "file", mediaType: operation.mediaType ?? "application/octet-stream", bytes: Buffer.from(operation.bytesBase64 ?? "", "base64") });
      } else if (operation.op === "update") {
        file = operation.body !== undefined
          ? await backend.writeAtom(resolvedActor, { path: operation.path, expectedRevision: operation.expectedRevision, body: operation.body })
          : await backend.updateAsset(resolvedActor, { path: operation.path, expectedRevision: operation.expectedRevision, kind: (operation.kind as AssetKind) ?? "file", mediaType: operation.mediaType ?? "application/octet-stream", bytes: Buffer.from(operation.bytesBase64 ?? "", "base64") });
      } else if (operation.op === "delete") {
        await backend.deleteFile(resolvedActor, operation.path, operation.expectedRevision);
      } else {
        const toName = operation.toPath.includes("/") ? operation.toPath.slice(operation.toPath.lastIndexOf("/") + 1) : operation.toPath;
        file = await backend.renameFile(resolvedActor, { fromPath: operation.fromPath, toName, expectedRevision: operation.expectedRevision });
      }
      if (file) files.push(file);
      applied += 1;
      results.push({ path, ok: true, file });
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : undefined;
      const message = isApprovalErrorReason(code) ? code : error instanceof Error ? error.message : String(error);
      results.push({ path, ok: false, error: message });
    }
  }
  return { ok: true, applied, files, results };
}

function createStubWorkspaceApiHandler({
  backend,
  resolveActor,
}: {
  backend: WorkspaceBackend;
  resolveActor: StubResolveActor;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const parts = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== "workspaces" || !parts[1]) return jsonResponse({ ok: false, error: "not found" }, 404);
      const resolvedActor = { ...(await resolveActor(request, parts[1])), workspaceId: parts[1] };
      const section = parts[2];

      if (section === "files" && request.method === "GET" && parts.length === 3) {
        return jsonResponse({ ok: true, files: await backend.listFiles(resolvedActor) });
      }
      if (section === "files" && request.method === "GET" && parts.length > 3) {
        return jsonResponse({ ok: true, file: await readFileResponse(backend, resolvedActor, parts.slice(3).join("/")) });
      }
      if (section === "files" && request.method === "POST" && parts.length > 3) {
        const path = parts.slice(3).join("/");
        const input = (await request.json()) as { expectedRevision?: string; body: string; kind?: AtomKind };
        const file = input.expectedRevision
          ? await backend.writeAtom(resolvedActor, { path, expectedRevision: input.expectedRevision, body: input.body })
          : await backend.createAtom(resolvedActor, { path, kind: input.kind ?? "markdown", body: input.body });
        return jsonResponse({ ok: true, file });
      }
      if (section === "assets" && request.method === "POST") {
        const input = (await request.json()) as { path: string; kind: AssetKind; mediaType: string; bytesBase64: string };
        const file = await backend.saveAsset(resolvedActor, { path: input.path, kind: input.kind, mediaType: input.mediaType, bytes: Buffer.from(input.bytesBase64, "base64") });
        return jsonResponse({ ok: true, file });
      }
      if (section === "sync" && parts[3] === "apply" && request.method === "POST") {
        const { operations } = (await request.json()) as { operations: Array<Record<string, any>> };
        return jsonResponse(await applyStubSync(backend, resolvedActor, operations));
      }
      return jsonResponse({ ok: false, error: "not found" }, 404);
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : undefined;
      const path = typeof error === "object" && error && "path" in error ? String((error as { path?: unknown }).path) : undefined;
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ ok: false, error: message, ...(code ? { code } : {}), ...(path ? { path } : {}) }, 400);
    }
  };
}

function workspaceFile(path: string, revision: string): WorkspaceFile {
  return {
    id: `atom:${path}`,
    workspaceId: actor.workspaceId,
    path,
    kind: "atom",
    contentType: "text/markdown",
    revision,
    updatedAt: 1,
  };
}

function memoryBackend() {
  const text = new Map<string, { body: string; revision: string; locked?: boolean }>([
    ["notes/day.md", { body: "# Day\n", revision: "rev-1" }],
    ["shared/locked.md", { body: "# Locked\n", revision: "rev-locked", locked: true }],
    ["sites/review/app.tsx", { body: "export default {}\n", revision: "rev-site" }],
  ]);
  const backend: WorkspaceBackend = {
    async listFiles() {
      return Array.from(text.entries()).map(([path, row]) => workspaceFile(path, row.revision));
    },
    async readText(_actor, path) {
      const row = text.get(path);
      if (!row) throw new Error("not found");
      return { body: row.body, revision: row.revision };
    },
    async readAsset() {
      throw new Error("not used");
    },
    async createAtom(_actor, input) {
      text.set(input.path, { body: input.body, revision: "rev-created" });
      return workspaceFile(input.path, "rev-created");
    },
    async writeAtom(_actor, input) {
      const row = text.get(input.path);
      if (!row) throw new Error("not found");
      if (row.revision !== input.expectedRevision) throw new Error("stale revision");
      row.body = input.body;
      row.revision = `rev-${Date.now()}`;
      return workspaceFile(input.path, row.revision);
    },
    async saveAsset() {
      throw new Error("not used");
    },
    async updateAsset() {
      throw new Error("not used");
    },
    async renameFile() {
      throw new Error("not used");
    },
    async deleteFile(_actor, path, expectedRevision) {
      const row = text.get(path);
      if (row?.locked) {
        const error = new Error("approval required for locked/shared file");
        (error as Error & { code?: string }).code = "approval-required";
        throw error;
      }
      if (row && expectedRevision !== undefined && row.revision !== expectedRevision) {
        throw new Error("stale revision");
      }
      text.delete(path);
    },
  };
  return { backend, text };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "dohc-local-mode-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("local filesystem sync mode", () => {
  it("materializes, syncs local edits, pulls remote updates, creates conflicts, and surfaces delete approvals", async () => {
    await withTempDir(async (dir) => {
      const fixture = memoryBackend();
      const handler = createStubWorkspaceApiHandler({
        backend: fixture.backend,
        resolveActor: async (_request, workspaceId) => ({ ...actor, workspaceId }),
      });
      const client = createLocalSyncClient({
        rootDir: dir,
        workspaceId: actor.workspaceId,
        baseUrl: "http://workspace-api.test",
        fetch: async (input, init) =>
          handler(new Request(input instanceof Request ? input.url : String(input), init)),
      });

      await client.materialize();
      await expect(readFile(join(dir, "notes/day.md"), "utf8")).resolves.toBe("# Day\n");

      await writeFile(join(dir, "notes/day.md"), "# Day\nLocal edit\n");
      await expect(client.syncLocalChanges()).resolves.toMatchObject({
        applied: 1,
        conflicts: [],
        approvalRequests: [],
      });
      expect(fixture.text.get("notes/day.md")?.body).toBe("# Day\nLocal edit\n");

      fixture.text.set("notes/day.md", { body: "# Day\nRemote edit\n", revision: "rev-remote" });
      await client.pullRemote();
      await expect(readFile(join(dir, "notes/day.md"), "utf8")).resolves.toBe("# Day\nRemote edit\n");

      await writeFile(join(dir, "notes/day.md"), "# Day\nLocal conflicting edit\n");
      fixture.text.set("notes/day.md", { body: "# Day\nAnother remote edit\n", revision: "rev-remote-2" });
      await expect(client.syncLocalChanges()).resolves.toMatchObject({
        applied: 0,
        conflicts: [
          expect.objectContaining({
            path: "notes/day.md",
            conflictPath: "notes/day.md.conflict",
          }),
        ],
      });
      await expect(readFile(join(dir, "notes/day.md.conflict"), "utf8")).resolves.toContain("Local conflicting edit");
      expect(fixture.text.get("notes/day.md")?.body).toBe("# Day\nAnother remote edit\n");

      await rm(join(dir, "shared/locked.md"));
      await expect(client.syncLocalChanges()).resolves.toMatchObject({
        approvalRequests: [
          expect.objectContaining({
            path: "shared/locked.md",
            reason: expect.stringMatching(/approval/i),
          }),
        ],
      });
      expect(fixture.text.has("shared/locked.md")).toBe(true);
      await expect(readFile(join(dir, "shared/locked.md"), "utf8")).rejects.toThrow();
    });
  });

  it("syncs local site source edits without publish approval", async () => {
    await withTempDir(async (dir) => {
      const fixture = memoryBackend();
      const handler = createStubWorkspaceApiHandler({
        backend: fixture.backend,
        resolveActor: async (_request, workspaceId) => ({ ...actor, workspaceId }),
      });
      const client = createLocalSyncClient({
        rootDir: dir,
        workspaceId: actor.workspaceId,
        baseUrl: "http://workspace-api.test",
        fetch: async (input, init) =>
          handler(new Request(input instanceof Request ? input.url : String(input), init)),
      });

      await client.materialize();
      await writeFile(join(dir, "sites/review/app.tsx"), "export default { changed: true }\n");

      await expect(client.syncLocalChanges()).resolves.toMatchObject({
        applied: 1,
        conflicts: [],
        approvalRequests: [],
      });
      expect(fixture.text.get("sites/review/app.tsx")?.body).toBe("export default { changed: true }\n");
    });
  });
});
