// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, PushShareDirectWritesResult, ShareDirectWritesPushedEvent, ShareDirectWriteAnswerDelivery } from "../../ipc/bridgeContract";
import { useShareDirectWrites, type DirectWriteNotice, type ShareViewRefresh } from "./useShareDirectWrites";
import { deferred } from "../../testing/deferred";

let pushed: ((event: ShareDirectWritesPushedEvent, delivery: ShareDirectWriteAnswerDelivery) => void) | null = null;
const delivery = { claim: vi.fn(async () => true), acknowledge: vi.fn(async () => true), release: vi.fn(async () => true) };
const pushShareDirectWrites = vi.fn<(payload: { workspaceId: string }) => Promise<void>>();
const NOTHING: PushShareDirectWritesResult = { status: "pushed", writes: [] };

beforeEach(() => {
  pushed = null;
  pushShareDirectWrites.mockReset();
  pushShareDirectWrites.mockResolvedValue(undefined);
  for (const method of Object.values(delivery)) { method.mockReset(); method.mockResolvedValue(true); }
  window.dohcDesktop = {
    pushShareDirectWrites,
    onShareDirectWritesPushed: (listener: (event: ShareDirectWritesPushedEvent, delivery: ShareDirectWriteAnswerDelivery) => void) => {
      pushed = listener;
      return () => { pushed = null; };
    },
  } as unknown as DohcDesktopBridge;
});

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

async function setup(options: { enabled?: boolean; ready?: boolean; workspaceId?: string; opened?: PushShareDirectWritesResult; ended?: boolean } = {}) {
  const workspaceId = options.workspaceId ?? "share-view";
  if (options.opened) respond(options.opened);
  const notices: DirectWriteNotice[] = [];
  const refreshShareView = vi.fn(async (): Promise<ShareViewRefresh> => (options.ended ? "ended" : "current"));
  const checkShareAccess = vi.fn(async (): Promise<ShareViewRefresh> => (options.ended ? "ended" : "current"));
  const sendShareChanges = vi.fn(async () => undefined);
  const hook = renderHook(() =>
    useShareDirectWrites({
      workspaceId,
      sharedView: true,
      enabled: options.enabled ?? true,
      ready: options.ready ?? true,
      ownerName: "ana@example.com",
      refreshShareView,
      checkShareAccess,
      sendShareChanges,
      showNotice: (notice) => notices.push(notice),
    }),
  );
  // The push on open.
  await act(async () => { await Promise.resolve(); });
  return { notices, refreshShareView, checkShareAccess, sendShareChanges, hook };
}

function respond(result: PushShareDirectWritesResult) {
  pushShareDirectWrites.mockImplementationOnce(async () => { pushed?.({ answerId: crypto.randomUUID(), workspaceId: "share-view", result }, delivery); });
}

async function answer(result: PushShareDirectWritesResult, workspaceId = "share-view") {
  await act(async () => { pushed?.({ answerId: crypto.randomUUID(), workspaceId, result }, delivery); });
}

it("pushes when the view opens and shows what that push answered", async () => {
  const { notices } = await setup({
    opened: { status: "pushed", writes: [{ result: "refused", paths: ["trip/packing/automations.yaml"], reason: "" }] },
  });
  expect(pushShareDirectWrites).toHaveBeenCalledWith({ workspaceId: "share-view" });
  expect(notices.map((notice) => notice.message)).toEqual([
    "The sync relay did not accept your change to packing/automations.yaml. Send it as a proposal.",
  ]);
});

it("keeps listening without pushing when the share view cannot write", async () => {
  await setup({ enabled: false });
  expect(pushed).not.toBeNull();
  expect(pushShareDirectWrites).not.toHaveBeenCalled();
});

it("subscribes only for ready shared views", async () => {
  const input = { workspaceId: "share-view", sharedView: false, enabled: false, ready: true, ownerName: "Owner",
    refreshShareView: async () => "current" as const, checkShareAccess: async () => "current" as const,
    sendShareChanges: async () => {}, showNotice: vi.fn() };
  const hook = renderHook(props => useShareDirectWrites(props), { initialProps: input });
  expect(pushed).toBeNull();
  expect(pushShareDirectWrites).not.toHaveBeenCalled();
  hook.rerender({ ...input, sharedView: true, ready: false });
  expect(pushed).toBeNull();
  hook.rerender({ ...input, sharedView: true, enabled: true });
  expect(pushed).not.toBeNull();
  await act(async () => {});
  expect(pushShareDirectWrites).toHaveBeenCalledOnce();
});

it("does not toast an answer claimed by another window", async () => {
  const { notices } = await setup({ enabled: false });
  delivery.claim.mockResolvedValueOnce(false);
  await answer({ status: "pushed", writes: [{ result: "refused", paths: ["tasks/automations.yaml"], reason: "" }] });
  expect(delivery.claim).toHaveBeenCalledOnce();
  expect(notices).toHaveLength(0);
  expect(delivery.acknowledge).not.toHaveBeenCalled();
});

it("releases a claim whose reply arrives after the view closed", async () => {
  const { notices, hook } = await setup({ enabled: false });
  const claimed = deferred<boolean>();
  delivery.claim.mockReturnValueOnce(claimed.promise);
  await answer({ status: "pushed", writes: [{ result: "refused", paths: ["tasks/automations.yaml"], reason: "" }] });
  expect(delivery.claim).toHaveBeenCalledOnce();
  hook.unmount();
  await act(async () => claimed.resolve(true));
  expect(notices).toHaveLength(0);
  expect(delivery.acknowledge).not.toHaveBeenCalled();
  expect(delivery.release).toHaveBeenCalledOnce();
});

it("waits for readiness before reporting unavailable, then shows only the access ended notice", async () => {
  respond({ status: "unavailable" });
  const showNotice = vi.fn<(notice: DirectWriteNotice) => void>();
  const refreshShareView = vi.fn(async (ready: boolean): Promise<ShareViewRefresh> => ready ? "ended" : "stale");
  const hook = renderHook(({ ready }) => useShareDirectWrites({
    sharedView: true, workspaceId: "share-view",
    enabled: true,
    ready,
    ownerName: "ana@example.com",
    refreshShareView: () => refreshShareView(ready),
    checkShareAccess: () => refreshShareView(ready),
    sendShareChanges: async () => undefined,
    showNotice,
  }), { initialProps: { ready: false } });
  await act(async () => { answer({ status: "unavailable" }); });
  expect(showNotice).not.toHaveBeenCalled();
  expect(refreshShareView).not.toHaveBeenCalled();
  expect(pushShareDirectWrites).not.toHaveBeenCalled();

  hook.rerender({ ready: true });
  await vi.waitFor(() => expect(showNotice).toHaveBeenCalledOnce());
  expect(pushShareDirectWrites).toHaveBeenCalledOnce();
  expect(refreshShareView).toHaveBeenCalledExactlyOnceWith(true);
  expect(showNotice).toHaveBeenCalledWith({
    kind: "direct-write-unavailable",
    message: "Your access to this share ended. Your unsent Collection changes stay in this workspace. Ask ana@example.com to share it again.",
    retry: null,
    send: null,
  });
});

it("shows only the answers main reports for its own share view", async () => {
  const { notices, refreshShareView } = await setup();
  await answer({ status: "pushed", writes: [{ result: "written", paths: ["trip/packing/collection.yaml"] }] });
  await answer({ status: "pushed", writes: [{ result: "refused", paths: ["trip/a/collection.yaml"], reason: "" }] }, "other");
  expect(notices).toEqual([]);
  expect(refreshShareView).not.toHaveBeenCalled();
});

it("refreshes after a stale write and offers each unsent write as a proposal, with the relay's reason", async () => {
  const { notices, refreshShareView, sendShareChanges } = await setup();
  await answer({
    status: "pushed",
    writes: [
      { result: "stale", paths: ["trip/packing/collection.yaml"], stalePath: "trip/packing/collection.yaml", recoveredDraftPath: null },
      { result: "stale", paths: ["trip/ideas/collection.yaml", "trip/ideas/a.md"], stalePath: "trip/ideas", recoveredDraftPath: null },
      {
        result: "refused",
        paths: ["trip/packing/automations.yaml"],
        reason: "trip/packing/automations.yaml changes an automation with a personal step.",
      },
    ],
  });
  expect(refreshShareView).toHaveBeenCalledTimes(1);
  expect(notices.map(({ kind, message, retry, send }) => ({ kind, message, retry, label: send?.label }))).toEqual([
    {
      kind: "direct-write-stale",
      message:
        "packing/collection.yaml and 1 more changed before your change reached ana@example.com. Check the new version, or send yours as a proposal.",
      retry: expect.any(Function),
      label: "Send as proposal",
    },
    {
      kind: "direct-write-refused",
      message:
        "The sync relay did not accept your change: trip/packing/automations.yaml changes an automation with a personal step. Send it as a proposal.",
      retry: expect.any(Function),
      label: "Send as proposal",
    },
  ]);
  notices[1]!.send?.run();
  expect(sendShareChanges).toHaveBeenCalledTimes(1);
});

it("names a new Collection by its folder", async () => {
  const { notices } = await setup();
  await answer({
    status: "pushed",
    writes: [{ result: "refused", paths: ["trip/ideas/collection.yaml", "trip/ideas/a.md"], reason: "" }],
  });
  expect(notices[0]!.message).toBe("The sync relay did not accept your change to ideas. Send it as a proposal.");
});

it("reports a record name race once and tells where the losing draft is kept", async () => {
  const { notices, refreshShareView } = await setup();
  await answer({ status: "pushed", writes: [{ result: "stale", paths: ["trip/packing/One.md"], stalePath: "trip/packing/One.md", recoveredDraftPath: "trip/packing/Record draft abc-2.txt" }] });
  await answer(NOTHING);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({
    kind: "direct-write-stale",
    retry: null,
    message: "packing/One.md is taken. Your text draft is kept in trip/packing/Record draft abc-2.txt on this computer. Use New record to create another record.",
  });
  expect(refreshShareView).toHaveBeenCalledOnce();
});

it("counts several refused writes and gives the first reason", async () => {
  const { notices } = await setup();
  const shownAtAcknowledge: number[] = [];
  delivery.acknowledge.mockImplementation(async () => {
    shownAtAcknowledge.push(notices.length);
    return true;
  });
  await answer({
    status: "pushed",
    writes: [
      { result: "refused", paths: ["trip/a/collection.yaml"], reason: "trip/a/collection.yaml is not a valid collection.yaml" },
      { result: "refused", paths: ["trip/b/collection.yaml"], reason: "trip/b/collection.yaml is not a valid collection.yaml" },
    ],
  });
  expect(notices[0]!.message).toBe(
    "The sync relay did not accept 2 of your changes: trip/a/collection.yaml is not a valid collection.yaml. Send them as a proposal.",
  );
  // Main forgets the answer only once its Notice is shown.
  await vi.waitFor(() => expect(delivery.acknowledge).toHaveBeenCalledOnce());
  expect(delivery.claim).toHaveBeenCalledOnce();
  expect(delivery.claim.mock.invocationCallOrder[0]!).toBeLessThan(delivery.acknowledge.mock.invocationCallOrder[0]!);
  expect(shownAtAcknowledge).toEqual([1]);
  expect(delivery.release).not.toHaveBeenCalled();
});

it("offers Try again for a failure that may pass, and keeps the writes answered before it", async () => {
  const { notices } = await setup();
  await answer({
    status: "failed",
    writes: [{ result: "refused", paths: ["trip/packing/automations.yaml"], reason: "" }],
    errorMessage: "The relay did not answer.",
    lasting: false,
  });
  expect(notices.map(({ kind, send }) => ({ kind, label: send?.label }))).toEqual([
    { kind: "direct-write-refused", label: "Send as proposal" },
    { kind: "direct-write-failed", label: undefined },
  ]);
  expect(notices[1]!.message).toBe("dohc could not send your Collection changes to ana@example.com. The relay did not answer.");
  await act(async () => { notices[1]!.retry?.(); await Promise.resolve(); });
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(2);
});

it("offers Send as proposal for a lasting refusal, keeping an earlier refusal's reason in the same row", async () => {
  const { notices } = await setup();
  await answer({ status: "failed", writes: [], errorMessage: "read only", lasting: true });
  await answer({
    status: "failed",
    writes: [{ result: "refused", paths: ["trip/a/collection.yaml"], reason: "trip/a/collection.yaml is not a valid collection.yaml" }],
    errorMessage: "read only",
    lasting: true,
  });
  expect(notices).toEqual([
    expect.objectContaining({
      kind: "direct-write-refused",
      message: "ana@example.com's share doesn't take your Collection changes directly. Send them as a proposal.",
      retry: expect.any(Function),
      send: expect.objectContaining({ label: "Send as proposal" }),
    }),
    expect.objectContaining({
      kind: "direct-write-refused",
      message: "The sync relay did not accept your change: trip/a/collection.yaml is not a valid collection.yaml. ana@example.com's share doesn't take your Collection changes directly. Send them as a proposal.",
    }),
  ]);
});

it("says the person's access ended once the metadata check finds the share ended", async () => {
  const { notices, checkShareAccess } = await setup({ opened: { status: "unavailable" }, ended: true });
  await vi.waitFor(() => expect(notices).toHaveLength(1));
  expect(notices).toEqual([{
    kind: "direct-write-unavailable",
    message: "Your access to this share ended. Your unsent Collection changes stay in this workspace. Ask ana@example.com to share it again.",
    retry: null,
    send: null,
  }]);
  expect(checkShareAccess).toHaveBeenCalledTimes(1);
});

it("says the changes did not go, with Try again, when the metadata check finds the share still open", async () => {
  const { notices, checkShareAccess } = await setup({ opened: { status: "unavailable" }, ended: false });
  await vi.waitFor(() => expect(notices).toHaveLength(1));
  expect(checkShareAccess).toHaveBeenCalledTimes(1);
  expect(notices[0]).toMatchObject({
    kind: "direct-write-failed",
    message: "dohc could not send your Collection changes to ana@example.com.",
    send: null,
  });
  const pushes = pushShareDirectWrites.mock.calls.length;
  await act(async () => { notices[0]!.retry?.(); });
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(pushes + 1);
});

it("ignores an answer that arrives after the view closed", async () => {
  let finish!: (result: PushShareDirectWritesResult) => void;
  pushShareDirectWrites.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = () => resolve(); }));
  const { notices, hook } = await setup();
  hook.unmount();
  await act(async () => {
    finish({ status: "failed", writes: [], errorMessage: "late", lasting: false });
  });
  expect(notices).toEqual([]);
});

it("keeps an unavailable push's pending refresh when writing stops in the same workspace", async () => {
  const refresh = deferred<ShareViewRefresh>();
  respond({ status: "unavailable" });
  const showNotice = vi.fn();
  const refreshShareView = vi.fn(() => refresh.promise);
  const hook = renderHook(({ enabled }) => useShareDirectWrites({
    sharedView: true, workspaceId: "share-view",
    enabled,
    ready: true,
    ownerName: "ana@example.com",
    refreshShareView,
    checkShareAccess: refreshShareView,
    sendShareChanges: async () => undefined,
    showNotice,
  }), { initialProps: { enabled: true } });
  await act(async () => {});
  expect(refreshShareView).toHaveBeenCalledOnce();
  hook.rerender({ enabled: false });
  await act(async () => { refresh.resolve("ended"); });
  expect(showNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: "direct-write-unavailable" }));
});

it("discards an unavailable push's pending refresh after A to B to A", async () => {
  const refresh = deferred<ShareViewRefresh>();
  respond({ status: "unavailable" });
  const showNotice = vi.fn();
  const hook = renderHook(({ workspaceId }) => useShareDirectWrites({
    sharedView: true, workspaceId, enabled: true, ready: true, ownerName: "ana@example.com",
    refreshShareView: () => refresh.promise,
    checkShareAccess: () => refresh.promise,
    sendShareChanges: async () => undefined, showNotice,
  }), { initialProps: { workspaceId: "share-view" } });
  await act(async () => {});
  hook.rerender({ workspaceId: "other" });
  hook.rerender({ workspaceId: "share-view" });
  await act(async () => { refresh.resolve("ended"); });
  expect(showNotice).not.toHaveBeenCalled();
});

it("does not retry a failure after the view closes", async () => {
  const { notices, hook } = await setup({
    opened: { status: "failed", writes: [], errorMessage: "offline", lasting: false },
  });
  expect(notices).toHaveLength(1);
  hook.unmount();
  await act(async () => { notices[0]!.retry?.(); });
  expect(pushShareDirectWrites).toHaveBeenCalledOnce();
});

it.each(["ended", "changed"] as const)("reports locally refused writes after access %s without a dead retry", async access => {
  const showNotice = vi.fn();
  const checkShareAccess = vi.fn(async () => access);
  renderHook(() => useShareDirectWrites({ sharedView: true, workspaceId: "share-view", enabled: false, ready: true, ownerName: "Ana",
    refreshShareView: async () => "stale", checkShareAccess, sendShareChanges: async () => undefined, showNotice }));
  await act(async () => pushed?.({ answerId: crypto.randomUUID(), workspaceId: "share-view", result: { status: "failed", writes: [], lasting: false, errorMessage: "access refused locally" } }, delivery));
  expect(checkShareAccess).toHaveBeenCalledOnce();
  expect(showNotice).toHaveBeenCalledOnce();
  expect(showNotice.mock.calls[0]![0]).toMatchObject({ retry: null, send: null });
  expect(showNotice.mock.calls[0]![0].message).toContain("Your unsent Collection changes stay in this workspace.");
});

it.each(["ended", "changed"] as const)("checks a relay refusal before showing exactly one %s notice", async access => {
  const { notices, checkShareAccess } = await setup();
  checkShareAccess.mockResolvedValue(access);
  await answer({ status: "failed", writes: [{ result: "refused", paths: ["tasks/new.md"], reason: "forbidden" }],
    lasting: true, errorMessage: "forbidden" });
  expect(checkShareAccess).toHaveBeenCalledOnce();
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ kind: "direct-write-unavailable", retry: null, send: null });
  expect(notices[0]!.message).toContain(`Your access to this share ${access}.`);
});
