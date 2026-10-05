import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { createEngineFileResolver, resolveEngineFileTargets } from "./resolveEngineFiles";

it("pins batches to one version and isolates an oversized legacy hint", async () => {
  const engine = new VersionedLoopbackEngine();
  engine.seedTextFile({ workspace: "w", path: "a.md", text: "a", objectId: "a" });
  const adapter = new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, "w", { workspaceId: "w" });
  const draft = await adapter.createNamedVersion({ workspaceId: "w", name: "Draft", fromVersionId: "main" });
  const resolve = adapter.resolveFiles.bind(adapter);
  const calls = vi.spyOn(adapter, "resolveFiles").mockImplementation(async input => {
    const result = await resolve(input);
    if (input.versionId === undefined) await adapter.setActiveVersion({ workspaceId: "w", versionId: draft.id });
    return result;
  });
  engine.requests.length = 0;
  const targets = [...Array.from({ length: 129 }, () => ({ objectId: "a" })), { path: "x".repeat(49152) }, { path: "../invalid" }, { path: "a.md" }];
  const results = await resolveEngineFileTargets(adapter, "w", targets);
  expect(results).toHaveLength(targets.length);
  expect(results.slice(129, 131)).toEqual([{ status: "invalid" }, { status: "invalid" }]);
  expect(results.at(-1)).toEqual({ status: "found", objectId: "a", path: "a.md" });
  expect(calls.mock.calls[0]![0].versionId).toBeUndefined();
  expect(calls.mock.calls.slice(1).every(([input]) => input.versionId === "main")).toBe(true);
});

it("uses the production chat and graph wrapper without listing the workspace", async () => {
  const engine = new VersionedLoopbackEngine();
  engine.seedTextFile({ workspace: "w", path: "notes/a.md", text: "a", objectId: "a" });
  engine.seedBinaryFile({ workspace: "w", path: "photo.png", bytes: [1], objectId: "photo" });
  const adapter = new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, "w", { workspaceId: "w" });
  const adapterCalls = vi.fn();
  const withAdapter = async <T>(workspace: { workspaceId: string }, work: (adapter: VersionedLiveAdapter) => Promise<T>) => {
    adapterCalls(workspace, work);
    return work(adapter);
  };
  const resolveEngineFiles = createEngineFileResolver(withAdapter);
  const workspace = { workspaceId: "w" };
  expect(await resolveEngineFiles(workspace, [{ path: "./notes//a.md" }, { objectId: "photo" }, { objectId: "gone" }])).toEqual([
    { status: "found", objectId: "a", path: "notes/a.md" },
    { status: "found", objectId: "photo", path: "photo.png" },
    { status: "absent" },
  ]);
  expect(adapterCalls).toHaveBeenCalledWith(workspace, expect.any(Function));
  expect(engine.requests.filter(request => request.method === "versionedText.list")).toHaveLength(0);
  expect(engine.requests.map(request => request.method)).toEqual(["files.resolve"]);
});

it("reports an unavailable engine through the production wrapper", async () => {
  const resolveEngineFiles = createEngineFileResolver(async () => null);
  await expect(resolveEngineFiles({ workspaceId: "w" }, [{ path: "a.md" }])).rejects.toThrow("Workspace engine is unavailable.");
});

it("counts UTF-8 bytes, JSON escapes, commas, and the pinned version across request batches", async () => {
  const engine = new VersionedLoopbackEngine();
  const adapter = new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, "w", { workspaceId: "w" });
  engine.seedTextFile({ workspace: "w", path: "a.md", text: "a", objectId: "a" });
  const targets = Array.from({ length: 8 }, (_, index) => ({ path: ('文"').repeat(3000) + "/" + index + ".md" }));
  const results = await resolveEngineFileTargets(adapter, "w", [...targets, { path: "a.md" }]);
  expect(results).toHaveLength(9);
  expect(results.at(-1)).toEqual({ status: "found", objectId: "a", path: "a.md" });
  const requests = engine.requests.filter(request => request.method === "files.resolve");
  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests) {
    expect(Buffer.byteLength(JSON.stringify(request.params))).toBeLessThanOrEqual(48 * 1024);
  }
  for (const request of requests.slice(1)) expect(request.params).toMatchObject({ versionId: "main" });
});
