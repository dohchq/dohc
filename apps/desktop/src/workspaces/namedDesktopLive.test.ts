import * as Y from "yjs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createNamedDesktopLiveCapture } from "./namedDesktopLive";
import { preserveNamedLiveDraft } from "./namedLiveDraftRecovery";

const transport = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("@dohc/ydoc-projection/named-live-browser-transport", async importOriginal => {
  const actual = await importOriginal<typeof import("@dohc/ydoc-projection/named-live-browser-transport")>();
  return {...actual, createNamedLiveBrowserTransport: transport.factory};
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.clearAllMocks(); });

function fixture() {
  const doc = new Y.Doc();
  cleanup.push(async () => doc.destroy());
  let current = true, status = "disconnected", pendingUpdates = 0;
  const listeners = new Set<(value: ReturnType<typeof state>) => void>();
  function state() { return {status, pendingUpdates, binding: null}; }
  function notify() { for (const listener of listeners) listener(state()); }
  const closed = vi.fn();
  const session = {doc, state, subscribe(fn: (value: ReturnType<typeof state>) => void) {listeners.add(fn); return () => listeners.delete(fn);},
    async reconnect() {status = "live"; notify();}, disconnect() {status = "disconnected"; notify();},
    edit(change: () => void) {pendingUpdates++; doc.transact(change); notify(); return true;}, close: closed};
  transport.factory.mockImplementation(() => ({select: () => session, close: closed}));
  const frames = {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
    maxQueuedBytes: 4096, maxQueuedFrames: 16, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096};
  const request = vi.fn<typeof fetch>(async (_url, options) => {
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer real-account-token");
    expect(new Headers(options?.headers).has("cookie")).toBe(false);
    expect(JSON.parse(String(options?.body))).toEqual({shareId: "share", path: "docs/a.md"});
    return Response.json({kind: "named", userId: "reader", workspaceId: "remote-workspace", shareId: "share", grantId: "grant",
      path: "docs/a.md", objectId: "object", discriminator: "abcdefghijkl", expiresAtMs: Date.now() + 60000,
      ticket: {token: "a".repeat(64), expiresAtMs: Date.now() + 60000},
      editorLimits: {provider: {frames, maxPendingUpdateBytes: 4096, maxPendingUpdates: 4, maxDeliveryAttempts: 2},
        maxHttpResponseBytes: 4096, maxSocketBufferedBytes: 4096, connectTimeoutMs: 1000, sendTimeoutMs: 1000, drainPollMs: 10}});
  });
  const preserveDraft = vi.fn(async () => {});
  const capture = createNamedDesktopLiveCapture({shareId: "share", selector: {access: "edit", versionId: null, paths: ["docs"]},
    credentials: {relayUrl: "https://relay.test", token: "real-account-token", userId: "reader", signal: new AbortController().signal},
    assertCurrent() {if (!current) throw new Error("switched");}, fetch: request, preserveDraft});
  return {capture, request, closed, preserveDraft, session, switchWorkspace() {current = false;},
    quarantineEdit(change: () => void) {doc.transact(change); status = "quarantined"; notify(); return false;},
    ack() {pendingUpdates = 0; notify();}};
}

it("reports only host acknowledgement as saved and never settles a local file", async () => {
  const f = fixture(), onSaveState = vi.fn();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn(), onSaveState});
  const edit = new Y.Doc(); edit.getText("body").insert(0, "pending");
  provider.applyLocalUpdate(Y.encodeStateAsUpdate(edit)); edit.destroy();
  expect(onSaveState).toHaveBeenLastCalledWith("settling", 1);
  f.ack();
  expect(onSaveState).toHaveBeenLastCalledWith("saved", 1);
  await provider.close();
  expect(f.preserveDraft).not.toHaveBeenCalled();
});

it("preserves exact pending state before close and retains the provider if storage fails", async () => {
  const f = fixture();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()});
  const edit = new Y.Doc(); edit.getText("body").insert(0, "unsent work");
  provider.applyLocalUpdate(Y.encodeStateAsUpdate(edit)); edit.destroy();
  const exact = Y.encodeStateAsUpdate(provider.doc);
  f.preserveDraft.mockRejectedValueOnce(new Error("disk full"));
  await expect(provider.close()).rejects.toThrow("disk full");
  expect(f.closed).not.toHaveBeenCalled();
  expect(Y.encodeStateAsUpdate(provider.doc)).toEqual(exact);
  await provider.close();
  expect(f.preserveDraft).toHaveBeenLastCalledWith({path: "docs/a.md", objectId: "object", remoteWorkspaceId: "remote-workspace", update: exact});
  expect(f.closed).toHaveBeenCalledOnce();
});

it("rejects a workspace switch and pinned-selector escape before editing", async () => {
  const f = fixture();
  await expect(f.capture.openYDocSession({path: "other/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()})).rejects.toThrow("outside this view");
  expect(f.request).not.toHaveBeenCalled();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()});
  f.switchWorkspace();
  expect(provider.liveWritable?.()).toBe(false);
  expect(() => provider.applyLocalUpdate(new Uint8Array([0, 0]))).toThrow("switched");
  expect(f.session.state().pendingUpdates).toBe(0);
  await provider.close();
});

it("retains an edit quarantined before queue admission across failed recovery and retry", async () => {
  const f = fixture();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()});
  f.session.edit = f.quarantineEdit;
  const edit = new Y.Doc(); edit.getText("body").insert(0, "larger than the pending budget");
  provider.applyLocalUpdate(Y.encodeStateAsUpdate(edit)); edit.destroy();
  expect(f.session.state().pendingUpdates).toBe(0);
  const exact = Y.encodeStateAsUpdate(provider.doc);
  f.preserveDraft.mockRejectedValueOnce(new Error("disk full"));
  await expect(provider.close()).rejects.toThrow("disk full");
  expect(f.closed).not.toHaveBeenCalled();
  expect(Y.encodeStateAsUpdate(provider.doc)).toEqual(exact);
  await provider.close();
  expect(f.preserveDraft).toHaveBeenLastCalledWith({path: "docs/a.md", objectId: "object", remoteWorkspaceId: "remote-workspace", update: exact});
  expect(f.closed).toHaveBeenCalledOnce();
});

it("writes exact recovery under its original local workspace without admitting secret paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-named-recovery-"));
  cleanup.push(() => rm(directory, {recursive: true, force: true}));
  const draft = {path: "docs/a.md", objectId: "object", remoteWorkspaceId: "owner-workspace", update: new Uint8Array([0, 0])};
  await preserveNamedLiveDraft(directory, "recipient-workspace", draft);
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  const row = JSON.parse(await readFile(join(directory, names[0]!), "utf8"));
  expect(row.workspaceId).toBe("recipient-workspace");
  expect(Buffer.from(row.updateBase64, "base64")).toEqual(Buffer.from(draft.update));
  await expect(preserveNamedLiveDraft(directory, "other-workspace", {...draft, path: ".env"})).rejects.toThrow("cannot enter draft recovery");
  expect(await readdir(directory)).toEqual(names);
});
