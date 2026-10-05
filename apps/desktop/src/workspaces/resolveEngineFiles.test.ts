import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { resolveEngineFileTargets } from "./resolveEngineFiles";

it("pins batches to one version and isolates an oversized legacy hint with zero listing calls", async () => {
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
  expect(engine.requests.filter(request => request.method === "versionedText.list")).toHaveLength(0);
});
