import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Actor,
  AssetKind,
  AtomKind,
  CreateAtomInput,
  SaveAssetInput,
  WorkspaceBackend,
  WorkspaceFile,
  WriteAtomInput,
} from "@dohc/workspace-contracts";
import { applyFsDiff } from "./apply";
import { scanWorkspaceDiff } from "./diff";
import { materializeWorkspace } from "./materialize";
import { readManifest } from "./metadata";

const actor: Actor = { userId: "user_1", workspaceId: "ws_fs" };

type MemoryFile = WorkspaceFile & {
  body?: string;
  bytes?: Uint8Array;
  assetKind?: AssetKind;
};

function textFile(path: string, body: string, revision = "rev-1"): MemoryFile {
  return {
    id: `atom:${path}`,
    workspaceId: actor.workspaceId,
    path,
    kind: "atom",
    contentType: path.endsWith(".csv") ? "text/csv" : "text/markdown",
    revision,
    updatedAt: 1,
    body,
  };
}

function binaryFile(
  path: string,
  contentType: string,
  bytes: Uint8Array,
  kind: "asset" | "database" = "asset",
  revision = "rev-1",
): MemoryFile {
  return {
    id: `${kind}:${path}`,
    workspaceId: actor.workspaceId,
    path,
    kind,
    contentType,
    revision,
    updatedAt: 1,
    bytes,
    assetKind: contentType.includes("sqlite") ? "sqlite" : "image",
  };
}

function memoryBackend(initial: MemoryFile[]) {
  const files = new Map(initial.map((file) => [file.path, structuredClone(file)]));
  const calls: Array<{ method: string; input: unknown }> = [];
  const backend: WorkspaceBackend = {
    async listFiles() {
      return Array.from(files.values()).map(({ body: _body, bytes: _bytes, assetKind: _assetKind, ...file }) => file);
    },
    async readText(_actor, path) {
      const file = files.get(path);
      if (!file || file.kind !== "atom" || file.body === undefined) {
        throw new Error(`missing text file: ${path}`);
      }
      return { body: file.body, revision: file.revision };
    },
    async readAsset(_actor, path) {
      const file = files.get(path);
      if (!file || (file.kind !== "asset" && file.kind !== "database") || !file.bytes) {
        throw new Error(`missing asset file: ${path}`);
      }
      return {
        mediaType: file.contentType,
        kind: file.assetKind ?? "file",
        bytes: file.bytes,
        revision: file.revision,
      };
    },
    async createAtom(_actor, input: CreateAtomInput) {
      calls.push({ method: "createAtom", input });
      const file = textFile(input.path, input.body, "rev-created");
      file.contentType = contentTypeForAtomKind(input.kind);
      files.set(input.path, file);
      return file;
    },
    async writeAtom(_actor, input: WriteAtomInput) {
      calls.push({ method: "writeAtom", input });
      const file = files.get(input.path);
      if (!file) throw new Error("not found");
      if (file.revision !== input.expectedRevision) throw new Error("stale revision");
      file.body = input.body;
      file.revision = "rev-updated";
      return file;
    },
    async saveAsset(_actor, input: SaveAssetInput) {
      calls.push({ method: "saveAsset", input });
      const file = binaryFile(input.path, input.mediaType, input.bytes, input.kind === "sqlite" ? "database" : "asset", "rev-saved");
      files.set(input.path, file);
      return file;
    },
    async updateAsset(_actor, input) {
      calls.push({ method: "updateAsset", input });
      const existing = files.get(input.path);
      if (!existing) throw new Error("not found");
      if (existing.revision !== input.expectedRevision) throw new Error("stale revision");
      const file = binaryFile(input.path, input.mediaType, input.bytes, input.kind === "sqlite" ? "database" : "asset", "rev-updated");
      files.set(input.path, file);
      return file;
    },
    async renameFile(_actor, input) {
      calls.push({ method: "renameFile", input });
      const file = files.get(input.fromPath);
      if (!file) throw new Error("not found");
      if (file.revision !== input.expectedRevision) throw new Error("stale revision");
      const folder = input.fromPath.includes("/") ? input.fromPath.slice(0, input.fromPath.lastIndexOf("/")) : "";
      const toPath = folder ? `${folder}/${input.toName}` : input.toName;
      files.delete(input.fromPath);
      file.path = toPath;
      file.revision = "rev-renamed";
      files.set(toPath, file);
      return file;
    },
    async deleteFile(_actor, path) {
      calls.push({ method: "deleteFile", input: path });
      files.delete(path);
    },
  };
  return { backend, calls, files };
}

function contentTypeForAtomKind(kind: AtomKind) {
  if (kind === "csv") return "text/csv";
  if (kind === "json") return "application/json";
  if (kind === "html") return "text/html";
  if (kind === "text") return "text/plain";
  return "text/markdown";
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "dohc-workspace-fs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("workspace filesystem projection", () => {
  it("materializes normal files and records manifest metadata", async () => {
    await withTempDir(async (dir) => {
      const { backend } = memoryBackend([
        textFile("finance/transactions.csv", "id,merchant\n1,Grab\n", "rev-csv"),
        binaryFile("uploads/receipt.png", "image/png", new Uint8Array([137, 80, 78, 71]), "asset", "rev-png"),
        binaryFile("finance/ledger.sqlite", "application/vnd.sqlite3", new Uint8Array([83, 81, 76]), "database", "rev-db"),
      ]);

      await materializeWorkspace({
        backend,
        actor,
        targetDir: dir,
        backendMode: "convex",
      });

      await expect(readFile(join(dir, "finance/transactions.csv"), "utf8")).resolves.toContain("Grab");
      await expect(readFile(join(dir, "uploads/receipt.png"))).resolves.toEqual(Buffer.from([137, 80, 78, 71]));
      await expect(stat(join(dir, "finance/ledger.sqlite"))).resolves.toMatchObject({ isFile: expect.any(Function) });
      const manifest = await readManifest(dir);
      expect(manifest).toMatchObject({
        version: 1,
        workspaceId: actor.workspaceId,
        backend: "convex",
        files: {
          "finance/transactions.csv": {
            id: "atom:finance/transactions.csv",
            kind: "atom",
            contentType: "text/csv",
            revision: "rev-csv",
          },
          "uploads/receipt.png": {
            id: "asset:uploads/receipt.png",
            kind: "asset",
            contentType: "image/png",
            revision: "rev-png",
          },
          "finance/ledger.sqlite": {
            id: "database:finance/ledger.sqlite",
            kind: "database",
            contentType: "application/vnd.sqlite3",
            revision: "rev-db",
          },
        },
      });
    });
  });

  it("scans edits into create/update/delete/rename diffs", async () => {
    await withTempDir(async (dir) => {
      const { backend } = memoryBackend([
        textFile("finance/transactions.csv", "id,merchant\n1,Grab\n", "rev-csv"),
        textFile("notes/old.md", "# Old\n", "rev-old"),
        textFile("notes/rename-me.md", "# Rename\n", "rev-rename"),
      ]);
      await materializeWorkspace({ backend, actor, targetDir: dir, backendMode: "postgres" });
      await writeFile(join(dir, "finance/transactions.csv"), "id,merchant\n1,Grab\n2,Cafe\n");
      await rm(join(dir, "notes/old.md"));
      await writeFile(join(dir, "notes/new.txt"), "new note");
      await writeFile(join(dir, "notes/renamed.md"), "# Rename\n");
      await rm(join(dir, "notes/rename-me.md"));

      const diff = await scanWorkspaceDiff(dir);

      expect(diff.operations).toEqual([
        { op: "update", path: "finance/transactions.csv", expectedRevision: "rev-csv" },
        { op: "rename", fromPath: "notes/rename-me.md", toPath: "notes/renamed.md", expectedRevision: "rev-rename" },
        { op: "delete", path: "notes/old.md", expectedRevision: "rev-old" },
        { op: "create", path: "notes/new.txt", mediaType: "text/plain" },
      ]);
    });
  });

  it("applies diffs through backend operations with revision checks", async () => {
    await withTempDir(async (dir) => {
      const { backend, calls, files } = memoryBackend([
        textFile("notes/day.md", "# Day\n", "rev-1"),
      ]);
      await materializeWorkspace({ backend, actor, targetDir: dir, backendMode: "convex" });
      await writeFile(join(dir, "notes/day.md"), "# Day\nUpdated\n");
      files.get("notes/day.md")!.revision = "rev-remote";

      await expect(
        applyFsDiff({ backend, actor, rootDir: dir, diff: await scanWorkspaceDiff(dir) }),
      ).rejects.toThrow(/stale revision/);

      expect(calls).toEqual([
        {
          method: "writeAtom",
          input: {
            path: "notes/day.md",
            expectedRevision: "rev-1",
            body: "# Day\nUpdated\n",
          },
        },
      ]);
    });
  });

  it("rejects path traversal and represents binary creates as assets", async () => {
    await withTempDir(async (dir) => {
      const { backend, calls } = memoryBackend([]);
      await materializeWorkspace({ backend, actor, targetDir: dir, backendMode: "convex" });
      await writeFile(join(dir, "photo.png"), Buffer.from([1, 2, 3]));

      await applyFsDiff({ backend, actor, rootDir: dir, diff: await scanWorkspaceDiff(dir) });

      expect(calls).toEqual([
        {
          method: "saveAsset",
          input: {
            path: "photo.png",
            kind: "image",
            mediaType: "image/png",
            bytes: expect.any(Uint8Array),
          },
        },
      ]);
      await expect(
        applyFsDiff({
          backend,
          actor,
          rootDir: dir,
          diff: { operations: [{ op: "create", path: "../escape.txt", mediaType: "text/plain" }] },
        }),
      ).rejects.toThrow(/path traversal|invalid path/i);
    });
  });

  it("applies SQLite file changes as assets instead of raw CRDT text writes", async () => {
    await withTempDir(async (dir) => {
      const { backend, calls } = memoryBackend([
        binaryFile("finance/ledger.sqlite", "application/vnd.sqlite3", new Uint8Array([1, 2, 3]), "database", "rev-db"),
      ]);
      await materializeWorkspace({ backend, actor, targetDir: dir, backendMode: "postgres" });
      await writeFile(join(dir, "finance/ledger.sqlite"), Buffer.from([4, 5, 6]));

      await applyFsDiff({ backend, actor, rootDir: dir, diff: await scanWorkspaceDiff(dir) });

      // Updating an EXISTING asset routes through updateAsset (saveAsset is
      // create-only) so the expectedRevision arbitrates.
      expect(calls.map((call) => call.method)).toEqual(["updateAsset"]);
      expect(calls[0].input).toMatchObject({
        path: "finance/ledger.sqlite",
        kind: "sqlite",
        mediaType: "application/vnd.sqlite3",
        expectedRevision: "rev-db",
        bytes: expect.any(Uint8Array),
      });
    });
  });
});
