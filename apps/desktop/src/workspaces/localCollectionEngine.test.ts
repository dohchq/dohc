import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import { LocalCollectionRefusal, type Envelope } from "./localCollectionApps";
import { localCollectionEngine } from "./localCollectionEngine";
import { EngineWritePolicyError, UnsupportedWorkspacePathError } from "./workspaceEngineCapture";

const envelope: Envelope = { path: "trip/responses/accepted_1.md", text: "---\n{}\n---\n", versionId: "main", author: { kind: "human", humanId: "person-local" },
  requestId: "local-collection-request", momentId: "local-collection-moment" };
function harness() {
  const capture = { writeAuthoredFile: vi.fn(async () => ({ resolvedAbsolutePath: "", materializeOutcome: "applied", objectId: "object", momentId: envelope.momentId, deduped: false })), readMoment: vi.fn() };
  const adapter = { getActiveVersion: vi.fn(), listTextFilePage: vi.fn(), readTextFile: vi.fn() };
  const engine = localCollectionEngine({ workspaceId: "w", rootPath: "/root", capture, withAdapter: work => work(adapter as never) });
  return { capture, adapter, engine };
}

describe("local Collection engine binding", () => {
  it("writes create-only at the saved version with fixed ids", async () => {
    const h = harness();
    expect(await h.engine.create(envelope)).toMatchObject({ objectId: "object", momentId: envelope.momentId });
    expect(h.capture.writeAuthoredFile).toHaveBeenCalledWith(join("/root", envelope.path), envelope.text, envelope.author,
      { createOnly: true, requestId: envelope.requestId, momentId: envelope.momentId, versionId: "main" });
  });

  it.each([
    [new VersionedTextStoreError("invalid-version", "Version main is not active."), true],
    [new VersionedTextStoreError("target-path-exists", "File already exists."), true],
    [new EngineWritePolicyError("Engine refused to write non-engine-owned path."), true],
    [new UnsupportedWorkspacePathError(envelope.path), true],
    [new VersionedTextStoreError("write-precondition-failed", "Changed."), false],
    [new Error("The engine connection closed."), false],
  ])("treats only definitive refusals as final: %s", async (error, definitive) => {
    const h = harness();
    h.capture.writeAuthoredFile.mockRejectedValueOnce(error);
    const result = await h.engine.create(envelope).catch((caught: unknown) => caught);
    expect(result instanceof LocalCollectionRefusal).toBe(definitive);
    if (!definitive) expect(result).toBe(error);
  });

  it("reports a moment's saved version, path, and written text, and never claims a protected one", async () => {
    const h = harness();
    h.capture.readMoment.mockResolvedValueOnce(null);
    expect(await h.engine.moment("m")).toBeNull();
    h.capture.readMoment.mockResolvedValueOnce({ protected: false, moment: { workspaceId: "w", versionId: "main", objectId: "object", path: envelope.path, operation: "write",
      payload: { before: null, after: { path: envelope.path, text: envelope.text } } } });
    expect(await h.engine.moment("m")).toEqual({ workspaceId: "w", versionId: "main", objectId: "object", path: envelope.path, operation: "write", text: envelope.text });
    h.capture.readMoment.mockResolvedValueOnce({ protected: true, moment: {} });
    expect(await h.engine.moment("m")).toMatchObject({ operation: "protected", text: null });
  });

  it("reads published text only, and pages a folder through the engine list", async () => {
    const h = harness();
    h.adapter.readTextFile.mockResolvedValueOnce({ contentKind: "binary", text: null }).mockResolvedValueOnce(null).mockResolvedValueOnce({ contentKind: "text", text: "fields: {}" });
    expect([await h.engine.readText({ versionId: "main", path: "a" }), await h.engine.readText({ versionId: "main", path: "a" }), await h.engine.readText({ versionId: "main", path: "a" })]).toEqual([null, null, "fields: {}"]);
    h.adapter.listTextFilePage.mockResolvedValueOnce({ files: [], more: false });
    await h.engine.listFiles({ versionId: "draft", folder: "trip/responses", afterPath: "trip/responses/a.md", limit: 5 });
    expect(h.adapter.listTextFilePage).toHaveBeenCalledWith({ workspaceId: "w", versionId: "draft", under: "trip/responses", afterPath: "trip/responses/a.md", limit: 5 });
    h.adapter.getActiveVersion.mockResolvedValueOnce(null);
    await expect(h.engine.activeVersionId()).rejects.toThrow(/no active version/);
  });
});
