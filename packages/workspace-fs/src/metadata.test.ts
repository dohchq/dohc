import { describe, expect, it } from "vitest";
import {
  assetKindForMediaType,
  isSqliteMediaType,
  isTextMediaType,
  mediaTypeForPath,
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
    expect(assetKindForMediaType("text/plain", "plans/use-sqlite.txt")).toBe("file");
  });
});
