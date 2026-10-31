import {LIVE_CONNECTION_LIMIT_MESSAGES} from "@dohc/live-session-contract/live-connection";
import type { ShareRecordStatus } from "./shareRecordStatus";
import * as Y from "yjs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createNamedDesktopLiveCapture, waitForNamedDesktopAdmission } from "./namedDesktopLive";
import { LiveAuthorityUnavailableError, type NamedLiveSelection } from "@dohc/ydoc-projection/named-live-browser-transport";
import { preserveLiveDraft } from "./liveDraftRecovery";

const transport = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("@dohc/ydoc-projection/named-live-browser-transport", async importOriginal => {
  const actual = await importOriginal<typeof import("@dohc/ydoc-projection/named-live-browser-transport")>();
  return {...actual, createNamedLiveBrowserTransport: transport.factory};
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.clearAllMocks(); vi.useRealTimers(); });

function fixture(recordDelivery?: () => Promise<ShareRecordStatus | null>, isOnline = true) {
  const doc = new Y.Doc();
  cleanup.push(async () => doc.destroy());
  let ended = false;
  let current = true, status = "disconnected", pendingUpdates = 0, reason: string | null = null;
  const listeners = new Set<(value: ReturnType<typeof state>) => void>();
  function state() { return {status, pendingUpdates, binding: null, reason}; }
  function notify() { for (const listener of listeners) listener(state()); }
  const closed = vi.fn();
  const session = {doc, state, subscribe(fn: (value: ReturnType<typeof state>) => void) {listeners.add(fn); return () => listeners.delete(fn);},
    async reconnect() {status = "live"; notify();}, disconnect() {status = "disconnected"; notify();},
    edit(change: () => void) {pendingUpdates++; doc.transact(change); notify(); return true;}, close: closed};
  const select = vi.fn(() => session);
  transport.factory.mockImplementation(() => ({select, close: closed}));
  const frames = {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
    maxQueuedBytes: 4096, maxQueuedFrames: 16, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096};
  const request = vi.fn<typeof fetch>(async (_url, options) => {
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer real-account-token");
    expect(new Headers(options?.headers).has("cookie")).toBe(false);
    expect(JSON.parse(String(options?.body))).toEqual({shareId: "share", path: "docs/a.md"});
    return Response.json({kind: "named", userId: "reader", workspaceId: "named:grant", shareId: "share", grantId: "grant",
      path: "docs/a.md", objectId: "object", discriminator: "abcdefghijkl", expiresAtMs: Date.now() + 60000,
      ticket: {token: "a".repeat(64), expiresAtMs: Date.now() + 60000},
      editorLimits: {provider: {frames, maxPendingUpdateBytes: 4096, maxPendingUpdates: 4, maxDeliveryAttempts: 2},
        maxHttpResponseBytes: 4096, maxSocketBufferedBytes: 4096, connectTimeoutMs: 1000, sendTimeoutMs: 1000, drainPollMs: 10}});
  });
  const preserveDraft = vi.fn(async () => {});
  const capture = createNamedDesktopLiveCapture({shareId: "share", selector: {access: "edit", versionId: null, paths: ["docs"]},
    credentials: {relayUrl: "https://relay.test", token: "real-account-token", userId: "reader", signal: new AbortController().signal},
    accessEnded: () => ended,
    assertCurrent() {if (!current) throw new Error("switched");}, fetch: request, preserveDraft, recordDelivery, isOnline: () => isOnline});
  return {refuse(code: string) { reason = code; status = "disconnected"; notify(); }, select, stop(accessEnded: boolean) { ended = accessEnded; session.disconnect(); }, capture, request, closed, preserveDraft, session, switchWorkspace() {current = false;},
    quarantineEdit(change: () => void) {doc.transact(change); status = "quarantined"; notify(); return false;},
    retry() {status = "live"; reason = "admission-unavailable"; notify();},
    terminal() {status = "quarantined"; reason = "authority-refused"; notify();},
    ack() {pendingUpdates = 0; reason = null; notify();}};
}

it.each(["pending", "refused"] as const)("does not open body or field editing for a %s record draft", async state => {
  const f = fixture(async () => ({state, contentHash: null, canDiscard: false}));
  await expect(f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()}))
    .rejects.toThrow(state === "pending" ? "Waiting to send" : "did not accept");
  expect(f.request).not.toHaveBeenCalled();
  expect(transport.factory).not.toHaveBeenCalled();
});

it("reports a failed connection without blaming the owner after acceptance", async () => {
  const f = fixture(async () => ({state: "accepted", contentHash: null, canDiscard: false}));
  f.request.mockRejectedValue(new TypeError("offline"));
  await expect(f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()}))
    .rejects.toMatchObject({waiting: {state: "failed", message: "dohc could not connect. Check your connection."}});
  expect(transport.factory).not.toHaveBeenCalled();
});

it("shows known offline state even while a creation is still pending", async () => {
  const f = fixture(async () => ({state: "pending", contentHash: null, canDiscard: false}), false);
  await expect(f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()}))
    .rejects.toMatchObject({waiting: {state: "offline", message: "This device is offline. Connect to edit this file."}});
  expect(f.request).not.toHaveBeenCalled();
});

it("reports only host acknowledgement as saved and never settles a local file", async () => {
  const f = fixture(), onSaveState = vi.fn();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn(), onSaveState});
  expect(transport.factory.mock.calls[0]![0].recordingContext()).toEqual({kind: "account", accountId: "reader"});
  const edit = new Y.Doc(); edit.getText("body").insert(0, "pending");
  provider.applyLocalUpdate(Y.encodeStateAsUpdate(edit)); edit.destroy();
  expect(onSaveState).toHaveBeenLastCalledWith("settling", 1, "start");
  f.ack();
  expect(onSaveState).toHaveBeenLastCalledWith("saved-to-host", 1, "outcome");
  await provider.close();
  expect(f.preserveDraft).not.toHaveBeenCalled();
});

it("reports no file head, so the note check still judges a shared note", async () => {
  const f = fixture();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()});
  expect(provider.headSha256).toBeNull();
  await provider.close();
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
  expect(f.preserveDraft).toHaveBeenLastCalledWith({path: "docs/a.md", objectId: "object", remoteWorkspaceId: "named:grant", update: exact});
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
  expect(f.preserveDraft).toHaveBeenLastCalledWith({path: "docs/a.md", objectId: "object", remoteWorkspaceId: "named:grant", update: exact});
  expect(f.closed).toHaveBeenCalledOnce();
});

it("writes exact recovery under its original local workspace without admitting secret paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-named-recovery-"));
  cleanup.push(() => rm(directory, {recursive: true, force: true}));
  const draft = {path: "docs/a.md", objectId: "object", remoteWorkspaceId: "owner-workspace", update: new Uint8Array([0, 0])};
  await preserveLiveDraft(directory, "recipient-workspace", draft);
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  const row = JSON.parse(await readFile(join(directory, names[0]!), "utf8"));
  expect(row.workspaceId).toBe("recipient-workspace");
  expect(Buffer.from(row.updateBase64, "base64")).toEqual(Buffer.from(draft.update));
  await expect(preserveLiveDraft(directory, "other-workspace", {...draft, path: ".env"})).rejects.toThrow("cannot enter draft recovery");
  expect(await readdir(directory)).toEqual(names);
});

it.each([false, true])("records whether non-live status means ended access: %s", async (ended) => {
  const f = fixture(), onSaveState = vi.fn();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn(), onSaveState});
  f.stop(ended);
  expect(onSaveState).toHaveBeenLastCalledWith("read-only", 0, "status", undefined, ended ? "access-ended" : "reconnecting");
  await provider.close();
});

it("opens the winner of a record name race once creation status clears", async () => {
  let delivery: ShareRecordStatus | null = {state: "refused", contentHash: null, canDiscard: false};
  const f = fixture(async () => delivery);
  await expect(f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()}))
    .rejects.toThrow("did not accept");
  expect(f.request).not.toHaveBeenCalled();
  delivery = null;
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()});
  expect(f.request).toHaveBeenCalledOnce();
  expect(provider.liveWritable?.()).toBe(true);
  const edit = new Y.Doc();
  edit.getText("body").insert(0, "Continue the winner's record");
  provider.applyLocalUpdate(Y.encodeStateAsUpdate(edit));
  edit.destroy();
  expect(provider.doc.getText("body").toString()).toBe("Continue the winner's record");
  f.ack();
  await provider.close();
  expect(f.preserveDraft).not.toHaveBeenCalled();
});

it("keeps a readiness stream until the host wakes it and closes it after readiness", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode("waiting\n")); }, cancel,
  }), {headers: {"content-type": "text/plain"}}));
  const waiting = waitForNamedDesktopAdmission({relayUrl: "https://relay.test", token: "token", shareId: "share",
    path: "docs/a.md", signal: new AbortController().signal, fetch});
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  stream.enqueue(new TextEncoder().encode("ready\n"));
  expect(await waiting).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetch.mock.calls).toHaveLength(1);
});

it("checks readiness only inside the pinned share and discards an answer after switching", async () => {
  const f = fixture();
  expect(await f.capture.waitForAdmission!("other/a.md", new AbortController().signal)).toBe(false);
  expect(f.request).not.toHaveBeenCalled();
  f.request.mockImplementationOnce(async () => {
    f.switchWorkspace();
    return new Response("waiting\nready\n", {headers: {"content-type": "text/plain"}});
  });
  await expect(f.capture.waitForAdmission!("docs/a.md", new AbortController().signal)).rejects.toThrow("switched");
  expect(f.request).toHaveBeenCalledOnce();
});

it("returns unavailable when the relay ends a readiness wait", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce(new Response("waiting\nunavailable\n", {headers: {"content-type": "text/plain"}}));
  expect(await f.capture.waitForAdmission!("docs/a.md", new AbortController().signal)).toBe(false);
  expect(transport.factory).not.toHaveBeenCalled();
});

it.each(Object.entries(LIVE_CONNECTION_LIMIT_MESSAGES))("shows the %s opening refusal", async (code, message) => {
  const f = fixture();
  f.session.reconnect = async () => {};
  const state = f.session.state;
  f.session.state = () => ({...state(), reason: code});
  await expect(f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()}))
    .rejects.toMatchObject({waiting: {state: "failed", message}});
  expect(f.closed).toHaveBeenCalled();
});

it.each(Object.entries(LIVE_CONNECTION_LIMIT_MESSAGES))("reports the %s session refusal through the desktop notice hook", async (code, message) => {
  const f = fixture(), onEditRefused = vi.fn(), onSaveState = vi.fn();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn(), onEditRefused, onSaveState});
  f.refuse(code);
  expect(onEditRefused).toHaveBeenLastCalledWith(code, message);
  expect(onSaveState).toHaveBeenLastCalledWith("read-only", 0, "status", undefined, "reconnecting");
  expect(provider.liveWritable!()).toBe(false);
  await provider.close();
});

it("keeps editing on retryable admission and stops on a terminal refusal", async () => {
  const f = fixture(), onSaveState = vi.fn();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn(), onSaveState});
  const edit = new Y.Doc(); edit.getText("body").insert(0, "pending");
  provider.applyLocalUpdate(Y.encodeStateAsUpdate(edit)); edit.destroy();
  f.retry();
  expect(provider.liveWritable?.()).toBe(true);
  expect(onSaveState.mock.calls.some(([state]) => state === "read-only")).toBe(false);
  f.ack(); expect(onSaveState).toHaveBeenLastCalledWith("saved-to-host", 1, "outcome");
  f.terminal();
  expect(provider.liveWritable?.()).toBe(false);
  expect(onSaveState).toHaveBeenLastCalledWith("read-only", 1, "status", undefined, "reconnecting");
  await provider.close();
});

it.each([401, 403, 404])("retries desktop admission status %s while access is active", async status => {
  const f = fixture();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()});
  const actual = await vi.importActual<typeof import("@dohc/ydoc-projection/named-live-browser-transport")>("@dohc/ydoc-projection/named-live-browser-transport");
  const options = transport.factory.mock.calls[0]![0] as Parameters<typeof actual.createNamedLiveBrowserTransport<NamedLiveSelection>>[0];
  const selected = {accountId: "reader", workspaceId: "named:grant", grantId: "grant", objectId: "object"};
  await options.authorize!(selected, new AbortController().signal);
  f.request.mockResolvedValue(new Response(null, {status}));
  vi.useFakeTimers();
  const openSocket = vi.fn();
  const manager = actual.createNamedLiveBrowserTransport({...options, openSocket});
  cleanup.push(async () => manager.close());
  const session = manager.select(selected);
  await session.reconnect();
  expect(session.state()).toMatchObject({status: "disconnected", reason: "connection-failed"});
  expect(f.request).toHaveBeenCalledTimes(2);
  for (const [index, delay] of [250, 500, 1_000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.request).toHaveBeenCalledTimes(index + 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.request).toHaveBeenCalledTimes(index + 3);
    expect(session.state()).toMatchObject({status: "disconnected", reason: "connection-failed"});
  }
  expect(openSocket).not.toHaveBeenCalled();
  session.close();
  expect(vi.getTimerCount()).toBe(0);
  await provider.close();
});

it("stops desktop admission retries when access ends", async () => {
  const f = fixture();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()});
  const actual = await vi.importActual<typeof import("@dohc/ydoc-projection/named-live-browser-transport")>("@dohc/ydoc-projection/named-live-browser-transport");
  const options = transport.factory.mock.calls[0]![0] as Parameters<typeof actual.createNamedLiveBrowserTransport<NamedLiveSelection>>[0];
  const selected = {accountId: "reader", workspaceId: "named:grant", grantId: "grant", objectId: "object"};
  await options.authorize!(selected, new AbortController().signal);
  f.stop(true);
  await expect(options.authorize!(selected, new AbortController().signal)).rejects.toBeInstanceOf(LiveAuthorityUnavailableError);
  vi.useFakeTimers();
  const openSocket = vi.fn();
  const manager = actual.createNamedLiveBrowserTransport({...options, openSocket});
  cleanup.push(async () => manager.close());
  const session = manager.select(selected);
  await session.reconnect();
  expect(session.state()).toMatchObject({status: "disconnected", reason: "authority-unavailable"});
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.request).toHaveBeenCalledOnce();
  expect(openSocket).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await provider.close();
});

it("selects the named binding from its own desktop admission and fences a changed reconnect grant", async () => {
  const f = fixture();
  const provider = await f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()});
  const selection = {accountId: "reader", workspaceId: "named:grant", grantId: "grant", objectId: "object"};
  expect(f.select).toHaveBeenCalledExactlyOnceWith(selection);
  const {authorize} = transport.factory.mock.calls[0]![0];
  const first = await authorize(selection, new AbortController().signal);
  expect(first.ticketToken).toBe("a".repeat(64));
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (...args) => {
    const body = await (await original(...args)).json();
    return Response.json({...body, grantId: "other-grant", workspaceId: "named:other-grant"});
  });
  await expect(authorize(selection, new AbortController().signal)).rejects.toThrow("The shared file changed");
  await provider.close();
});

it.each(["owner-workspace", "named:other-grant"])("refuses a desktop admission binding %s before opening a live transport", async workspaceId => {
  const f = fixture(), original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (...args) => {
    const body = await (await original(...args)).json();
    return Response.json({...body, workspaceId});
  });
  await expect(f.capture.openYDocSession({path: "docs/a.md", contentKind: "richdoc", onRemoteUpdate: vi.fn()})).rejects.toThrow();
  expect(transport.factory).not.toHaveBeenCalled();
});
