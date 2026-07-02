import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assetKindForMediaType,
  CorruptManifestError,
  isSqliteMediaType,
  isTextMediaType,
  MANIFEST_PATH,
  mediaTypeForPath,
  readManifest,
} from "./metadata";

describe("workspace filesystem metadata", () => {
  it("recognizes SQLite by exact media type token or basename extension", () => {
    expect(isSqliteMediaType("application/vnd.sqlite3")).toBe(true);
    expect(isSqliteMediaType("application/x-sqlite; charset=binary")).toBe(true);
    expect(isSqliteMediaType("application/vnd.dohc+sqlite")).toBe(true);
    expect(isSqliteMediaType("application/octet-stream", "data/cache.db")).toBe(true);
    expect(mediaTypeForPath("data/cache.db")).toBe("application/vnd.sqlite3");
  });

  it("keeps text files that merely mention sqlite out of the SQLite path", () => {
    expect(isSqliteMediaType("text/markdown", "notes/sqlite-migration.md")).toBe(false);
    expect(isSqliteMediaType("text/plain", "plans/use-sqlite.txt")).toBe(false);
    expect(isTextMediaType("text/markdown", "notes/sqlite-migration.md")).toBe(true);
    expect(isTextMediaType("application/octet-stream", "scripts/run.sh")).toBe(true);
    expect(assetKindForMediaType("text/plain", "plans/use-sqlite.txt")).toBe("file");
  });

  it("keeps site source files text-readable while preserving explicit media types", () => {
    expect(mediaTypeForPath("sites/review/src/App.tsx")).toBe("application/typescript");
    expect(mediaTypeForPath("Sites/review/src/App.tsx")).toBe("application/typescript");
    expect(mediaTypeForPath("client/src/App.tsx")).toBe("application/typescript");
    expect(isTextMediaType("application/octet-stream", "sites/review/src/App.tsx")).toBe(true);
    expect(isTextMediaType("application/octet-stream", "Sites/review/src/App.tsx")).toBe(true);
    expect(isTextMediaType("application/octet-stream", "client/src/App.tsx")).toBe(false);
  });

  it("rejects malformed sync manifests with an explicit corrupt-manifest error", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-manifest-"));
    try {
      await mkdir(join(root, ".dohc"));
      await writeFile(join(root, MANIFEST_PATH), JSON.stringify({ version: 1, workspaceId: "ws", backend: "postgres", files: null }));
      await expect(readManifest(root)).rejects.toBeInstanceOf(CorruptManifestError);
      await writeFile(join(root, MANIFEST_PATH), "null");
      await expect(readManifest(root)).rejects.toBeInstanceOf(CorruptManifestError);
      await writeFile(
        join(root, MANIFEST_PATH),
        JSON.stringify({
          version: 1,
          workspaceId: "ws",
          backend: "postgres",
          files: {
            "note.md": { id: "atom-1", kind: "atom", contentType: "text/markdown", revision: 42 },
          },
        }),
      );
      await expect(readManifest(root)).rejects.toBeInstanceOf(CorruptManifestError);
      await writeFile(
        join(root, MANIFEST_PATH),
        JSON.stringify({
          version: 1,
          workspaceId: "ws",
          backend: "postgres",
          files: {
            "../note.md": {
              id: "atom-1",
              kind: "atom",
              contentType: "text/markdown",
              revision: "rev-1",
            },
          },
        }),
      );
      await expect(readManifest(root)).rejects.toBeInstanceOf(CorruptManifestError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
