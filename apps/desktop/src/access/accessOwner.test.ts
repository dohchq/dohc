import { expect, it, vi } from "vitest";
import { createAccessAcquisition, createAccessOwner } from "./accessOwner";
import { unknownAccess } from "./accessQuery";
import { hasAccessChat, resolveAccessObject } from "./accessObjectResolution";
import { deferred } from "../testing/deferred";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { AccessObjectRef } from "@dohc/workspace-contracts/access";

const datasetId = "00000000-0000-4000-8000-000000000001", operationId = "00000000-0000-4000-8000-000000000002";
const path = { kind: "path" as const, path: "Notes/a.md", versionId: null };
function harness() {
  let scope = "one";
  const resolve = vi.fn(async (_workspace: string, ref: AccessObjectRef) => ({ ref, visibility: "visible" as const }));
  const permissions = vi.fn(async () => ({ permissions: [{ kind: "data", principal: "recipient", current: true,
    metadata: { revision: 1, revisionSha256: "a".repeat(64), operationIds: [operationId], discover: true } }], nextCursor: null }));
  const refresh = vi.fn(async () => undefined);
  const owner = createAccessOwner({ resolve, permissions, refresh, account: () => ({ userId: "recipient", relayUrl: "relay" }),
    roster: () => ({ listing: null, checkedAtMs: null, freshness: "unknown" }),
    received: () => ({ inventory: null, checkedAtMs: null, freshness: "unknown" }),
    scope: () => scope, assertCurrent: () => undefined, nowMs: () => 42 });
  return { owner, permissions, resolve, refresh, change: () => { scope = "two"; } };
}
it("reads live Collection capabilities without turning them into file grants", async () => {
  const h = harness(); const ref = { kind: "collection" as const, datasetId };
  expect(await h.owner.object("w", { ref })).toMatchObject({ ref, checkedAtMs: 42, freshness: "fresh", coverage: { kind: "collection" },
    rows: [{ kind: "collection", principal: "recipient", appId: null, operationIds: [operationId], compatible: true }] });
  expect(h.refresh).not.toHaveBeenCalled();
});
it("returns unknown when Collection authority is offline or denies inspection", async () => {
  const h = harness(); h.permissions.mockRejectedValue(Error("offline"));
  expect(await h.owner.object("w", { ref: { kind: "collection", datasetId } })).toMatchObject({ freshness: "unknown", rows: [], coverage: { complete: false } });
});
it("rejects a Collection answer superseded by an account switch", async () => {
  const h = harness(), waiting = deferred<Awaited<ReturnType<typeof h.permissions>>>();
  h.permissions.mockReturnValue(waiting.promise);
  const pending = h.owner.object("w", { ref: { kind: "collection", datasetId } });
  await vi.waitFor(() => expect(h.permissions).toHaveBeenCalledOnce());
  h.change(); waiting.resolve({ permissions: [], nextCursor: null });
  expect(await pending).toMatchObject({ freshness: "unknown", rows: [] });
});
it("binds Collection cursors to the object and workspace/account scope", async () => {
  const h = harness(); h.permissions.mockResolvedValue({ permissions: [], nextCursor: "data:recipient" } as never);
  const first = await h.owner.object("w", { ref: { kind: "collection", datasetId } });
  await h.owner.object("w", { ref: { kind: "collection", datasetId }, cursor: first.nextCursor! });
  expect(h.permissions).toHaveBeenLastCalledWith("w", datasetId, "data:recipient");
  h.change();
  expect(await h.owner.object("w", { ref: { kind: "collection", datasetId }, cursor: first.nextCursor! })).toMatchObject({ freshness: "unknown" });
  expect(h.permissions).toHaveBeenCalledTimes(2);
});
it("coalesces one surface acquisition feeding both existing paced owners", async () => {
  const waiting = deferred<void>(), roster = vi.fn(() => waiting.promise), received = vi.fn(() => waiting.promise);
  const acquisition = createAccessAcquisition({ roster, received, context: () => "scope" });
  const first = acquisition.request("w"), second = acquisition.request("w");
  expect(first).toBe(second); expect(roster).toHaveBeenCalledExactlyOnceWith("w"); expect(received).toHaveBeenCalledOnce();
  waiting.resolve(); await first;
});
it("resolves current aliases after rename and reports missing objects", async () => {
  const workspace = { workspaceId: "w", rootPath: "/w" } as RegistryEntry;
  const file = vi.fn(async () => ({ path: "Notes/renamed.md", versionId: "main" }));
  const ports = { filePathForObjectId: file, locatePath: async (path: string) => ({ path, exists: true }), hasChat: async () => false };
  expect(await resolveAccessObject(workspace, { kind: "file", objectId: "stable" }, ports)).toMatchObject({ ref: { path: "Notes/renamed.md" }, visibility: "visible" });
  file.mockResolvedValue(null as never);
  expect(await resolveAccessObject(workspace, { kind: "file", objectId: "stable" }, ports)).toMatchObject({ visibility: "missing" });
});
it("resolves mount coordinates to the source share and version, never the host's grants", async () => {
  const workspace = { workspaceId: "w", rootPath: "/w", shareMounts: [{ shareId: "received", label: "friend", relayUrl: "relay",
    granterEmail: null, grantedSelector: { paths: ["Notes"], versionId: "snapshot", access: "view" } }] } as RegistryEntry;
  const ref = { ...path, path: "shared-with-me/friend/Notes/a.md" };
  const ports = { filePathForObjectId: async () => null, locatePath: async (path: string) => ({ path, exists: true }), hasChat: async () => false };
  expect(await resolveAccessObject(workspace, ref, ports)).toMatchObject({ ref: { path: "Notes/a.md", versionId: "snapshot" }, shareId: "received", relayUrl: "relay" });
  expect(await resolveAccessObject(workspace, { ...path, path: "shared-with-me/friend" }, ports)).toMatchObject({ shareRoot: true, shareId: "received", visibility: "visible" });
  expect(await resolveAccessObject(workspace, { ...path, path: "Notes/.env" }, ports)).toMatchObject({ visibility: "hidden" });
});
it("keeps empty unknown answers distinct from a complete absence observation", () => {
  expect(unknownAccess(path)).toMatchObject({ rows: [], checkedAtMs: null, coverage: { complete: false }, freshness: "unknown" });
});
it("labels failed physical resolution unknown instead of claiming absence", async () => {
  const h = harness(); h.resolve.mockRejectedValue(Error("damaged mount record"));
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ visibility: "unknown", freshness: "unknown", coverage: { complete: false } });
});
it("labels unavailable file aliases unknown rather than missing", async () => {
  const h = harness(); h.resolve.mockRejectedValue(Error("File aliases are unavailable."));
  expect(await h.owner.object("w", { ref: { kind: "file", objectId: "stable" } }))
    .toMatchObject({ visibility: "unknown", freshness: "unknown", coverage: { complete: false } });
});
it("withholds received projection paths outside the pinned selector", async () => {
  const workspace = { workspaceId: "w", rootPath: "/w", shareView: { shareId: "received", relayUrl: "relay", recipientUserId: "recipient",
    grantedSelector: { paths: ["Notes"], versionId: null, access: "view" } } } as RegistryEntry;
  const ports = { filePathForObjectId: async () => null, locatePath: async (path: string) => ({ path, exists: true }), hasChat: async () => false };
  expect(await resolveAccessObject(workspace, { ...path, path: "Private/a.md" }, ports)).toMatchObject({ visibility: "hidden" });
});
it("resolves channel wire identities independently of the store's local ids", async () => {
  const store = { listChannels: vi.fn(async () => [{ id: "local-uuid" }] as never),
    getChannelWireId: vi.fn(async () => "origin-wire-id") };
  expect(await hasAccessChat("w", "origin-wire-id", store)).toBe(true);
  expect(store.getChannelWireId).toHaveBeenCalledWith({ workspaceId: "w", channelId: "local-uuid" });
  expect(await hasAccessChat("w", "local-uuid", store)).toBe(false);
});
