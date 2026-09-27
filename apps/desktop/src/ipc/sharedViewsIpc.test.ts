import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type { WatcherStatusResult } from "@dohc/workspace-engine-client";
import { RelayUnauthorizedError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import { CHANNELS } from "./channels";
import { registerSharedViewsIpcHandlers } from "./sharedViewsIpc";
import { createWorkspaceRootApproval } from "./workspaceRegistryIpc";
import { CredentialSessionCache } from "../workspaces/credentialSessionCache";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { EngineRelayWorkspaceClient } from "../workspaces/engineRelayClient";
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace, type WorkspaceAuthorityLease } from "../workspaces/workspaceAuthorityOwner";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import { createJoinedWorkspaceRunner } from "../workspaces/createJoinedWorkspace";
import { ShareSelectorInvalidError, type ShareViewInfo } from "../workspaces/shareViewInfo";
import { SharePinInvalidError } from "../workspaces/shareViewRecords";
import { withStaleSensitiveWorkspaceOperation } from "../workspaces/workspaceAssets";
import { buildShareCode } from "../workspaces/syncCode";
import { deferred } from "../testing/deferred";

const credentials: CloudCredentials = {
  serverUrl: "https://account.example.test", relayUrl: "https://relay.example.test",
  token: "token", userId: "recipient", email: "recipient@example.test",
};
const info: ShareViewInfo = {
  shareId: "share", granterUserId: "granter", granterEmail: "granter@example.test", genericChatWritable: true,
  selector: { paths: ["docs"], versionId: null, access: "edit" }, createdAtMs: 1,
};
const outcome = { ok: true as const, status: "updated" as const, changedPaths: 2, excludedPaths: [], unjournalablePaths: [], collisionRecordQuarantined: false, refusedOps: 1, refusedDetail: "refused path" };
const ready: WatcherStatusResult = {
  phase: "ready",
  terminal: false,
  running: true,
  degraded: false,
  noAtomicPlacement: false, keptFiles: [],
};

async function harness() {
  const steps: string[] = [];
  const home = resolve("/shared-views-ipc-home").replace(/\\/g, "/");
  const rootPath = `${home}/received`;
  const roots = createWorkspaceRootApproval(() => home); roots.approveRoot(rootPath);
  const workspace: RegistryEntry = {
    workspaceId: "existing", rootPath: `${home}/existing`, kind: "personal", mode: "local-first",
    shareView: { shareId: "share", granterEmail: info.granterEmail, genericChatWritable: false, grantedSelector: info.selector!, relayUrl: credentials.relayUrl },
  };
  const registry = new Map([[workspace.workspaceId, workspace]]);
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id: string) => registry.get(id) ?? null, canonicalizeRoot: (root: string) => root, createState: () => ({}),
  });
  const attachmentId = await authorities.withOperation("existing", operation => operation.workspace.attachmentId);
  let rendererCurrent = true;
  const session = { workspaceId: "existing", attachmentId, generation: 1, isCurrent: () => rendererCurrent };
  type Event = { sender: string; trusted: boolean };
  type Workspace = PhysicalWorkspace<RegistryEntry>;
  type Operation = ExactRendererWorkspaceOperation<Workspace, object, typeof session>;
  type Lease = WorkspaceAuthorityLease<RegistryEntry, object>;
  type Dependencies = Parameters<typeof registerSharedViewsIpcHandlers<string, Event, Operation, Lease>>[0];
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<string, Workspace, object, typeof session>({
    currentSession: () => session, withPhysicalOperation: (id, work) => authorities.withOperation(id, work),
  });
  const cache = new CredentialSessionCache<CloudCredentials>(); cache.set(credentials);
  const load = vi.fn<() => Promise<CloudCredentials | null>>(async () => cache.snapshot().credentials);
  const warm = vi.fn<() => Promise<void>>(async () => undefined);
  const startup = vi.fn<() => Promise<void>>(async () => undefined);
  const fetchInfo = vi.fn<Dependencies["fetchShareViewInfo"]>(async () => { steps.push("preflight"); return info; });
  const readDir = vi.fn(async (_root: string) => [] as string[]);
  const mkdir = vi.fn(async () => { steps.push("mkdir"); });
  const createFolder = vi.fn(async (input: { workspaceId?: string; rootPath: string }) => {
    steps.push("create");
    return { workspaceId: input.workspaceId!, rootPath: input.rootPath, kind: "personal" as const, mode: "local-first" as const };
  });
  const cleanup = vi.fn(async () => { steps.push("cleanup"); });
  const notify = vi.fn<Dependencies["notifyRenderer"]>(() => { steps.push("notify"); });
  const surfaces = vi.fn(() => { steps.push("surfaces"); });
  const createJoinedWorkspace = createJoinedWorkspaceRunner({
    reserve: input => authorities.reserveBinding(input), createFolder,
    register: (reservation, entry) => authorities.registerReservedBinding(reservation, entry, {
      persist: () => { steps.push("register"); registry.set(entry.workspaceId, entry); },
      rollback: () => { registry.delete(entry.workspaceId); },
    }),
    remove: (binding, finalize) => authorities.retireBinding(binding, {
      finalize, removeBinding: () => { steps.push("remove"); registry.delete(binding.workspaceId); },
    }),
    release: (reservation, finalize) => authorities.releaseReservation(reservation, finalize),
    closeRelay: cleanup, rollbackComplete: () => { surfaces(); notify(); }, logError: vi.fn(),
  });
  const setView = vi.fn<Dependencies["setWorkspaceShareView"]>((id, shareView) => { steps.push("pin"); registry.get(id)!.shareView = shareView; });
  const recordIdentity = vi.fn<EngineRelayWorkspaceClient["recordShareViewIdentity"]>(async () => { steps.push("identity"); return { identity: "recorded" }; });
  const relayFor = vi.fn<Dependencies["receivedShareEngine"]["relayFor"]>(() => ({ recordShareViewIdentity: recordIdentity } as unknown as EngineRelayWorkspaceClient));
  const status = vi.fn<() => Promise<WatcherStatusResult>>(async () => { steps.push("capture-ready"); return ready; });
  const storeFor = vi.fn<Dependencies["receivedShareEngine"]["storeFor"]>(() => ({ watcherStatus: status } as unknown as ReturnType<Dependencies["receivedShareEngine"]["storeFor"]>));
  const reconcile = vi.fn<Dependencies["shareViewFiles"]["reconcile"]>(async () => { steps.push("reconcile"); return { kind: "refresh", outcome }; });
  const open = vi.fn<Dependencies["openWorkspaceActivity"]>(async () => { steps.push("open"); });
  const recordRefusal = vi.fn<Dependencies["recordShareViewStoreRefusal"]>();
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  registerSharedViewsIpcHandlers<string, Event, Operation, Lease>({
    registerHandler: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender: event => { if (!event.trusted) throw new Error("untrusted"); },
    withRendererWorkspaceOperation, loadAndCacheCurrentCredentials: load, warmCredentialCache: warm,
    currentCredentials: () => cache.snapshot().credentials, engineDaemonStartup: startup,
    fetchShareViewInfo: fetchInfo, usableRoot: roots.usableRoot, readdir: readDir, mkdir, createJoinedWorkspace,
    setWorkspaceShareView: setView, refreshNativeWorkspaceSurfaces: surfaces, workspaceAuthorities: authorities,
    canonicalWorkspaceFor: lease => {
      lease.assertCurrent();
      return { ...registry.get(lease.binding.workspaceId)!, rootPath: lease.binding.canonicalRootPath, attachmentId: lease.binding.attachmentId };
    },
    withStaleSensitiveWorkspaceOperation, shareViewFiles: { reconcile }, receivedShareEngine: { relayFor, storeFor },
    openWorkspaceActivity: open, requireWorkspace: id => registry.get(id)!, notifyRenderer: notify,
    recordShareViewStoreRefusal: recordRefusal,
  });
  const invoke = (channel: string, payload: unknown, trusted = true) =>
    Promise.resolve().then(() => handlers.get(channel)!({ sender: "window", trusted }, payload));
  const openPayload = { rootPath, shareCode: buildShareCode({ relayUrl: credentials.relayUrl!, shareId: "share" }) };
  return { workspace, registry, authorities, attachmentId, roots, cache, load, warm, startup, fetchInfo, readDir,
    mkdir, createFolder, cleanup, notify, surfaces, setView, recordIdentity, relayFor, status, storeFor, reconcile,
    open, recordRefusal, handlers, invoke, openPayload, steps, retireRenderer: () => { rendererCurrent = false; } };
}

afterEach(() => vi.restoreAllMocks());

describe("registered received-view handlers", () => {
  it("registers open before refresh and rejects untrusted or malformed inputs before work", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([CHANNELS.openSharedView, CHANNELS.refreshSharedView]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    await expect(h.invoke(CHANNELS.openSharedView, { rootPath: "", shareCode: "x" })).rejects.toThrow();
    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "" })).rejects.toThrow();
    expect(h.load).not.toHaveBeenCalled(); expect(h.startup).not.toHaveBeenCalled();
  });

  it("rejects a foreign relay before preflight and retains preflight-before-root ordering", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.openSharedView, { ...h.openPayload, shareCode: "broken" })).rejects.toThrow("share code");
    expect(h.load).not.toHaveBeenCalled();
    await expect(h.invoke(CHANNELS.openSharedView, { ...h.openPayload, shareCode: buildShareCode({ shareId: "share", relayUrl: "https://foreign.example.test" }) })).rejects.toThrow("different server");
    expect(h.fetchInfo).not.toHaveBeenCalled();
    await expect(h.invoke(CHANNELS.openSharedView, { ...h.openPayload, rootPath: `${h.openPayload.rootPath}-sibling` })).rejects.toThrow("chosen through dohc");
    expect(h.fetchInfo).toHaveBeenCalledOnce(); expect(h.readDir).not.toHaveBeenCalled(); expect(h.mkdir).not.toHaveBeenCalled();
  });

  it.each([
    [new ShareUnavailableError(), "No share matches"],
    [new RelayUnauthorizedError(), "session expired"],
    [new ShareSelectorInvalidError("share"), "server didn't say"],
  ])("maps preflight errors without creating local state", async (error, message) => {
    const h = await harness(); h.fetchInfo.mockRejectedValue(error);
    await expect(h.invoke(CHANNELS.openSharedView, h.openPayload)).rejects.toThrow(message as string);
    expect(h.mkdir).not.toHaveBeenCalled(); expect(h.createFolder).not.toHaveBeenCalled();
  });

  it("refuses chat-only shares and populated folders before creation", async () => {
    const h = await harness(); h.fetchInfo.mockResolvedValue({ ...info, selector: null });
    await expect(h.invoke(CHANNELS.openSharedView, h.openPayload)).rejects.toThrow();
    expect(h.readDir).not.toHaveBeenCalled();
    h.fetchInfo.mockResolvedValue(info); h.readDir.mockResolvedValue(["keep.md"]);
    await expect(h.invoke(CHANNELS.openSharedView, h.openPayload)).rejects.toThrow("empty folder");
    expect(h.mkdir).not.toHaveBeenCalled(); expect(h.createFolder).not.toHaveBeenCalled();
  });

  it("holds creation behind preflight and pins the grant before identity, refresh, activity, and projection", async () => {
    const h = await harness(); const started = deferred(); const held = deferred<ShareViewInfo>();
    h.fetchInfo.mockImplementation(() => { h.steps.push("preflight"); started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.openSharedView, h.openPayload);
    await started.promise; expect(h.mkdir).not.toHaveBeenCalled(); expect(h.registry.size).toBe(1);
    held.resolve(info);
    await expect(result).resolves.toMatchObject({ workspace: { rootPath: h.openPayload.rootPath, shareView: { access: "edit", genericChatWritable: true, granterEmail: info.granterEmail } } });
    expect(h.steps).toEqual(["preflight", "mkdir", "create", "register", "pin", "surfaces", "identity", "reconcile", "open", "notify"]);
    expect(h.setView).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ grantedSelector: info.selector, relayUrl: credentials.relayUrl }));
    expect(h.relayFor).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: expect.any(Symbol) }));
    expect(h.recordIdentity).toHaveBeenCalledWith({ grantedSelector: info.selector });
    expect(h.open).toHaveBeenCalledWith(expect.objectContaining({ shareView: expect.objectContaining({ grantedSelector: info.selector }) }));
  });

  it("rolls back a failed first refresh before opening activity", async () => {
    const h = await harness(); h.reconcile.mockResolvedValue({ kind: "refresh", outcome: { ...outcome, status: "ended" } });
    const result = h.invoke(CHANNELS.openSharedView, h.openPayload);
    await expect(result).rejects.toThrow("ended before it could be opened");
    await expect(result).rejects.toThrow(`Files remain in ${h.openPayload.rootPath}.`);
    await expect(result).rejects.toThrow("choose another empty folder");
    expect(h.cleanup).toHaveBeenCalledWith(expect.any(String));
    expect(h.registry.size).toBe(1); expect(h.open).not.toHaveBeenCalled();
    expect(h.steps.indexOf("cleanup")).toBeLessThan(h.steps.indexOf("remove"));
  });

  it("names the preserved folder and another empty folder when the share download fails", async () => {
    const h = await harness(); h.reconcile.mockRejectedValue(new Error("download interrupted"));
    const result = h.invoke(CHANNELS.openSharedView, h.openPayload);
    await expect(result).rejects.toThrow(`Files remain in ${h.openPayload.rootPath}.`);
    await expect(result).rejects.toThrow("choose another empty folder");
    expect(h.registry.size).toBe(1);
  });

  it("retains the registered view and reports the recovery path if rollback cleanup fails", async () => {
    const h = await harness(); h.reconcile.mockRejectedValue(new Error("pull failed")); h.cleanup.mockRejectedValue(new Error("folder busy"));
    const result = h.invoke(CHANNELS.openSharedView, h.openPayload);
    await expect(result).rejects.toThrow("Files remain in");
    await expect(result).rejects.toThrow("choose Forget from its menu before opening the share again");
    expect(h.registry.size).toBe(2); expect(h.open).not.toHaveBeenCalled();
  });

  it("allows the first refresh when edit identity recording fails", async () => {
    const h = await harness(); vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.recordIdentity.mockRejectedValue(new Error("identity unavailable"));
    await expect(h.invoke(CHANNELS.openSharedView, h.openPayload)).resolves.toMatchObject({ workspace: { shareView: { access: "edit" } } });
    expect(h.reconcile).toHaveBeenCalledOnce(); expect(h.open).toHaveBeenCalledOnce();
  });

  it("holds refresh behind daemon startup and capture readiness before relay identity or reconciliation", async () => {
    const h = await harness();
    const bootStarted = deferred(); const boot = deferred();
    h.startup.mockImplementation(() => { bootStarted.resolve(); return boot.promise; });
    const statusStarted = deferred(); const capture = deferred<WatcherStatusResult>();
    h.status.mockImplementation(() => { statusStarted.resolve(); return capture.promise; });
    const result = h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" });
    await bootStarted.promise; expect(h.storeFor).not.toHaveBeenCalled();
    boot.resolve(); await statusStarted.promise;
    expect(h.fetchInfo).not.toHaveBeenCalled(); expect(h.recordIdentity).not.toHaveBeenCalled(); expect(h.reconcile).not.toHaveBeenCalled();
    capture.resolve(ready);
    await expect(result).resolves.toEqual(outcome);
    expect(h.storeFor).toHaveBeenCalledWith({ engineWorkspaceId: "existing", rootPath: h.workspace.rootPath, attachmentId: h.attachmentId });
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing" });
  });

  it.each(["renderer", "authority"] as const)("stops refresh when its %s retires during capture readiness", async (kind) => {
    const h = await harness(); const started = deferred(); const held = deferred<WatcherStatusResult>();
    h.status.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" });
    await started.promise; let drained: Promise<void> | undefined;
    if (kind === "renderer") h.retireRenderer(); else drained = h.authorities.invalidate("existing");
    held.resolve(ready); await expect(result).rejects.toThrow(); await drained;
    expect(h.fetchInfo).not.toHaveBeenCalled(); expect(h.recordIdentity).not.toHaveBeenCalled(); expect(h.reconcile).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled();
  });

  it("does not widen the pinned grant while updating the relay-derived chat fact", async () => {
    const h = await harness(); const pinned = h.workspace.shareView!.grantedSelector;
    h.fetchInfo.mockResolvedValue({ ...info, selector: { paths: ["everything"], versionId: null, access: "edit" } });
    await h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" });
    expect(h.workspace.shareView!.grantedSelector).toBe(pinned);
    expect(h.workspace.shareView!.genericChatWritable).toBe(true);
    expect(h.recordIdentity).toHaveBeenCalledWith({ grantedSelector: pinned });
  });

  it("rejects stale metadata before writing the grant or starting file reconciliation", async () => {
    const h = await harness(); const started = deferred(); const held = deferred<ShareViewInfo>();
    h.fetchInfo.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" });
    await started.promise; h.retireRenderer(); held.resolve(info);
    await expect(result).rejects.toThrow(); expect(h.setView).not.toHaveBeenCalled(); expect(h.reconcile).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled();
  });

  it("skips metadata and edit identity on another relay while retaining the local refresh path", async () => {
    const h = await harness(); h.cache.set({ ...credentials, relayUrl: "https://other.example.test" });
    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" })).resolves.toEqual(outcome);
    expect(h.fetchInfo).not.toHaveBeenCalled(); expect(h.recordIdentity).not.toHaveBeenCalled(); expect(h.reconcile).toHaveBeenCalledOnce();
  });

  it("does not notify a successor workspace after a held refresh settles", async () => {
    const h = await harness(); const started = deferred(); const held = deferred<Awaited<ReturnType<typeof h.reconcile>>>();
    h.reconcile.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" });
    await started.promise; h.retireRenderer(); held.resolve({ kind: "refresh", outcome });
    await expect(result).rejects.toThrow("changed workspaces"); expect(h.notify).not.toHaveBeenCalled();
  });

  // A shared view has no recorder, so the refresh is what meets a store a
  // newer dohc migrated. It puts that refusal on the workspace status and
  // clears it once the store answers. A rebuild refusal stays a refresh
  // error, because a shared view cannot rebuild its store.
  it("records a store refusal that needs an update on the workspace status", async () => {
    const h = await harness();
    const refusal = (message: string) =>
      Object.assign(new Error(message), { wireError: { code: "INTERNAL", message, retry: "no" } });
    h.status.mockRejectedValueOnce(refusal("migrated-by-newer-build: a newer build ran migration 5 (next)"));
    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" })).rejects.toThrow("migrated-by-newer-build");
    expect(h.recordRefusal).toHaveBeenCalledWith("existing", "migrated-by-newer-build", "a newer build ran migration 5 (next)");
    expect(h.reconcile).not.toHaveBeenCalled();

    h.recordRefusal.mockClear();
    h.status.mockRejectedValueOnce(refusal("foreign-database"));
    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" })).rejects.toThrow("foreign-database");
    expect(h.recordRefusal).not.toHaveBeenCalled();

    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" })).resolves.toEqual(outcome);
    expect(h.recordRefusal).toHaveBeenCalledWith("existing", null, null);
  });

  it("notifies about partial pull work and preserves damaged-pin and ended outcomes", async () => {
    const h = await harness(); h.reconcile.mockResolvedValue({ kind: "refresh", outcome: { ok: false, changedPaths: 3, errorMessage: "later page failed" } });
    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" })).resolves.toEqual({ ok: false, changedPaths: 3, errorMessage: "later page failed" });
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing" }); h.notify.mockClear();
    h.reconcile.mockRejectedValue(new SharePinInvalidError("share"));
    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" })).rejects.toThrow("Remove it, then open");
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing" });
    h.reconcile.mockResolvedValue({ kind: "refresh", outcome: { ...outcome, status: "ended" } });
    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" })).resolves.toMatchObject({ status: "ended" });
    expect(h.surfaces).toHaveBeenCalled();
  });
});
