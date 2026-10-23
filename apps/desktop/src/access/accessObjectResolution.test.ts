import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { hasAccessChat, locateAccessVersionPath, resolveAccessFileObject, resolveAccessObject } from "./accessObjectResolution";
import type { RegistryEntry } from "../workspaces/registryStore";

it("resolves binary files and binary-only folders in a non-main version without a full listing", async () => {
  const engine = new VersionedLoopbackEngine();
  const workspace = { workspaceId: "w", rootPath: "/w" } as RegistryEntry;
  const adapter = new VersionedLiveAdapter({ sendRequest: request => engine.sendRequest(request), close() {} }, "w", { workspaceId: "w" });
  await adapter.ensureMainVersion({ workspaceId: "w" });
  const version = await adapter.createNamedVersion({ workspaceId: "w", name: "draft", fromVersionId: "main" });
  await adapter.setActiveVersion({ workspaceId: "w", versionId: version.id });
  await adapter.writeBinaryFile({ workspaceId: "w", versionId: version.id, path: "Pictures/photo.png",
    bytes: new Uint8Array([137, 80, 78, 71]), metadata: { origin: "api" } });
  const wholeListing = vi.spyOn(adapter, "listTextFileMetadata");
  const page = vi.spyOn(adapter, "listTextFilePage");
  const resolve = vi.spyOn(adapter, "resolveFiles");
  const ports = { filePathForObjectId: async () => null, hasChat: async () => false,
    locatePath: (path: string, versionId: string | null) => locateAccessVersionPath("w", path, versionId!, adapter) };
  for (const path of ["Pictures/photo.png", "Pictures"]) {
    expect(await resolveAccessObject(workspace, { kind: "path", path, versionId: version.id }, ports)).toMatchObject({ visibility: "visible" });
  }
  expect(await resolveAccessObject(workspace, { kind: "path", path: "Pictures/missing.png", versionId: version.id }, ports)).toMatchObject({ visibility: "missing" });
  for (const path of ["Pictures/", "./Pictures/photo.png", "../Pictures", "", "pictures", "Empty"]) {
    expect(await locateAccessVersionPath("w", path, version.id, adapter)).toEqual({ path, exists: false });
  }
  expect(await locateAccessVersionPath("w", "Pictures", "main", adapter)).toEqual({ path: "Pictures", exists: false });
  const shared = { ...workspace, shareView: { shareId: "s", granterEmail: "owner@example.com", genericChatWritable: false,
    grantedSelector: { versionId: version.id, paths: ["Allowed"], access: "view" } } } as RegistryEntry;
  expect(await resolveAccessObject(shared, { kind: "path", path: "Pictures/photo.png", versionId: version.id }, ports))
    .toMatchObject({ visibility: "hidden" });
  expect(wholeListing).not.toHaveBeenCalled();
  expect(page.mock.calls.every(([input]) => input.limit === 1)).toBe(true);
  expect(resolve).toHaveBeenCalledWith({ workspaceId: "w", versionId: version.id, targets: [{ path: "Pictures/photo.png" }] });
});
it("bounds chat resolution to 100 wire lookups and does not claim absence beyond its page", async () => {
  const store = { listChannelsPage: vi.fn(async () => ({ channels: Array.from({ length: 100 }, (_, n) => ({ id: `local-${n}` })), nextCursor: "more" }) as never),
    getChannelWireId: vi.fn(async (_input: { workspaceId: string; channelId: string }) => "other-wire") };
  await expect(hasAccessChat("w", "not-in-page", store)).rejects.toThrow("more than one page");
  expect(store.listChannelsPage).toHaveBeenCalledExactlyOnceWith({ workspaceId: "w", limit: 100 });
  expect(store.getChannelWireId).toHaveBeenCalledTimes(100);
  store.getChannelWireId.mockImplementation(async input => input.channelId === "local-99" ? "origin-wire" : "other-wire");
  expect(await hasAccessChat("w", "origin-wire", store)).toBe(true);
});
it("labels a chat outside the bounded page unknown through the owner instead of missing", async () => {
  const { createAccessOwner } = await import("./accessOwner");
  const workspace = { workspaceId: "w", rootPath: "/w" } as RegistryEntry;
  const store = { listChannelsPage: async () => ({ channels: [], nextCursor: "more" }), getChannelWireId: async () => null };
  const owner = createAccessOwner({ resolve: (_w: string, ref) => resolveAccessObject(workspace, ref, {
    filePathForObjectId: async () => null, locatePath: async () => null, hasChat: wire => hasAccessChat("w", wire, store) }),
    account: () => null, scope: () => "scope", assertCurrent: () => undefined, refresh: async () => ({ status: "requested" }),
    roster: () => ({ listing: null, checkedAtMs: null, freshness: "unknown" }), received: () => ({ inventory: null, checkedAtMs: null, freshness: "unknown" }),
    permissions: async () => { throw Error("unused"); } });
  expect(await owner.object("w", { ref: { kind: "chat", channelWireId: "unvisited" } })).toMatchObject({ freshness: "unknown", visibility: "unknown", coverage: { complete: false } });
});

it("resolves an Access file through its own workspace and operation signal with the returned version", async () => {
  const workspace = { workspaceId: "owned-workspace" };
  const objectId = "file-object";
  const signal = new AbortController().signal;
  const resolveFiles = vi.fn<VersionedLiveAdapter["resolveFiles"]>().mockResolvedValue({
    versionId: "engine-draft", results: [{ status: "found", objectId, path: "Documents/file.md" }],
  });
  expect(await resolveAccessFileObject(workspace, objectId, work => work({ resolveFiles }), signal))
    .toEqual({ path: "Documents/file.md", versionId: "engine-draft" });
  expect(resolveFiles).toHaveBeenCalledExactlyOnceWith({ workspaceId: workspace.workspaceId, targets: [{ objectId }], signal });
  expect(resolveFiles.mock.calls[0]?.[0].signal).toBe(signal);
});

it.each(["absent", "invalid"] as const)("maps an %s Access file resolution to null", async status => {
  const resolveFiles = vi.fn<VersionedLiveAdapter["resolveFiles"]>().mockResolvedValue({
    versionId: "engine-draft", results: [{ status }],
  });
  expect(await resolveAccessFileObject({ workspaceId: "owned-workspace" }, "file-object",
    work => work({ resolveFiles }), new AbortController().signal)).toBeNull();
});

it("reports unavailable file aliases when the Access adapter is unavailable", async () => {
  await expect(resolveAccessFileObject({ workspaceId: "owned-workspace" }, "file-object",
    async () => null, new AbortController().signal)).rejects.toThrow("File aliases are unavailable.");
});
