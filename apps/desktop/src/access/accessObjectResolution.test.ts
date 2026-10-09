import { expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { hasAccessChat, locateAccessVersionPath, resolveAccessObject } from "./accessObjectResolution";
import type { RegistryEntry } from "../workspaces/registryStore";

it("resolves binary files and binary-only folders in a non-main version through metadata", async () => {
  const engine = new VersionedLoopbackEngine();
  const workspace = { workspaceId: "w", rootPath: "/w" } as RegistryEntry;
  const adapter = new VersionedLiveAdapter({ sendRequest: request => engine.sendRequest(request), close() {} }, "w", { workspaceId: "w" });
  await adapter.ensureMainVersion({ workspaceId: "w" });
  const version = await adapter.createNamedVersion({ workspaceId: "w", name: "draft", fromVersionId: "main" });
  await adapter.setActiveVersion({ workspaceId: "w", versionId: version.id });
  await adapter.writeBinaryFile({ workspaceId: "w", versionId: version.id, path: "Pictures/photo.png",
    bytes: new Uint8Array([137, 80, 78, 71]), metadata: { origin: "api" } });
  const ports = { filePathForObjectId: async () => null, hasChat: async () => false,
    locatePath: (path: string, versionId: string | null) => locateAccessVersionPath("w", path, versionId!, adapter) };
  for (const path of ["Pictures/photo.png", "Pictures"]) {
    expect(await resolveAccessObject(workspace, { kind: "path", path, versionId: version.id }, ports)).toMatchObject({ visibility: "visible" });
  }
  expect(await resolveAccessObject(workspace, { kind: "path", path: "Pictures/missing.png", versionId: version.id }, ports)).toMatchObject({ visibility: "missing" });
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
    account: () => null, scope: () => "scope", assertCurrent: () => undefined, refresh: async () => undefined,
    roster: () => ({ listing: null, checkedAtMs: null, freshness: "unknown" }), received: () => ({ inventory: null, checkedAtMs: null, freshness: "unknown" }),
    permissions: async () => { throw Error("unused"); } });
  expect(await owner.object("w", { ref: { kind: "chat", channelWireId: "unvisited" } })).toMatchObject({ freshness: "unknown", visibility: "unknown", coverage: { complete: false } });
});
