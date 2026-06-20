import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Actor, WorkspaceBackend, WorkspaceFile } from "@dohc/workspace-contracts";
import {
  applyWorkspaceShellDiff,
  captureWorkspaceShellDiff,
  discardWorkspaceShellDiff,
  runWorkspaceShellCommand,
  startWorkspaceShellSession,
} from "./server";

const actor: Actor = { userId: "user_1", workspaceId: "ws_shell" };

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
  const text = new Map<string, { body: string; revision: string; locked?: boolean; trustRequired?: boolean }>([
    ["notes/day.md", { body: "# Day\n", revision: "rev-1" }],
    ["shared/locked.md", { body: "# Locked\n", revision: "rev-locked", locked: true }],
    ["apps/tracker.js", { body: "export default {}\n", revision: "rev-app", trustRequired: true }],
  ]);
  const assets = new Map<string, { bytes: Uint8Array; mediaType: string; revision: string }>();
  const backend: WorkspaceBackend = {
    async listFiles() {
      return [
        ...Array.from(text.entries()).map(([path, row]) => workspaceFile(path, row.revision)),
        ...Array.from(assets.entries()).map(([path, row]) => ({
          ...workspaceFile(path, row.revision),
          id: `asset:${path}`,
          kind: "database" as const,
          contentType: row.mediaType,
        })),
      ];
    },
    async readText(_actor, path) {
      const row = text.get(path);
      if (!row) throw new Error("not found");
      return { body: row.body, revision: row.revision };
    },
    async readAsset() {
      throw new Error("not found");
    },
    async createAtom(_actor, input) {
      text.set(input.path, { body: input.body, revision: "rev-created" });
      return workspaceFile(input.path, "rev-created");
    },
    async writeAtom(_actor, input) {
      const row = text.get(input.path);
      if (!row) throw new Error("not found");
      if (row.locked) {
        const error = new Error("approval required for locked file");
        (error as Error & { code?: string }).code = "approval-required";
        throw error;
      }
      if (row.trustRequired) {
        const error = new Error("site publish approval required before writing site source");
        (error as Error & { code?: string }).code = "site-publish-required";
        throw error;
      }
      if (row.revision !== input.expectedRevision) throw new Error("stale revision");
      row.body = input.body;
      row.revision = `rev-${Date.now()}`;
      return workspaceFile(input.path, row.revision);
    },
    async saveAsset(_actor, input) {
      assets.set(input.path, {
        bytes: input.bytes,
        mediaType: input.mediaType,
        revision: "rev-asset",
      });
      return {
        ...workspaceFile(input.path, "rev-asset"),
        id: `asset:${input.path}`,
        kind: input.kind === "sqlite" ? "database" : "asset",
        contentType: input.mediaType,
      };
    },
    async updateAsset() {
      throw new Error("not used");
    },
    async renameFile() {
      throw new Error("not used");
    },
    async deleteFile(_actor, path) {
      text.delete(path);
    },
  };
  return { backend, text };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "dohc-agent-sandbox-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("agent workspace shell sandbox", () => {
  it("mounts a projected workspace, runs allowed dev commands, captures diffs, and applies through policy", async () => {
    await withTempDir(async (rootDir) => {
      const fixture = memoryBackend();
      const session = await startWorkspaceShellSession({
        backend: fixture.backend,
        actor,
        rootDir,
      });

      await expect(readFile(join(session.mountPath, "notes/day.md"), "utf8")).resolves.toBe("# Day\n");

      await expect(runWorkspaceShellCommand(session, { command: "cat", args: ["notes/day.md"] }))
        .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("# Day") });
      await expect(runWorkspaceShellCommand(session, { command: "rg", args: ["Day", "notes"] }))
        .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("notes/day.md") });
      await expect(runWorkspaceShellCommand(session, { command: "node", args: ["-e", "console.log('node-ok')"] }))
        .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("node-ok") });
      await expect(runWorkspaceShellCommand(session, { command: "python", args: ["-c", "print('python-ok')"] }))
        .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("python-ok") });
      await expect(runWorkspaceShellCommand(session, { command: "sqlite3", args: ["scratch.sqlite", "select 1;"] }))
        .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("1") });

      await runWorkspaceShellCommand(session, {
        command: "node",
        args: ["-e", "require('fs').writeFileSync('notes/day.md', '# Day\\nSandbox edit\\n')"],
      });
      const diff = await captureWorkspaceShellDiff(session);
      expect(diff.operations).toEqual([
        { op: "update", path: "notes/day.md", expectedRevision: "rev-1" },
        { op: "create", path: "scratch.sqlite", mediaType: "application/vnd.sqlite3" },
      ]);
      await expect(applyWorkspaceShellDiff(session, { backend: fixture.backend, actor, diff }))
        .resolves.toMatchObject({ applied: 2, approvalRequests: [] });
      expect(fixture.text.get("notes/day.md")?.body).toBe("# Day\nSandbox edit\n");
    });
  });

  it("blocks workspace escapes and turns lock/site-publish write attempts into approval requests", async () => {
    await withTempDir(async (rootDir) => {
      const fixture = memoryBackend();
      const session = await startWorkspaceShellSession({
        backend: fixture.backend,
        actor,
        rootDir,
      });
      expect(session.cleanupDir).toBeUndefined();
      await writeFile(join(dirname(session.mountPath), "secret.txt"), "outside secret");

      await expect(
        runWorkspaceShellCommand(session, { command: "cat", args: ["../secret.txt"] }),
      ).rejects.toThrow(/outside mounted workspace/i);
      await expect(
        runWorkspaceShellCommand(session, { command: "cat", args: ["-o/tmp/file"] }),
      ).rejects.toThrow(/outside mounted workspace/i);
      await expect(
        runWorkspaceShellCommand(session, { command: "cat", args: ["--opt=/etc/passwd"] }),
      ).rejects.toThrow(/outside mounted workspace/i);
      await expect(
        runWorkspaceShellCommand(session, { command: "cat", args: ["-I../secret"] }),
      ).rejects.toThrow(/outside mounted workspace/i);

      await runWorkspaceShellCommand(session, {
        command: "node",
        args: [
          "-e",
          [
            "const fs = require('fs')",
            "fs.writeFileSync('shared/locked.md', '# Locked\\nchanged\\n')",
            "fs.writeFileSync('apps/tracker.js', 'export default {changed:true}\\n')",
          ].join(";"),
        ],
      });
      const diff = await captureWorkspaceShellDiff(session);
      await expect(applyWorkspaceShellDiff(session, { backend: fixture.backend, actor, diff }))
        .resolves.toMatchObject({
          applied: 0,
          approvalRequests: [
            expect.objectContaining({ path: "apps/tracker.js", reason: expect.stringMatching(/site publish/i) }),
            expect.objectContaining({ path: "shared/locked.md", reason: expect.stringMatching(/approval|lock/i) }),
          ],
        });
      expect(fixture.text.get("shared/locked.md")?.body).toBe("# Locked\n");
      expect(fixture.text.get("apps/tracker.js")?.body).toBe("export default {}\n");
    });
  });

  it("cleans up temporary mounts when a session is discarded", async () => {
    const fixture = memoryBackend();
    const session = await startWorkspaceShellSession({
      backend: fixture.backend,
      actor,
    });
    const cleanupDir = session.cleanupDir;
    expect(cleanupDir).toBeTruthy();
    if (!cleanupDir) throw new Error("expected temporary cleanup directory");

    discardWorkspaceShellDiff(session);

    await expect(access(cleanupDir)).rejects.toThrow();
    expect(session.cleanupDir).toBeUndefined();
  });
});
