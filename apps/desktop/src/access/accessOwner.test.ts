import { expect, it, vi } from "vitest";
import { accessCliQueries, createAccessAcquisition, createAccessOwner, type ResolvedAccessObject } from "./accessOwner";
import { unknownAccess } from "./accessQuery";
import { hasAccessChat, resolveAccessObject } from "./accessObjectResolution";
import { deferred } from "../testing/deferred";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { AccessObjectRef } from "@dohc/workspace-contracts/access";
import { parseReceivedInventory, type ReceivedObservation } from "../workspaces/receivedShareStore";

const datasetId = "00000000-0000-4000-8000-000000000001", operationId = "00000000-0000-4000-8000-000000000002";
const path = { kind: "path" as const, path: "Notes/a.md", versionId: null };
function harness() {
  let scope = "one";
  let generation = 1;
  let signedIn = true;
  const resolve = vi.fn(async (_workspace: string, ref: AccessObjectRef): Promise<ResolvedAccessObject> => ({ ref, visibility: "visible" }));
  const permissions = vi.fn(async () => ({ permissions: [{ kind: "data", principal: "recipient", current: true,
    metadata: { revision: 1, revisionSha256: "a".repeat(64), operationIds: [operationId], discover: true } }], nextCursor: null }));
  const refresh = vi.fn(async (): Promise<void> => undefined);
  const received = vi.fn((): ReceivedObservation => ({ inventory: null, checkedAtMs: null, freshness: "unknown" }));
  const scopePort = vi.fn(() => scope);
  const owner = createAccessOwner({ resolve, permissions, refresh, account: () => signedIn ? ({ userId: "recipient", email: "recipient@test.dev", relayUrl: "https://relay.test", generation }) : null,
    roster: () => ({ listing: null, checkedAtMs: null, freshness: "unknown" }),
    received, scope: scopePort, assertCurrent: () => undefined, nowMs: () => 42 });
  return { signOut: () => { signedIn = false; }, owner, permissions, resolve, refresh, received, scopePort, change: () => { scope = "two"; generation++; } };
}
it("reads live Collection capabilities without turning them into file grants", async () => {
  const h = harness(); const ref = { kind: "collection" as const, datasetId };
  expect(await h.owner.object("w", { ref })).toMatchObject({ ref, checkedAtMs: 42, freshness: "fresh", coverage: { kind: "collection" },
    rows: [{ kind: "collection", principal: "recipient", appId: null, operationIds: [operationId], compatible: true }] });
  expect(h.refresh).not.toHaveBeenCalled();
});
it("returns unknown when Collection authority is offline or denies inspection", async () => {
  const h = harness(); h.permissions.mockRejectedValue(Error("offline"));
  expect(await h.owner.object("w", { ref: { kind: "collection", datasetId } })).toMatchObject({ freshness: "unknown", rows: [], coverage: { complete: false }, unknownReason: "unreadable" });
});
it("rejects a Collection answer superseded by an account switch", async () => {
  const h = harness(), waiting = deferred<Awaited<ReturnType<typeof h.permissions>>>();
  h.permissions.mockReturnValue(waiting.promise);
  const pending = h.owner.object("w", { ref: { kind: "collection", datasetId } });
  await vi.waitFor(() => expect(h.permissions).toHaveBeenCalledOnce());
  h.change(); waiting.resolve({ permissions: [], nextCursor: null });
  expect(await pending).toMatchObject({ freshness: "unknown", unknownReason: "changed", rows: [] });
});
it("binds Collection cursors to the object and workspace/account scope", async () => {
  const h = harness(); h.permissions.mockResolvedValue({ permissions: [], nextCursor: "data:recipient" } as never);
  const first = await h.owner.object("w", { ref: { kind: "collection", datasetId } });
  await h.owner.object("w", { ref: { kind: "collection", datasetId }, cursor: first.nextCursor! });
  expect(h.permissions).toHaveBeenLastCalledWith("w", datasetId, "data:recipient");
  h.change();
  expect(await h.owner.object("w", { ref: { kind: "collection", datasetId }, cursor: first.nextCursor! })).toMatchObject({ freshness: "unknown", unknownReason: "changed" });
  expect(h.permissions).toHaveBeenCalledTimes(2);
});
it("passes concurrent surface requests to the existing coalescing owners", async () => {
  const waiting = deferred<void>(), roster = vi.fn(() => waiting.promise), received = vi.fn(() => waiting.promise);
  const acquisition = createAccessAcquisition({ roster, received });
  const first = acquisition.request("w"), second = acquisition.request("w");
  expect(roster).toHaveBeenCalledTimes(2); expect(received).toHaveBeenCalledTimes(2);
  waiting.resolve(); await Promise.all([first, second]);
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
  const workspace = { workspaceId: "w", rootPath: "/w", shareMounts: [{ shareId: "received", label: "friend", relayUrl: "https://relay.test",
    granterEmail: null, recipientEmail: "recipient@test.dev", grantedSelector: { paths: ["Notes"], versionId: "snapshot", access: "view" } }] } as RegistryEntry;
  const ref = { ...path, path: "shared-with-me/friend/Notes/a.md" };
  const ports = { filePathForObjectId: async () => null, locatePath: async (path: string) => ({ path, exists: true }), hasChat: async () => false };
  expect(await resolveAccessObject(workspace, ref, ports)).toMatchObject({ ref: { path: "Notes/a.md", versionId: "snapshot" }, shareId: "received", relayUrl: "https://relay.test", recipientEmail: "recipient@test.dev" });
  expect(await resolveAccessObject(workspace, { ...path, path: "shared-with-me/friend" }, ports)).toMatchObject({ shareRoot: true, shareId: "received", visibility: "visible" });
  expect(await resolveAccessObject(workspace, { ...path, path: "Notes/.env" }, ports)).toMatchObject({ visibility: "hidden" });
});
it("keeps empty unknown answers distinct from a complete absence observation", () => {
  expect(unknownAccess(path, "not-listed-yet")).toMatchObject({ rows: [], checkedAtMs: null, coverage: { complete: false }, freshness: "unknown" });
});
it("labels failed physical resolution unknown instead of claiming absence", async () => {
  const h = harness(); h.resolve.mockRejectedValue(Error("damaged mount record"));
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ visibility: "unknown", freshness: "unknown", unknownReason: "unreadable", coverage: { complete: false } });
});
it("labels unavailable file aliases unknown rather than missing", async () => {
  const h = harness(); h.resolve.mockRejectedValue(Error("File aliases are unavailable."));
  expect(await h.owner.object("w", { ref: { kind: "file", objectId: "stable" } }))
    .toMatchObject({ visibility: "unknown", freshness: "unknown", unknownReason: "unreadable", coverage: { complete: false } });
});
it("withholds received projection paths outside the pinned selector", async () => {
  const workspace = { workspaceId: "w", rootPath: "/w", shareView: { shareId: "received", relayUrl: "https://relay.test", recipientUserId: "recipient",
    grantedSelector: { paths: ["Notes"], versionId: null, access: "view" } } } as RegistryEntry;
  const ports = { filePathForObjectId: async () => null, locatePath: async (path: string) => ({ path, exists: true }), hasChat: async () => false };
  expect(await resolveAccessObject(workspace, { ...path, path: "Private/a.md" }, ports)).toMatchObject({ visibility: "hidden" });
});
it("resolves channel wire identities independently of the store's local ids", async () => {
  const store = { listChannelsPage: vi.fn(async () => ({ channels: [{ id: "local-uuid" }], nextCursor: null }) as never),
    getChannelWireId: vi.fn(async () => "origin-wire-id") };
  expect(await hasAccessChat("w", "origin-wire-id", store)).toBe(true);
  expect(store.getChannelWireId).toHaveBeenCalledWith({ workspaceId: "w", channelId: "local-uuid" });
  expect(await hasAccessChat("w", "local-uuid", store)).toBe(false);
});
it.each([undefined, null, "other@test.dev"])("returns unknown for a mount account pin %s", async recipientEmail => {
  const h = harness();
  const workspace = { workspaceId: "w", rootPath: "/w", shareMounts: [{ shareId: "received", label: "friend", relayUrl: "https://relay.test",
    granterEmail: null, recipientEmail, grantedSelector: { paths: ["Notes"], versionId: null, access: "view" } }] } as RegistryEntry;
  const ports = { filePathForObjectId: async () => null, locatePath: async (path: string) => ({ path, exists: true }), hasChat: async () => false };
  h.resolve.mockImplementation((_w, ref) => resolveAccessObject(workspace, ref, ports));
  for (const path of ["shared-with-me/friend", "shared-with-me/friend/Notes/a.md"]) {
    expect(await h.owner.object("w", { ref: { kind: "path", path, versionId: null } })).toMatchObject({ freshness: "unknown", unknownReason: recipientEmail ? "other-account" : "unreadable", coverage: { complete: false }, rows: [] });
  }
  expect(h.received).not.toHaveBeenCalled();
});
it.each([undefined, "another-account"])("returns unknown for a share-view account pin %s", async recipientUserId => {
  const h = harness();
  h.resolve.mockResolvedValue({ ref: path, visibility: "visible", shareId: "received", relayUrl: "https://relay.test", recipientUserId });
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ freshness: "unknown", unknownReason: recipientUserId ? "other-account" : "unreadable", coverage: { complete: false }, rows: [] });
  expect(h.received).not.toHaveBeenCalled();
});
it("answers only the pinned recipient's own share for a matching mount account", async () => {
  const h = harness();
  const inventory = parseReceivedInventory({ received: [{ shareId: "received", grantId: "own", granterUserId: "owner", granterEmail: null,
    selector: { paths: ["Notes"], versionId: null }, access: "view", generation: 1, createdAtMs: 1, genericChatWritable: false }], removed: [] })!;
  h.received.mockReturnValue({ inventory, checkedAtMs: 42, freshness: "fresh" });
  h.resolve.mockResolvedValue({ ref: path, visibility: "visible", shareId: "received", relayUrl: "https://relay.test", recipientEmail: "RECIPIENT@test.dev" });
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ freshness: "fresh", coverage: { complete: true, kind: "received-own-grant" },
    rows: [{ shareId: "received", grantId: "own", recipientUserId: "recipient" }] });
});
it("uses one scope capture and rejects a credential generation change during resolution", async () => {
  const h = harness(), waiting = deferred<ResolvedAccessObject>();
  h.resolve.mockReturnValue(waiting.promise);
  const result = h.owner.object("w", { ref: path });
  h.change(); waiting.resolve({ ref: path, visibility: "visible" });
  expect(await result).toMatchObject({ freshness: "unknown", unknownReason: "changed" });
  expect(h.scopePort).toHaveBeenCalledOnce();
});
it("answers CLI object and Sharing reads from observations without waiting for refresh", async () => {
  const h = harness(), never = deferred<void>();
  h.refresh.mockReturnValue(never.promise);
  const cli = accessCliQueries(h.owner, work => Promise.resolve(work("w")));
  expect(await cli.object({ ref: path })).toMatchObject({ freshness: "unknown", checkedAtMs: null, unknownReason: "not-listed-yet" });
  expect(await cli.sharing({ lane: "received" })).toMatchObject({ freshness: "unknown", checkedAtMs: null, unknownReason: "not-listed-yet" });
  expect(h.refresh).not.toHaveBeenCalled();
});

it("reports a different received server without reading its inventory", async () => {
  const h = harness();
  h.resolve.mockResolvedValue({ ref: path, visibility: "visible", shareId: "received", relayUrl: "https://other-relay.test", recipientUserId: "recipient" });
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ unknownReason: "other-server", rows: [] });
  expect(h.received).not.toHaveBeenCalled();
});
it("reports signed-out for received objects and the received lane", async () => {
  const h = harness(); h.signOut();
  h.resolve.mockResolvedValue({ ref: path, visibility: "visible", shareId: "received", relayUrl: "https://relay.test", recipientUserId: "recipient" });
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ unknownReason: "signed-out", rows: [] });
  expect(h.owner.sharing("w", { lane: "received" })).toMatchObject({ unknownReason: "signed-out", rows: [] });
  expect(h.received).not.toHaveBeenCalled();
});
it("reports a pinned recipient's list has not arrived", async () => {
  const h = harness();
  h.resolve.mockResolvedValue({ ref: path, visibility: "visible", shareId: "received", relayUrl: "https://relay.test", recipientUserId: "recipient" });
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ unknownReason: "not-listed-yet", rows: [] });
  expect(h.received).toHaveBeenCalledOnce();
});
it.each(["https://relay.test", "https://relay.test/"])("answers a matching received relay %s", async relayUrl => {
  const h = harness();
  h.resolve.mockResolvedValue({ ref: path, visibility: "visible", shareId: "received", relayUrl, recipientUserId: "recipient" });
  h.received.mockReturnValue({ inventory: parseReceivedInventory({ received: [], removed: [] })!, checkedAtMs: 42, freshness: "fresh" });
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ unknownReason: null, coverage: { kind: "received-own-grant" } });
  expect(h.received).toHaveBeenCalledOnce();
});
it.each(["hidden", "missing", "unknown"] as const)("keeps %s in visibility", async visibility => {
  const h = harness(); h.resolve.mockResolvedValue({ ref: path, visibility });
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ visibility, unknownReason: "unreadable", rows: [] });
});

it("reports an unreadable received relay binding", async () => {
  const h = harness();
  h.resolve.mockResolvedValue({ ref: path, visibility: "visible", shareId: "received", recipientUserId: "recipient" });
  expect(await h.owner.object("w", { ref: path })).toMatchObject({ unknownReason: "unreadable", rows: [] });
  expect(h.received).not.toHaveBeenCalled();
});
