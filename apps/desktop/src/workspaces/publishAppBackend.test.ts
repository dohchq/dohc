import { expect, it, vi } from "vitest";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { activatePublishedAppBackend } from "./publishAppBackend";

const capability = { kind: "app-backend" as const, dataPath: "data.sqlite", backendPath: "backend.js", schemaPath: "schema.sql", backendSha256: "a".repeat(64), schemaSha256: "b".repeat(64),
  schemaVersion: 1, operations: [{ name: "list", access: "owner" as const, readOnly: true }], tables: [] };
const candidate: Pick<AppPublicationCandidate, "appRoot" | "capabilities"> = { appRoot: "app", capabilities: [capability] };
const selection = { publicationId: "c".repeat(64), authorityRevision: 1, candidate, initialize: true };
function harness() {
  const bundle = { formatVersion: 1, snapshot: { revision: 3 } };
  const existing = { publicationId: "d".repeat(64), authorityRevision: 2, appRoot: "app", sourceRevision: "e".repeat(64), capability, active: true, revision: 3, sharedPublicationId: null as string | null, sharedTransferConfirmed: false };
  const local = { findByDataPath: vi.fn(() => existing as typeof existing | null), transfer: vi.fn(() => bundle as never), advanceSharedAuthority: vi.fn() };
  const reply = (publicationId = selection.publicationId, initialized = false, action = "restore") => ({ publicationId, authorityRevision: 1, revision: 3, ...(action === "describe" ? { initialized } : {}) });
  const request = vi.fn(async (action: string, _body: unknown) => reply(selection.publicationId, false, action));
  return { local, request, existing, bundle, reply, signal: new AbortController().signal };
}
it("transfers local data before shared restore without initializing an empty database", async () => {
  const h = harness();
  await activatePublishedAppBackend(selection, h.local, h.request, h.signal);
  expect(h.local.transfer).toHaveBeenCalledWith("data.sqlite", selection.publicationId, undefined);
  expect(h.request).toHaveBeenCalledExactlyOnceWith("restore", { authorityRevision: 1, bundle: h.bundle });
  expect(h.local.transfer.mock.invocationCallOrder[0]).toBeLessThan(h.request.mock.invocationCallOrder[0]!);
});
it("retries the same transfer and never falls back to empty activation on failure", async () => {
  const h = harness(); h.existing.sharedPublicationId = selection.publicationId;
  h.request.mockRejectedValueOnce(new Error("connection ended"));
  await expect(activatePublishedAppBackend(selection, h.local, h.request, h.signal)).rejects.toThrow("connection ended");
  await activatePublishedAppBackend(selection, h.local, h.request, h.signal);
  expect(h.request.mock.calls.map(([action]) => action)).toEqual(["describe", "describe", "restore"]);
});
it("does not freeze local data when the approved backend source differs", async () => {
  const h = harness();
  const changed = { ...candidate, capabilities: [{ ...capability, backendSha256: "f".repeat(64) }] };
  await expect(activatePublishedAppBackend({ ...selection, candidate: changed }, h.local, h.request, h.signal)).rejects.toThrow(/does not match/);
  expect(h.local.transfer).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
});
it("initializes only apps without local data and preserves explicit recovery preparation", async () => {
  const h = harness(); h.local.findByDataPath.mockReturnValue(null);
  await activatePublishedAppBackend(selection, h.local, h.request, h.signal);
  expect(h.request).toHaveBeenCalledExactlyOnceWith("activate", { authorityRevision: 1 });
  h.request.mockClear();
  await activatePublishedAppBackend({ ...selection, initialize: false }, h.local, h.request, h.signal);
  expect(h.request).not.toHaveBeenCalled();
});
it("advances a shared publication mapping only after activation succeeds", async () => {
  const h = harness(); h.existing.sharedPublicationId = "e".repeat(64);
  h.request.mockImplementation(async action => h.reply(selection.publicationId, true, action));
  h.request.mockRejectedValueOnce(new Error("offline"));
  await expect(activatePublishedAppBackend(selection, h.local, h.request, h.signal)).rejects.toThrow("offline");
  expect(h.local.advanceSharedAuthority).not.toHaveBeenCalled();
  await activatePublishedAppBackend(selection, h.local, h.request, h.signal);
  expect(h.local.advanceSharedAuthority).toHaveBeenCalledWith("data.sqlite", "e".repeat(64), selection.publicationId);
  expect(h.local.transfer).not.toHaveBeenCalled();
});
it("does not confirm an activation response for a different publication", async () => {
  const h = harness(); h.local.findByDataPath.mockReturnValue(null);
  h.request.mockResolvedValueOnce(h.reply("f".repeat(64)));
  await expect(activatePublishedAppBackend(selection, h.local, h.request, h.signal)).rejects.toThrow(/activation changed/);
});
it("retries a lost initial transfer into a new publication instead of initializing empty data", async () => {
  const h = harness();
  h.local.transfer.mockImplementation(() => { h.existing.sharedPublicationId = selection.publicationId; return h.bundle as never; });
  h.request.mockRejectedValueOnce(new Error("restore never reached host"));
  await expect(activatePublishedAppBackend(selection, h.local, h.request, h.signal)).rejects.toThrow(/never reached/);
  expect(h.local.advanceSharedAuthority).not.toHaveBeenCalled();
  const next = { ...selection, publicationId: "f".repeat(64) };
  h.request.mockImplementation(async action => h.reply(next.publicationId, false, action));
  await activatePublishedAppBackend(next, h.local, h.request, h.signal);
  expect(h.request.mock.calls.map(([action]) => action)).toEqual(["restore", "describe", "restore"]);
  expect(h.local.transfer).toHaveBeenLastCalledWith("data.sqlite", next.publicationId, selection.publicationId);
  expect(h.local.advanceSharedAuthority).toHaveBeenCalledWith("data.sqlite", next.publicationId, next.publicationId);
});
it("never restores a stale local snapshot after confirmed shared data goes missing", async () => {
  const h = harness(); h.existing.sharedPublicationId = "e".repeat(64); h.existing.sharedTransferConfirmed = true;
  await expect(activatePublishedAppBackend(selection, h.local, h.request, h.signal)).rejects.toThrow(/current shared recovery/);
  expect(h.local.transfer).not.toHaveBeenCalled();
  expect(h.request.mock.calls.map(([action]) => action)).toEqual(["describe"]);
});
it("refuses a new backend source while an initial transfer is unfinished", async () => {
  const h = harness(); h.existing.sharedPublicationId = "e".repeat(64);
  const changed = { ...candidate, capabilities: [{ ...capability, backendSha256: "f".repeat(64) }] };
  await expect(activatePublishedAppBackend({ ...selection, candidate: changed }, h.local, h.request, h.signal)).rejects.toThrow(/matching backend source/);
  expect(h.local.transfer).not.toHaveBeenCalled();
  expect(h.request.mock.calls.map(([action]) => action)).toEqual(["describe"]);
});
