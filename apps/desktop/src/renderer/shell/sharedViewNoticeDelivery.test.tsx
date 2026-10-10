// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import { sharedViewAccessOperations } from "../../ipc/bridgeContract";
import { createNoticeStore } from "../../notices/noticeStore";
import { createTestScratch } from "../../workspaces/testTemp";
import { createSharedViewsIpcHarness } from "../../testing/sharedViewsIpcHarness";
import { deferred } from "../../testing/deferred";
import { automationPressRelay } from "../../automations/relayedPresses";
import { useSentNotices } from "./useSentNotices";
import { useSharedViewAccess } from "./useSharedViewAccess";
import { createAutomationButtons, resetAutomationButtonsForTests } from "../collections/useAutomationButtons";

afterEach(() => { cleanup(); resetAutomationButtonsForTests(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function delivery() {
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
  const h = await createSharedViewsIpcHarness({ syncNotices: current => store.sync(current) });
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

async function pendingBurst() {
  const f = await delivery();
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
  f.h.reconcile.mockClear(); f.h.storeFor.mockClear();
  check.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const buttons = createAutomationButtons({ workspaceId: "existing", of: { collectionPath: "docs" } });
  await act(async () => buttons.press("Finish", { id: "docs/task.md", label: "task" }));
  expect(f.h.syncNotices).not.toHaveBeenCalled();
  const probe = async (delay: number, waitForNotices = true) => {
    pulled = deferred();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delay);
      await pulled.promise;
      const pass = f.h.syncNotices.mock.results.at(-1)?.value;
      if (pass && waitForNotices) await pass;
    });
  };
  return { ...f, probe, check };
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
  expect(f.check).not.toHaveBeenCalled();
  expect(f.h.syncNotices).toHaveBeenCalledTimes(4);
  expect(f.fetch).toHaveBeenCalledTimes(4);
  f.h.probeLog.mockClear(); f.h.syncNotices.mockClear(); f.fetch.mockClear();
  await f.probe(30_000);
  expect(f.h.probeLog).toHaveBeenCalledOnce();
  expect(f.check).not.toHaveBeenCalled();
  expect(f.h.syncNotices).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  expect(f.h.reconcile).not.toHaveBeenCalled(); expect(f.h.storeFor).not.toHaveBeenCalled();
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
