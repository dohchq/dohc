import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatcherStatusResult } from "@dohc/workspace-engine-client";
import { RelayUnauthorizedError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import { claimWorkspace, closeTestStorages, createShare, inspectDatabase, storagePath, testHandler, testStorage, request } from "@dohc/sync-relay/testing";
import { CHANNELS } from "./channels";
import { sharedViewAccessOperations } from "./bridgeContract";
import { shareCaptureNoticeState } from "../workspaces/shareCaptureNotice";
import { fetchShareViewAccess, ShareSelectorInvalidError, type ShareViewInfo } from "../workspaces/shareViewInfo";
import { SharePinInvalidError } from "../workspaces/shareViewRecords";
import { buildShareCode } from "../workspaces/syncCode";
import { deferred } from "../testing/deferred";
import { createSharedViewsIpcHarness as harness, credentials, info, outcome, ready } from "../testing/sharedViewsIpcHarness";

afterEach(() => vi.restoreAllMocks());

describe("share capture Notice dismissal", () => {
  it("persists dismissal without changing protection or accepting a stale Notice", async () => {
    const h = await harness();
    const view = h.workspace.shareView!;
    view.unsavedPaths = ["docs/locked.md"];
    view.unconfirmedChanges = { paths: ["docs/local.yaml"], unchecked: false, checked: 1 };
    const payload = { workspaceId: h.workspace.workspaceId, shareId: view.shareId,
      key: shareCaptureNoticeState(view.unsavedPaths, view.unconfirmedChanges, false).key };
    await h.invoke(sharedViewAccessOperations.dismissShareCaptureNotice.channel, { ...payload, key: "old" });
    expect(h.setView).not.toHaveBeenCalled();
    await h.invoke(sharedViewAccessOperations.dismissShareCaptureNotice.channel, payload);
    const saved = JSON.parse(JSON.stringify(h.registry.get(h.workspace.workspaceId))) as typeof h.workspace;
    expect(saved.shareView?.unconfirmedChanges?.dismissedKey).toBe(payload.key);
    expect(saved.shareView?.unsavedPaths).toEqual(["docs/locked.md"]);
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: h.workspace.workspaceId, summaryChanged: true });
    expect(h.storeFor).not.toHaveBeenCalled();
  });
  it("rejects an untrusted or inactive sender", async () => {
    const h = await harness();
    const payload = { workspaceId: h.workspace.workspaceId, shareId: h.workspace.shareView!.shareId, key: "old" };
    await expect(h.invoke(sharedViewAccessOperations.dismissShareCaptureNotice.channel, payload, false)).rejects.toThrow();
    h.retireRenderer();
    await expect(h.invoke(sharedViewAccessOperations.dismissShareCaptureNotice.channel, payload)).rejects.toThrow();
    expect(h.setView).not.toHaveBeenCalled();
  });
});

describe("metadata-only access checks", () => {
  it("discovers a real relay's Edit-to-View downgrade and revocation", async () => {
    const storage = await testStorage();
    try {
      const relay = testHandler(storage);
      await claimWorkspace(relay, "granter", "owner");
      const shareId = await createShare(relay, "granter", "owner", { recipientUserId: "recipient", paths: ["tasks"], access: "edit" });
      const h = await harness();
      h.workspace.shareView!.shareId = shareId;
      h.workspace.shareView!.grantedSelector.paths = ["tasks"];
      h.workspace.shareView!.relayUrl = "http://relay.test";
      h.cache.set({ ...credentials, relayUrl: "http://relay.test", token: "user:recipient" });
      h.fetchAccess.mockImplementation(input => fetchShareViewAccess({ ...input,
        relay: { ...input.relay, fetch: async (url, init) => relay(new Request(url, init)) },
      }));
      const checkAccess = () => h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "existing" });
      expect(await checkAccess()).toEqual({ status: "current", access: "edit" });
      const db = inspectDatabase(storagePath(storage));
      // Named-grant retuning has no public route yet. Seed its current View
      // state in the real relay store; the authenticated GET remains real.
      db.prepare("UPDATE sync_relay_share_grants SET access = 'view' WHERE share_id = ?").run(shareId);
      expect(await checkAccess()).toEqual({ status: "current", access: "view" });
      expect(h.workspace.shareView!.grantedSelector.access).toBe("view");
      expect(h.end).not.toHaveBeenCalled();
      const removed = await relay(request("granter", `/sync/shares/${shareId}/revoke`, { method: "POST" }));
      expect(removed.status).toBe(200);
      expect(await checkAccess()).toEqual({ status: "ended" });
      expect(h.end).toHaveBeenCalledOnce();
      expect(h.workspace.shareView!.ended).toBe(true);
    } finally { await closeTestStorages(); }
  });

  it.each(["missing", "different", "signed out", "relay"])("keeps %s recipient credentials unverified", async change => {
    const h = await harness();
    if (change === "missing") delete h.workspace.shareView!.recipientUserId;
    if (change === "different") h.cache.set({ ...credentials, userId: "someone-else" });
    if (change === "signed out") h.cache.clear();
    if (change === "relay") h.cache.set({ ...credentials, relayUrl: "https://other.test" });
    expect(await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "existing" })).toEqual({ status: change === "missing" ? "needs-reopen" : "unverified" });
    expect(h.fetchAccess).not.toHaveBeenCalled();
    expect(h.end).not.toHaveBeenCalled();
  });
  it.each(["credentials", "close", "timeout", "workspace"])("publishes a committed end after %s changes", async change => {
    const h = await harness();
    vi.useFakeTimers();
    try {
      h.fetchAccess.mockRejectedValueOnce(new ShareUnavailableError());
      h.end.mockImplementationOnce(async (_lease, _target, assertCurrent) => {
        assertCurrent();
        h.workspace.shareView!.ended = true;
        if (change === "credentials") h.cache.set({ ...credentials, token: "new" });
        if (change === "close") for (const close of h.closed) close();
        if (change === "workspace") h.retireRenderer();
        if (change === "timeout") await vi.advanceTimersByTimeAsync(4_000);
      });
      await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "existing" });
      expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
      expect(h.surfaces).toHaveBeenCalledOnce();
      expect(h.closed.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("publishes narrowing even when capture cannot save a file", async () => {
    const h = await harness();
    h.fetchAccess.mockResolvedValue("view");
    h.narrow.mockImplementationOnce(async (_lease, _target, assertCurrent, commit) => {
      assertCurrent(); commit(["docs/locked.md"], { paths: ["docs/automations.yaml"], unchecked: false, checked: 0 });
    });
    expect(await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "existing" })).toEqual({ status: "current", access: "view" });
    expect(h.workspace.shareView).toMatchObject({ grantedSelector: { access: "view" }, unsavedPaths: ["docs/locked.md"],
      unconfirmedChanges: { paths: ["docs/automations.yaml"], unchecked: false, checked: 0 } });
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "existing" });
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "existing" });
    expect(h.narrow).toHaveBeenCalledOnce();
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledExactlyOnceWith({ workspaceId: "existing", summaryChanged: true });
    expect(h.steps.indexOf("pin")).toBeLessThan(h.steps.indexOf("notify"));
  });

  const payload = { workspaceId: "existing" };
  it("does no content work for unchanged access", async () => {
    const h = await harness();
    expect(await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload)).toEqual({ status: "current", access: "edit" });
    expect(h.fetchAccess).toHaveBeenCalledTimes(1);
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.storeFor).not.toHaveBeenCalled();
    expect(h.setView).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("retires and publishes only confirmed unavailability", async () => {
    const h = await harness();
    for (const error of [new Error("offline"), new RelayUnauthorizedError()]) {
      h.fetchAccess.mockRejectedValueOnce(error);
      expect(await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload)).toEqual({ status: "unverified" });
      expect(h.end).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    }
    h.fetchAccess.mockRejectedValueOnce(new ShareUnavailableError());
    expect(await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload)).toEqual({ status: "ended" });
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.workspace.shareView!.ended).toBe(true);
    expect(h.notify).toHaveBeenCalledWith({ workspaceId: "existing", summaryChanged: true });
    expect(h.reconcile).not.toHaveBeenCalled();
  });
  it("narrows Edit to View without expanding the pinned paths or version", async () => {
    const h = await harness();
    h.workspace.shareView!.grantedSelector.versionId = "saved-version";
    h.fetchAccess.mockResolvedValue("view");
    expect(await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload)).toEqual({ status: "current", access: "view" });
    expect(h.workspace.shareView!.grantedSelector).toEqual({ paths: ["docs"], versionId: "saved-version", access: "view" });
    h.fetchAccess.mockResolvedValue("edit");
    expect(await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload)).toEqual({ status: "current", access: "view" });
    expect(h.reconcile).not.toHaveBeenCalled();
  });
  it.each(["workspace", "credentials", "close"])("discards a deferred 404 after %s changes", async (change) => {
    const h = await harness();
    const response = deferred<"edit" | "view">();
    h.fetchAccess.mockReturnValueOnce(response.promise);
    const result = h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
    await vi.waitFor(() => expect(h.fetchAccess).toHaveBeenCalledTimes(1));
    if (change === "workspace") h.retireRenderer();
    if (change === "credentials") h.cache.set({ ...credentials, token: "new-token" });
    if (change === "close") for (const close of h.closed) close();
    response.reject(new ShareUnavailableError());
    expect(await result).toEqual({ status: "unverified" });
    expect(h.end).not.toHaveBeenCalled();
    expect(h.setView).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("bounds a hung request and refuses overlapping work", async () => {
    const h = await harness();
    vi.useFakeTimers();
    try {
      const started = deferred<void>();
      h.fetchAccess.mockImplementationOnce(async ({ signal }) => {
        started.resolve();
        return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      });
      const result = h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload);
      await started.promise;
      expect(await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, payload)).toEqual({ status: "unverified" });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await result).toEqual({ status: "unverified" });
      expect(h.fetchAccess).toHaveBeenCalledTimes(1);
      expect(h.end).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe("registered received-view handlers", () => {
  it.each(["view", "ended"])("preserves %s while refresh metadata is deferred", async change => {
    const h = await harness();
    const started = deferred<void>();
    const response = deferred<ShareViewInfo>();
    h.fetchInfo.mockImplementationOnce(() => { started.resolve(); return response.promise; });
    const refreshed = h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" });
    await started.promise;
    if (change === "view") h.fetchAccess.mockResolvedValueOnce("view");
    else h.fetchAccess.mockRejectedValueOnce(new ShareUnavailableError());
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "existing" });
    response.resolve({ ...info, subjectName: "Renamed" });
    await refreshed;
    expect(h.workspace.shareView).toMatchObject({ subjectName: "Renamed", ...(change === "view" ? { grantedSelector: { access: "view" } } : { ended: true }) });
    expect(h.recordIdentity).not.toHaveBeenCalledWith({ grantedSelector: info.selector });
  });

  it("tells an old received copy to reopen before capture or pull", async () => {
    const h = await harness();
    delete h.workspace.shareView!.recipientUserId;
    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" })).rejects.toThrow("This share must be reopened");
    expect(h.storeFor).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("records current identity when refresh receives a deferred 404", async () => {
    const h = await harness();
    const response = deferred<ShareViewInfo>();
    h.fetchInfo.mockReturnValueOnce(response.promise);
    const refresh = h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" });
    await vi.waitFor(() => expect(h.fetchInfo).toHaveBeenCalledOnce());
    h.fetchAccess.mockResolvedValueOnce("view");
    await h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "existing" });
    response.reject(new ShareUnavailableError());
    await refresh;
    expect(h.recordIdentity).not.toHaveBeenCalled();
  });

  it("registers open before refresh and rejects untrusted or malformed inputs before work", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([CHANNELS.openSharedView, CHANNELS.refreshSharedView,
      sharedViewAccessOperations.dismissShareCaptureNotice.channel, sharedViewAccessOperations.checkSharedViewAccess.channel]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    await expect(h.invoke(CHANNELS.openSharedView, { rootPath: "", shareCode: "x" })).rejects.toThrow();
    await expect(h.invoke(CHANNELS.refreshSharedView, { workspaceId: "" })).rejects.toThrow();
    await expect(h.invoke(sharedViewAccessOperations.checkSharedViewAccess.channel, { workspaceId: "" })).rejects.toThrow();
    expect(h.fetchAccess).not.toHaveBeenCalled();
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
    h.fetchInfo.mockResolvedValue({ ...info, subjectName: "Renamed", sharerName: "Ana", selector: { paths: ["everything"], versionId: null, access: "edit" } });
    await h.invoke(CHANNELS.refreshSharedView, { workspaceId: "existing" });
    expect(h.workspace.shareView!.grantedSelector).toBe(pinned);
    expect(h.workspace.shareView!.genericChatWritable).toBe(true);
    expect(h.workspace.shareView).toMatchObject({subjectName: "Renamed", sharerName: "Ana"});
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
