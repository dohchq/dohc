import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import type { EngineWorkspace } from "@dohc/workspace-engine-client/daemon";
import type { ReceivedInventory } from "./receivedShareStore";
import type { RegistryEntry } from "./registryStore";
import { createEngineFileResolver, workspaceFileRef } from "./resolveEngineFiles";
import { workspaceFileReferenceScopes } from "./workspaceFileReferenceScopes";

function fixture(mount = false) {
  const workspace: EngineWorkspace = { workspaceId: "recipient", rootPath: "/recipient", attachmentId: Symbol() };
  const marker = { shareId: "share", granterEmail: null, genericChatWritable: false, sourceWorkspaceId: "source",
    grantId: "grant", grantGeneration: 1, relayUrl: "https://relay", label: "Shared",
    grantedSelector: { paths: ["allowed"], versionId: null, access: "view" as const } };
  let current = { ...workspace, ...(mount ? { shareMounts: [marker] } : { shareView: marker }) } as unknown as RegistryEntry;
  let live = true;
  let engineSessionCurrent = true;
  let grants: ReceivedInventory | null = null;
  const engine = new VersionedLoopbackEngine();
  const adapters = new Map<string, VersionedLiveAdapter>();
  const used: EngineWorkspace[] = [];
  const resolver = createEngineFileResolver<EngineWorkspace>(async (location, work) => {
    used.push(location);
    let adapter = adapters.get(location.workspaceId);
    if (!adapter) {
      if (!mount || location.workspaceId !== "recipient") engine.seedTextFile({ workspace: location.workspaceId, path: "allowed/a.md", text: "a", objectId: "a" });
      engine.seedTextFile({ workspace: location.workspaceId, path: "private.md", text: "private", objectId: "outside" });
      adapter = new VersionedLiveAdapter({ close() {}, sendRequest: request => engine.sendRequest(request) }, location.workspaceId, { workspaceId: location.workspaceId });
      adapters.set(location.workspaceId, adapter);
      engine.seedTextFile({ workspace: location.workspaceId, path: "allowed/deleted.md", text: "deleted", objectId: "deleted" });
      await adapter.deleteTextFile({ workspaceId: location.workspaceId, versionId: "main", path: "allowed/deleted.md", metadata: { origin: "api" } });
    }
    return work(adapter, () => { if (!engineSessionCurrent) throw new Error("Engine session replaced"); });
  }, location => workspaceFileReferenceScopes(location, {
    current: () => current, liveGrants: () => grants, assertCurrent: () => { if (!live) throw new Error("Retired session"); },
    shareWorkspace: input => ({ workspaceId: input.engineWorkspaceId, rootPath: input.rootPath, shareMount: true }),
  }));
  return { workspace, marker, engine, resolver, used, adapters,
    replaceEngine: () => { engineSessionCurrent = false; },
    setGrants: (generation: number) => { grants = { received: [{ shareId: "share", grantId: "grant", generation, granterUserId: "owner",
      granterEmail: null, createdAtMs: 0, genericChatWritable: false, selector: { paths: ["allowed"], versionId: null }, access: "view" }], removed: [] }; },
    setInventory: (value: ReceivedInventory) => { grants = value; },
    addMount: () => { current = { ...current, shareMounts: [marker, { ...marker, shareId: "second", label: "Second" }] }; },
    local: () => { current = { ...workspace } as unknown as RegistryEntry; },
    replace: () => { current = { ...current, rootPath: "/replacement" }; }, retire: () => { live = false; } };
}

it.each([false, true])("returns indistinguishable absent results through a received projection (mount=%s)", async mount => {
  const f = fixture(mount);
  const refs = ["outside", "deleted", "never"].map(id => workspaceFileRef("source", id, "allowed/a.md"));
  expect(await f.resolver(f.workspace, refs)).toEqual(refs.map(() => ({ status: "absent" })));
  const [found] = await f.resolver(f.workspace, [{ path: mount ? "shared-with-me/Shared/allowed/a.md" : "allowed/a.md" }]);
  expect(found).toMatchObject({ status: "found", ref: { workspaceId: "source", target: { kind: "file", objectId: "a" } } });
  expect(await f.resolver(f.workspace, [workspaceFileRef("recipient", "a")])).toEqual([{ status: "absent" }]);
  expect(f.engine.requests.some(request => request.method === "versionedText.list")).toBe(false);
});

it.each(["selector", "version", "grant", "session", "attachment"])("rejects a %s change during a batch await", async change => {
  const f = fixture();
  await f.resolver(f.workspace, [{ path: "allowed/a.md" }]);
  const adapter = f.adapters.get("recipient")!;
  const resolve = adapter.resolveFiles.bind(adapter);
  vi.spyOn(adapter, "resolveFiles").mockImplementation(async input => {
    const result = await resolve(input);
    if (change === "selector") f.marker.grantedSelector.paths = ["private"];
    if (change === "version") Object.assign(f.marker.grantedSelector, { versionId: "other" });
    if (change === "grant") f.marker.grantGeneration++;
    if (change === "session") f.retire();
    if (change === "attachment") f.replace();
    return result;
  });
  await expect(f.resolver(f.workspace, Array.from({ length: 129 }, () => workspaceFileRef("source", "a")))).rejects.toThrow();
  expect(vi.mocked(adapter.resolveFiles)).toHaveBeenCalledTimes(1);
});

it("makes a moved object unavailable outside the selector and restores the same identity on return", async () => {
  const f = fixture();
  const [first] = await f.resolver(f.workspace, [{ path: "allowed/a.md" }]);
  if (first?.status !== "found" || !first.ref) throw new Error("Missing fixture");
  const adapter = f.adapters.get("recipient")!;
  await adapter.renameTextFile({ workspaceId: "recipient", versionId: "main", metadata: { origin: "api" }, fromPath: "allowed/a.md", toPath: "outside/a.md" });
  expect(await f.resolver(f.workspace, [first.ref])).toEqual([{ status: "absent" }]);
  await adapter.renameTextFile({ workspaceId: "recipient", versionId: "main", metadata: { origin: "api" }, fromPath: "outside/a.md", toPath: "allowed/back.md" });
  expect(await f.resolver(f.workspace, [first.ref])).toMatchObject([{ status: "found", path: "allowed/back.md", ref: { target: { objectId: "a" }, workspaceId: "source" } }]);
});


it.each(["engine session", "acquired grant"])("rejects an unchanged registry when the %s changes during an await", async change => {
  const f = fixture();
  f.setGrants(1);
  await f.resolver(f.workspace, [{ path: "allowed/a.md" }]);
  const adapter = f.adapters.get("recipient")!;
  const resolve = adapter.resolveFiles.bind(adapter);
  vi.spyOn(adapter, "resolveFiles").mockImplementation(async input => {
    const result = await resolve(input);
    if (change === "engine session") f.replaceEngine(); else f.setGrants(2);
    return result;
  });
  await expect(f.resolver(f.workspace, [workspaceFileRef("source", "a")])).rejects.toThrow();
});

it("refuses a source pin superseded by an acquired grant generation", async () => {
  const f = fixture(); f.setGrants(2);
  expect(await f.resolver(f.workspace, [workspaceFileRef("source", "a")])).toEqual([{ status: "absent" }]);
  expect(f.used).toHaveLength(0);
});


it.each(["missing source", "missing inventory row", "stale generation"])("keeps explicit path lookups available with %s", async state => {
  const f = fixture();
  if (state === "missing source") Object.assign(f.marker, { sourceWorkspaceId: undefined });
  if (state === "missing inventory row") f.setInventory({ received: [], removed: [] });
  if (state === "stale generation") f.setGrants(2);
  const [result] = await f.resolver(f.workspace, [{ path: "allowed/a.md" }]);
  expect(result).toMatchObject({ status: "found", objectId: "a", path: "allowed/a.md" });
  if (state !== "missing inventory row") {
    expect(result).toMatchObject({ ref: null });
    expect(await f.resolver(f.workspace, [workspaceFileRef("source", "a")])).toEqual([{ status: "absent" }]);
  } else expect(result).toMatchObject({ ref: { workspaceId: "source" } });
  expect(await f.resolver(f.workspace, [{ path: "private.md" }])).toEqual([{ status: "absent" }]);
});

it("resolves a source reference through multiple admitted shares of that source", async () => {
  const f = fixture(true); f.addMount();
  expect(await f.resolver(f.workspace, [workspaceFileRef("source", "a")])).toMatchObject([
    { status: "found", ref: { workspaceId: "source", target: { objectId: "a" } } },
  ]);
});

it.each([false, true])("ignores equivalent inventory refreshes and presentation changes (local=%s)", async local => {
  const f = fixture(); if (local) f.local(); else f.setGrants(1);
  await f.resolver(f.workspace, [{ path: "allowed/a.md" }]);
  const adapter = f.adapters.get("recipient")!;
  const resolve = adapter.resolveFiles.bind(adapter);
  vi.spyOn(adapter, "resolveFiles").mockImplementation(async input => {
    const result = await resolve(input);
    f.setGrants(local ? 2 : 1);
    Object.assign(f.marker, { skippedOps: { generation: 2 }, unsavedPaths: ["pending.md"] });
    return result;
  });
  expect(await f.resolver(f.workspace, [{ path: "allowed/a.md" }])).toMatchObject([{ status: "found" }]);
});
