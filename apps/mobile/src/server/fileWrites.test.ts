import { confirmWords } from "@dohc/interface-words/confirmations";
import { documentWords } from "@dohc/interface-words/documents";
import { describe, expect, it, vi } from "vitest";
import {
  buildTargetPath,
  canWriteFiles,
  editableStem,
  FILE_WRITE_TIMEOUT_MS,
  fileExtension,
  fileWriteOperations,
  fileWriteRefusalText,
  isLifecycleManagedPath,
  newFileRequestId,
} from "./fileWrites";
import type { ServerClient } from "./client";

describe("canWriteFiles", () => {
  it("requires phone writes enabled, owned workspace data, AND server fileWritesAvailable: true", async () => {
    expect(canWriteFiles({ joined: false }, { fileWritesAvailable: true })).toBe(false);
    vi.stubEnv("EXPO_PUBLIC_DOHC_PHONE_WRITES", "1");
    vi.resetModules();
    try {
      const enabled = await import("./fileWrites");
      expect(enabled.canWriteFiles({ joined: false }, { fileWritesAvailable: true })).toBe(true);
      expect(enabled.canWriteFiles({ joined: false }, { fileWritesAvailable: false })).toBe(false);
      expect(enabled.canWriteFiles({ joined: false }, {})).toBe(false);
      expect(enabled.canWriteFiles({ joined: true }, { fileWritesAvailable: true })).toBe(false);
      expect(enabled.canWriteFiles(null, { fileWritesAvailable: true })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("path & stem helpers", () => {
  it("builds valid page and sketch paths while preserving folder and extension", () => {
    expect(buildTargetPath("", "Trip Plan", ".md")).toEqual({ ok: true, path: "Trip Plan.md" });
    expect(buildTargetPath("notes", "Trip Plan.md", ".md")).toEqual({
      ok: true,
      path: "notes/Trip Plan.md",
    });
    expect(buildTargetPath("sketches", "Flow.EXCALIDRAW", ".excalidraw")).toEqual({
      ok: true,
      path: "sketches/Flow.excalidraw",
    });
    expect(editableStem("notes/Plan.md")).toBe("Plan");
    expect(editableStem("sketches/Board.excalidraw")).toBe("Board");
    expect(fileExtension("sketches/Board.excalidraw")).toBe(".excalidraw");
    expect(fileExtension("notes/Plan.md")).toBe(".md");
    expect(isLifecycleManagedPath("Guide.md")).toBe(true);
    expect(isLifecycleManagedPath("notes/Guide.MD")).toBe(true);
    expect(isLifecycleManagedPath("sketches/Board.excalidraw")).toBe(true);
    for (const unsupported of [
      "Guide.markdown",
      "notes/Guide.markdown",
      ".hidden.md",
      "notes/.secret.md",
      ".md",
      ".excalidraw",
      "readme.txt",
      "",
    ]) {
      expect(isLifecycleManagedPath(unsupported), unsupported).toBe(false);
    }
  });

  it("refuses empty, hidden, slash, and Windows-reserved names", () => {
    expect(buildTargetPath("", "   ", ".md")).toEqual({
      ok: false,
      error: documentWords.nameRequired,
    });
    for (const bad of [".secret", "a/b", "a\\b", "CON", ".md", "bad:name"]) {
      expect(buildTargetPath("notes", bad, ".md"), bad).toEqual({
        ok: false,
        error: documentWords.invalidName,
      });
    }
  });
});

describe("fileWriteOperations & refusals", () => {
  it("maps refusal codes to document words and sends operations with the cold-copy timeout", async () => {
    expect(fileWriteRefusalText("path-exists", "x")).toBe(documentWords.refusedExists);
    expect(fileWriteRefusalText("not-found", "x")).toBe(documentWords.refusedMissing);
    expect(fileWriteRefusalText("stale-object", "x")).toBe(documentWords.refusedChanged);
    expect(fileWriteRefusalText("live-active", "x")).toBe(documentWords.refusedLiveActive);
    expect(fileWriteRefusalText("live-unsettled", "x")).toBe(documentWords.refusedLiveUnsettled);
    expect(fileWriteRefusalText("restore-unavailable", "x")).toBe(confirmWords.restoreUnavailable);
    expect(newFileRequestId()).toMatch(/^[A-Za-z0-9._-]{8,96}$/u);

    const send = vi.fn(async (_method, path, read, _body, opts) => {
      expect(opts?.timeoutMs).toBe(FILE_WRITE_TIMEOUT_MS);
      if (path.endsWith("/deleteFile"))
        return read({
          ok: true,
          result: { ok: true, path: "notes/new.md", objectId: "obj-1", deleteMomentId: "mom-1" },
        });
      return read({
        ok: true,
        result: { ok: true, path: "notes/new.md", objectId: "obj-1" },
      });
    });
    const ops = fileWriteOperations({ send } as unknown as ServerClient, "ws-1");
    await expect(ops.createPage({ path: "notes/new.md", requestId: "r1" })).resolves.toEqual({
      ok: true,
      path: "notes/new.md",
      objectId: "obj-1",
    });
    await expect(
      ops.deleteFile({ path: "notes/new.md", expectedObjectId: "obj-1", requestId: "r2" }),
    ).resolves.toEqual({
      ok: true,
      path: "notes/new.md",
      objectId: "obj-1",
      deleteMomentId: "mom-1",
    });
    await expect(
      ops.restoreDeletedFile({
        path: "notes/new.md",
        objectId: "obj-1",
        deleteMomentId: "mom-1",
        requestId: "r3",
      }),
    ).resolves.toEqual({
      ok: true,
      path: "notes/new.md",
      objectId: "obj-1",
    });
    expect(send).toHaveBeenCalledWith(
      "POST",
      "/sync/ws-1/ops/restoreDeletedFile",
      expect.any(Function),
      { path: "notes/new.md", objectId: "obj-1", deleteMomentId: "mom-1", requestId: "r3" },
      { signal: undefined, timeoutMs: FILE_WRITE_TIMEOUT_MS },
    );
  });
});
