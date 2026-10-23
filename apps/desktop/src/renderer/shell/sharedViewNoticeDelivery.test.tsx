// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import { sharedViewAccessOperations } from "../../ipc/bridgeContract";
import { createNoticeStore } from "../../notices/noticeStore";
import { createTestScratch } from "../../workspaces/testTemp";
import { createSharedViewsIpcHarness } from "../../testing/sharedViewsIpcHarness";
import { deferred } from "../../testing/deferred";
import { probeShareViewLog } from "../../workspaces/shareViewInfo";
import { createShareViewFiles, type ResolvedShareViewFilesTarget } from "../../workspaces/shareViewFiles";
import { createShareViewDaemonHarness } from "../../testing/shareViewLoopbackTransport";
import { readLocalStateFrom } from "../../workspaces/workspaceLocalState";
import { automationPressRelay } from "../../automations/relayedPresses";
import { useSentNotices } from "./useSentNotices";
import { useSharedViewAccess } from "./useSharedViewAccess";
import { createAutomationButtons, resetAutomationButtonsForTests } from "../collections/useAutomationButtons";

afterEach(() => { cleanup(); resetAutomationButtonsForTests(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function delivery(rootPath?: string) {
  let changed: (() => void) | undefined;
  let rows: unknown[] = [];
  const fetch = vi.fn(async () => Response.json({ ok: true, notices: rows, nextCursor: "1", hasMore: false, replace: true }));
  const store = createNoticeStore({
    directory: await createTestScratch("shared-notices-"), installId: () => "recipient",
    onChanged: () => changed?.(),
    session: async () => ({ account: { key: "recipient", userId: "recipient",
      relay: { baseUrl: "https://relay.example.test", token: "token", fetch } },
      isCurrent: () => true, reachFor: () => ({ shareId: "share" }) }),
  });
  const h = await createSharedViewsIpcHarness({ rootPath, syncNotices: current => store.sync(current) });
  vi.stubGlobal("dohcDesktop", {
    listNotices: () => store.list(),
    onNoticesChanged: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; },
  } as unknown as DohcDesktopBridge);
  const hook = renderHook(() => useSentNotices(true));
  await waitFor(() => expect(hook.result.current.settled).toBe(true));
  const failed = {
    noticeId: "automation-press:failed", changeSeq: 1, workspaceId: null, recipientShareId: "share",
    kind: "automation-failed", senderKind: "automation", senderUserId: "owner", senderLabel: "Finish",
    title: "Finish did not finish", body: "The action failed.", target: { path: "docs", record: "docs/task.md", automation: "finish" },
    originInstallId: "owner", createdAtMs: Date.now(), readAtMs: null, dismissedAtMs: null, removed: false,
  };
  return { h, hook, store, fetch, failed, arrive: () => { rows = [failed]; } };
}

it("shows a failed relayed press's Notice and toast after a committed pull while the window stays focused", async () => {
  const f = await delivery();
  const focus = vi.fn(); window.addEventListener("focus", focus);
  try {
    f.arrive();
    await act(async () => { await f.h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }); });
    expect(f.h.syncNotices).toHaveBeenCalledOnce();
    await waitFor(() => expect(f.hook.result.current.toast?.noticeId).toBe(f.failed.noticeId));
    expect(f.hook.result.current.notices).toEqual([expect.objectContaining({ title: f.failed.title, recipientShareId: "share" })]);
    expect(focus).not.toHaveBeenCalled();
  } finally { window.removeEventListener("focus", focus); }
});

it("drops the late Notice and toast when the recipient switches away during its pull", async () => {
  const f = await delivery(); f.arrive();
  const response = deferred<Response>(); const started = deferred();
  f.fetch.mockImplementation(async () => { started.resolve(); return response.promise; });
  await act(async () => { await f.h.invoke(sharedViewAccessOperations.refreshSharedView.channel, { workspaceId: "existing" }); });
  expect(f.h.syncNotices).toHaveBeenCalledOnce(); await started.promise;
  const pass = f.h.syncNotices.mock.results[0]!.value;
  await act(async () => {
    f.h.retireRenderer();
    response.resolve(Response.json({ ok: true, notices: [f.failed], nextCursor: "1", hasMore: false, replace: true }));
    await pass;
  });
  expect(f.hook.result.current.notices).toEqual([]);
  expect(f.hook.result.current.toast).toBeNull();
});

it("shows a failed settled press's Notice without a file change or a focus event", async () => {
  const f = await delivery(); f.arrive();
  const routes = automationPressRelay({ baseUrl: "https://relay.example.test", token: "token",
    fetch: async () => Response.json({ ok: true, pressId: "press", state: "settled", outcome: "failed", createdAtMs: Date.now() }) });
  await act(async () => {
    await routes.press("share", { pressId: "press", automationId: "finish", collectionPath: "docs", definitionHash: "0123456789abcdef", recordId: "docs/task.md", confirmed: [] },
      { isCurrent: () => true, sync: f.h.syncNotices });
  });
  expect(f.h.syncNotices).toHaveBeenCalledOnce();
  await waitFor(() => expect(f.hook.result.current.toast?.noticeId).toBe(f.failed.noticeId));
  expect(f.h.reconcile).not.toHaveBeenCalled(); expect(f.h.storeFor).not.toHaveBeenCalled();
});

async function pendingBurst(rootPath?: string) {
  const f = await delivery(rootPath);
  const logFetch = vi.fn<typeof globalThis.fetch>(async input => Response.json({
    ops: [], nextCursor: Number(new URL(String(input)).searchParams.get("since")), hasMore: false,
  }));
  f.h.probeLog.mockImplementation(input => probeShareViewLog({ ...input, relay: { ...input.relay, fetch: logFetch } }));
  f.h.fetchInfo.mockResolvedValue({ shareId: "share", granterUserId: "owner", granterEmail: "owner@test", genericChatWritable: false,
    selector: { paths: ["docs"], access: "edit", versionId: null }, createdAtMs: 1 });
  f.h.reconcile.mockImplementation(async (_lease, _target, _mode, cursor) => {
    cursor?.(42);
    return { kind: "refresh", outcome: { ok: true, status: "unchanged", changedPaths: 0,
      excludedPaths: [], unjournalablePaths: [], refusedOps: 0, refusedDetail: null } };
  });
  const routes = automationPressRelay({ baseUrl: "https://relay.example.test", token: "token",
    fetch: async () => Response.json({ ok: true, pressId: "press", state: "pending", createdAtMs: Date.now() }) });
  const bridge = window.dohcDesktop!;
  const check = vi.fn(async () => ({ status: "current", access: "edit" }));
  Object.assign(bridge, {
    checkSharedViewAccess: check,
    onCloudSessionChanged: () => () => undefined,
    onAutomationRunSettled: () => () => undefined,
    onAutomationRunWaiting: () => () => undefined,
    onCollectionAutomationsChanged: () => () => undefined,
    pressAutomationButton: async () => {
      await routes.press("share", { pressId: "press", automationId: "finish", collectionPath: "docs", definitionHash: "0123456789abcdef", recordId: "docs/task.md", confirmed: [] },
        { isCurrent: () => true, sync: f.h.syncNotices });
      return { busy: false, relayed: true };
    },
  });
  const admission = { superseded: false };
  const opened = deferred();
  let pulled = deferred();
  renderHook(() => useSharedViewAccess({ workspaceId: "existing", admission, enabled: true,
    onVerified() {}, onPersistentFailure(error) { throw error; },
    pull: async pressBurst => {
      const outcome = await f.h.invoke(sharedViewAccessOperations.refreshSharedView.channel,
        { workspaceId: "existing", trigger: pressBurst ? "press-burst" : "background" });
      opened.resolve();
      pulled.resolve();
      return (outcome as { changedPaths: number }).changedPaths > 0;
    },
  }));
  await act(async () => opened.promise);
  expect(f.h.syncNotices).not.toHaveBeenCalled();
  f.h.reconcile.mockClear(); f.h.storeFor.mockClear(); f.h.status.mockClear();
  f.h.recordIdentity.mockClear(); f.h.startup.mockClear();
  check.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const buttons = createAutomationButtons({ workspaceId: "existing", of: { collectionPath: "docs" } });
  await act(async () => buttons.press("Finish", { id: "docs/task.md", label: "task" }));
  expect(f.h.syncNotices).not.toHaveBeenCalled();
  const probe = async (delay: number, waitForNotices = true) => {
    pulled = deferred();
    const previousProbes = f.h.probeLog.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delay);
      expect(f.h.probeLog).toHaveBeenCalledTimes(previousProbes + 1);
      await pulled.promise;
      const pass = f.h.syncNotices.mock.results.at(-1)?.value;
      if (pass && waitForNotices) await pass;
    });
  };
  return { ...f, probe, check, logFetch };
}

it("delivers a pending press's later failed Notice and toast on an unchanged burst probe without refocus", async () => {
  const f = await pendingBurst();
  const focus = vi.fn(); window.addEventListener("focus", focus);
  try {
    await f.probe(2_000);
    expect(f.h.syncNotices).toHaveBeenCalledOnce();
    expect(f.hook.result.current.notices).toEqual([]);
    f.arrive();
    await f.probe(3_000);
    expect(f.h.syncNotices).toHaveBeenCalledTimes(2);
    expect(f.hook.result.current.notices).toEqual([expect.objectContaining({ noticeId: f.failed.noticeId })]);
    expect(f.hook.result.current.toast?.noticeId).toBe(f.failed.noticeId);
    expect(f.h.reconcile).not.toHaveBeenCalled(); expect(f.h.storeFor).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  } finally { window.removeEventListener("focus", focus); }
});

it("returns to one GET and no Notices or engine work on the idle poll after four burst probes", async () => {
  const f = await pendingBurst();
  for (const delay of [2_000, 3_000, 5_000, 10_000]) await f.probe(delay);
  expect(f.h.probeLog).toHaveBeenCalledTimes(4);
  expect(f.logFetch).toHaveBeenCalledTimes(4);
  expect(f.check).not.toHaveBeenCalled();
  expect(f.h.syncNotices).toHaveBeenCalledTimes(4);
  expect(f.fetch).toHaveBeenCalledTimes(4);
  process.stdout.write(JSON.stringify({ burst: "unchanged", requests: 8, probeGETs: 4, noticeGETs: 4, noticePasses: 4, engineRPCs: 0 }) + "\n");
  f.h.probeLog.mockClear(); f.h.syncNotices.mockClear(); f.fetch.mockClear(); f.logFetch.mockClear();
  await f.probe(30_000);
  expect(f.h.probeLog).toHaveBeenCalledOnce();
  expect(f.logFetch).toHaveBeenCalledOnce();
  expect(f.check).not.toHaveBeenCalled();
  expect(f.h.syncNotices).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  expect(f.h.reconcile).not.toHaveBeenCalled(); expect(f.h.storeFor).not.toHaveBeenCalled();
});

it("keeps the burst after a changed probe and delivers a failure after six seconds without refocus", async () => {
  const rootPath = await createTestScratch("changed-burst-");
  const f = await pendingBurst(rootPath);
  const text = "Owner's first step finished.\n";
  const sha = createHash("sha256").update(text).digest("hex");
  const ops = [{ relaySeq: 43, opKind: "moment.append", payload: { versionId: "main", path: "docs/task.md",
    operation: "write", payloadAfterPath: "docs/task.md", payloadAfterBlobSha256: sha, metadata: { origin: "sync" } } }];
  const pullFetch = vi.fn<typeof globalThis.fetch>(async input => new URL(String(input)).pathname.endsWith("/log")
    ? Response.json({ ops, nextCursor: 43, hasMore: false }) : new Response(text));
  const daemon = createShareViewDaemonHarness({ baseUrl: "https://relay.example.test", token: "token", fetch: pullFetch });
  // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
  readLocalStateFrom(daemon.sessions);
  const target: ResolvedShareViewFilesTarget = { kind: "standalone", workspaceId: "existing", storeWorkspaceId: "existing",
    rootPath, schedulingRootPath: rootPath, shareId: "share", granterEmail: "owner@test",
    grantedSelector: f.h.workspace.shareView!.grantedSelector, ended: false };
  const files = createShareViewFiles({
    resolveTarget: () => target, openStore: () => daemon.openStore(target), resolveRelay: async () => daemon.relay,
    pull: (_target, _relay, input) => daemon.pullFor(target)({ ...input, shareId: "share" }),
    recordRefusals: async () => undefined, updateUnsavedPaths: async () => undefined, markEnded: async () => undefined,
    retireTarget: async () => undefined, assertProjectionRoot: async () => undefined,
    createMount: async () => undefined, removeMount: async () => ({ folderLeft: false }),
  });
  const focus = vi.fn(); window.addEventListener("focus", focus);
  try {
    f.logFetch.mockResolvedValueOnce(Response.json({ ops, nextCursor: 43, hasMore: false }));
    f.h.reconcile.mockImplementationOnce(files.reconcile);
    await f.probe(2_000);
    expect(daemon.transport.committedCursor("existing")).toBe(43);
    const engineCalls = daemon.transport.requests.length;
    expect(engineCalls).toBe(11);
    await f.probe(3_000);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    f.arrive();
    await f.probe(4_000);
    expect(f.hook.result.current.toast?.noticeId).toBe(f.failed.noticeId);
    expect(f.hook.result.current.notices).toEqual([expect.objectContaining({ noticeId: f.failed.noticeId })]);
    await f.probe(10_000);
    expect(f.h.probeLog).toHaveBeenCalledTimes(4);
    expect(f.logFetch).toHaveBeenCalledTimes(4);
    expect(f.h.syncNotices).toHaveBeenCalledTimes(4);
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.h.reconcile).toHaveBeenCalledOnce(); expect(f.h.status).toHaveBeenCalledOnce();
    expect(f.h.startup).toHaveBeenCalledOnce(); expect(f.h.recordIdentity).not.toHaveBeenCalled();
    expect(f.check).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(pullFetch).toHaveBeenCalledTimes(2); // The full pull's log and blob.
    expect(daemon.transport.requests).toHaveLength(engineCalls);
    process.stdout.write(JSON.stringify({ burst: "changed-first", requests: f.logFetch.mock.calls.length + pullFetch.mock.calls.length + f.fetch.mock.calls.length,
      probeGETs: 4, fullPullGETs: 2, noticeGETs: 4, noticePasses: 4, engineRPCs: engineCalls,
      captureStatusCalls: 1, methods: daemon.transport.requests.map(request => request.method) }) + "\n");
    f.h.probeLog.mockClear(); f.h.syncNotices.mockClear(); f.fetch.mockClear(); f.logFetch.mockClear();
    f.h.reconcile.mockClear(); f.h.storeFor.mockClear(); f.h.status.mockClear(); f.h.recordIdentity.mockClear();
    await f.probe(30_000);
    expect(f.h.probeLog).toHaveBeenCalledOnce();
    expect(f.logFetch).toHaveBeenCalledOnce();
    expect(f.h.syncNotices).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.h.reconcile).not.toHaveBeenCalled(); expect(f.h.storeFor).not.toHaveBeenCalled();
    expect(f.h.status).not.toHaveBeenCalled(); expect(f.h.recordIdentity).not.toHaveBeenCalled();
    expect(daemon.transport.requests).toHaveLength(engineCalls); expect(pullFetch).toHaveBeenCalledTimes(2);
    process.stdout.write(JSON.stringify({ poll: "idle-after-changed-burst", requests: 1, noticeGETs: 0, noticePasses: 0, engineRPCs: 0, captureStatusCalls: 0 }) + "\n");
  } finally { window.removeEventListener("focus", focus); await daemon.closeAll(); }
});

it("coalesces four burst Notices requests into one flight and one follow-up", async () => {
  const f = await pendingBurst();
  const response = deferred<Response>();
  f.fetch.mockImplementationOnce(() => response.promise);
  for (const delay of [2_000, 3_000, 5_000, 10_000]) await f.probe(delay, false);
  expect(f.h.syncNotices).toHaveBeenCalledTimes(4);
  expect(f.fetch).toHaveBeenCalledOnce();
  await act(async () => {
    response.resolve(Response.json({ ok: true, notices: [], nextCursor: "1", hasMore: false, replace: true }));
    await f.h.syncNotices.mock.results[0]!.value;
  });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.h.reconcile).not.toHaveBeenCalled(); expect(f.h.storeFor).not.toHaveBeenCalled();
});

it("drops an unchanged burst's late Notice and toast after switching away", async () => {
  const f = await pendingBurst();
  const response = deferred<Response>();
  f.fetch.mockImplementationOnce(() => response.promise);
  await f.probe(2_000, false);
  expect(f.fetch).toHaveBeenCalledOnce();
  await act(async () => {
    f.h.retireRenderer();
    response.resolve(Response.json({ ok: true, notices: [f.failed], nextCursor: "1", hasMore: false, replace: true }));
    await f.h.syncNotices.mock.results[0]!.value;
  });
  expect(f.hook.result.current.notices).toEqual([]);
  expect(f.hook.result.current.toast).toBeNull();
});
