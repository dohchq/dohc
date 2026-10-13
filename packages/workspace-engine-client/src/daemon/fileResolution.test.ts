import { describe, expect, it } from "vitest";
import { VersionedLiveAdapter } from "../versioned/versionedLiveAdapter";
import { VersionedLoopbackEngine } from "../testing/versionedLoopbackEngine";
import { decodeFileResolveResult } from "./fileResolution";

function fixture() {
  const engine = new VersionedLoopbackEngine();
  engine.seedTextFile({ workspace: "ws", path: " notes/a.md ", text: "large body", objectId: "text" });
  engine.seedBinaryFile({ workspace: "ws", path: "photo.png", bytes: [1, 2], objectId: "binary" });
  return { engine, adapter: new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, "ws", { workspaceId: "ws" }) };
}

describe("files.resolve", () => {
  it("resolves a full reverse batch with long and CJK paths exceeding the request byte cap in its response", async () => {
    const engine = new VersionedLoopbackEngine();
    const files = Array.from({ length: 128 }, (_, index) => ({
      objectId: `file-${index}`,
      path: index % 2 === 0 ? `notes/${"a".repeat(270)}/${index}.md` : `笔记/${"文".repeat(180)}/${index}.md`,
    }));
    for (const file of files) engine.seedTextFile({ workspace: "ws", ...file, text: "body" });
    const adapter = new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, "ws", { workspaceId: "ws" });
    const result = await adapter.resolveFiles({ workspaceId: "ws", targets: files.map(({ objectId }) => ({ objectId })) });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(48 * 1024);
    expect(result.results).toEqual(files.map(file => ({ status: "found", ...file })));
    expect(engine.requests.map(request => request.method)).toEqual(["files.resolve"]);
  });

  it("returns ordered text and binary identity, absence, and local invalid results without listing or reading bodies", async () => {
    const { engine, adapter } = fixture();
    expect(await adapter.resolveFiles({ workspaceId: "ws", targets: [
      { path: "./ notes//a.md " }, { objectId: "binary" }, { path: "missing.md" }, { path: "../outside" }, { path: ".env" }, { objectId: "" },
    ] })).toEqual({ versionId: "main", results: [
      { status: "found", objectId: "text", path: " notes/a.md " }, { status: "found", objectId: "binary", path: "photo.png" },
      { status: "absent" }, { status: "invalid" }, { status: "absent" }, { status: "invalid" },
    ] });
    expect(engine.requests.map(request => request.method)).toEqual(["files.resolve"]);
  });
  it("selects the active version, pins explicit versions, and rejects unknown versions and request bounds", async () => {
    const { adapter } = fixture();
    const draft = await adapter.createNamedVersion({ workspaceId: "ws", fromVersionId: "main", name: "Draft" });
    await adapter.setActiveVersion({ workspaceId: "ws", versionId: draft.id });
    expect((await adapter.resolveFiles({ workspaceId: "ws", targets: [] })).versionId).toBe(draft.id);
    expect((await adapter.resolveFiles({ workspaceId: "ws", versionId: "main", targets: [] })).versionId).toBe("main");
    await expect(adapter.resolveFiles({ workspaceId: "ws", versionId: "unknown", targets: [{ path: "../bad" }] })).rejects.toThrow();
    await expect(adapter.resolveFiles({ workspaceId: "ws", targets: Array.from({ length: 129 }, () => ({ path: "a" })) })).rejects.toThrow("cap");
    await expect(adapter.resolveFiles({ workspaceId: "ws", targets: [{ path: "x".repeat(49152) }] })).rejects.toThrow("cap");
    await expect(adapter.resolveFiles({ workspaceId: "foreign", targets: [] })).rejects.toThrow();
    await expect(adapter.resolveFiles({ workspaceId: "ws", targets: [], signal: AbortSignal.abort() })).rejects.toThrow();
  });
  it("rejects malformed protocol results and mismatched target counts or versions", async () => {
    expect(() => decodeFileResolveResult({ versionId: "main", results: [{ status: "found", path: "a" }] })).toThrow();
    const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) { return { id: request.id, result: { versionId: "other", results: [] } }; } }, "ws", { workspaceId: "ws" });
    await expect(adapter.resolveFiles({ workspaceId: "ws", targets: [{ path: "a" }] })).rejects.toThrow("target count");
    await expect(adapter.resolveFiles({ workspaceId: "ws", versionId: "main", targets: [] })).rejects.toThrow("different version");
  });
});
