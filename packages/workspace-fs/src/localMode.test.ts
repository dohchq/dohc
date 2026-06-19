import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Actor, WorkspaceBackend, WorkspaceFile } from "@dohc/workspace-contracts";
import { createWorkspaceApiHandler } from "@dohc/workspace-api";
import { createLocalSyncClient } from "./syncClient";

const actor: Actor = { userId: "user_1", workspaceId: "ws_local" };

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
      const handler = createWorkspaceApiHandler({
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
});
