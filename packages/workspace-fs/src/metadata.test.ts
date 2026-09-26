import { describe, expect, it } from "vitest";
import { isSqliteMediaType, isTextMediaType, mediaTypeForPath } from "./metadata";
import textMediaCases from "../text-media-cases.json";

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
  });

  it("keeps site source files text-readable while preserving explicit media types", () => {
    expect(mediaTypeForPath("sites/review/src/App.tsx")).toBe("application/typescript");
    expect(mediaTypeForPath("Sites/review/src/App.tsx")).toBe("application/typescript");
    expect(mediaTypeForPath("client/src/App.tsx")).toBe("application/typescript");
    expect(isTextMediaType("application/octet-stream", "sites/review/src/App.tsx")).toBe(true);
    expect(isTextMediaType("application/octet-stream", "Sites/review/src/App.tsx")).toBe(true);
    expect(isTextMediaType("application/octet-stream", "client/src/App.tsx")).toBe(false);
  });

  // The engine's `is_text_media_type` reads the same cases, so the two rules
  // cannot drift apart.
  it.each(textMediaCases)("routes $path ($mediaType) to text: $text", ({ mediaType, path, text }) => {
    expect(isTextMediaType(mediaType, path)).toBe(text);
  });

  it("gives a Collection's schema and automations the media type the capture reads", () => {
    expect(isTextMediaType(mediaTypeForPath("trip/collection.yaml"), "trip/collection.yaml")).toBe(true);
    expect(isTextMediaType(mediaTypeForPath("trip/automations.yaml"), "trip/automations.yaml")).toBe(true);
    expect(isTextMediaType(mediaTypeForPath("trip/notes.yaml"), "trip/notes.yaml")).toBe(false);
  });
});
