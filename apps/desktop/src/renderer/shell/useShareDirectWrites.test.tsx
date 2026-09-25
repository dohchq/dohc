// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, PushShareDirectWritesResult } from "../../ipc/bridgeContract";
import {
  DIRECT_WRITE_PUSH_DELAY_MS,
  useShareDirectWrites,
  type DirectWriteNotice,
} from "./useShareDirectWrites";

let edited: ((event: { workspaceId: string }) => void) | null = null;
const pushShareDirectWrites = vi.fn<(payload: { workspaceId: string }) => Promise<PushShareDirectWritesResult>>();
const NOTHING: PushShareDirectWritesResult = { status: "pushed", writes: [] };

beforeEach(() => {
  vi.useFakeTimers();
  edited = null;
  pushShareDirectWrites.mockReset();
  pushShareDirectWrites.mockResolvedValue(NOTHING);
  window.dohcDesktop = {
    pushShareDirectWrites,
    onShareViewEdited: (listener: (event: { workspaceId: string }) => void) => {
      edited = listener;
      return () => { edited = null; };
    },
  } as unknown as DohcDesktopBridge;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.dohcDesktop;
});

async function setup(enabled = true, workspaceId = "share-view") {
  const notices: DirectWriteNotice[] = [];
  const refreshShareView = vi.fn(async () => undefined);
  const sendShareChanges = vi.fn(async () => undefined);
  const hook = renderHook(() =>
    useShareDirectWrites({
      workspaceId,
      enabled,
      ownerName: "ana@example.com",
      refreshShareView,
      sendShareChanges,
      showNotice: (notice) => notices.push(notice),
    }),
  );
  // The push on open.
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  pushShareDirectWrites.mockClear();
  return { notices, refreshShareView, sendShareChanges, hook };
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  });
}

async function saved(result: PushShareDirectWritesResult, workspaceId = "share-view") {
  pushShareDirectWrites.mockResolvedValueOnce(result);
  act(() => edited?.({ workspaceId }));
  await settle();
}

it("pushes when the view opens, so a save a workspace switch cut off goes", async () => {
  renderHook(() =>
    useShareDirectWrites({
      workspaceId: "share-view", enabled: true, ownerName: "ana@example.com",
      refreshShareView: vi.fn(), sendShareChanges: vi.fn(), showNotice: vi.fn(),
    }),
  );
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  expect(pushShareDirectWrites).toHaveBeenCalledWith({ workspaceId: "share-view" });
});

it("pushes once after a burst of saves in its own share view", async () => {
  await setup();
  act(() => {
    edited?.({ workspaceId: "share-view" });
    edited?.({ workspaceId: "other" });
    edited?.({ workspaceId: "share-view" });
  });
  await settle();
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(1);
});

it("listens to nothing and pushes nothing when the share view cannot write", async () => {
  await setup(false);
  expect(edited).toBeNull();
  expect(pushShareDirectWrites).not.toHaveBeenCalled();
});

it("stays quiet when every write went", async () => {
  const { notices, refreshShareView } = await setup();
  await saved({ status: "pushed", writes: [{ result: "written", paths: ["trip/packing/collection.yaml"] }] });
  expect(notices).toEqual([]);
  expect(refreshShareView).not.toHaveBeenCalled();
});

it("refreshes after a stale write and offers each unsent write as a proposal, with the relay's reason", async () => {
  const { notices, refreshShareView, sendShareChanges } = await setup();
  await saved({
    status: "pushed",
    writes: [
      { result: "stale", paths: ["trip/packing/collection.yaml"], stalePath: "trip/packing/collection.yaml" },
      { result: "stale", paths: ["trip/ideas/collection.yaml", "trip/ideas/a.md"], stalePath: "trip/ideas" },
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
      retry: null,
      label: "Send as proposal",
    },
    {
      kind: "direct-write-refused",
      message:
        "ana@example.com's server didn't take your change: trip/packing/automations.yaml changes an automation with a personal step. Send it as a proposal.",
      retry: null,
      label: "Send as proposal",
    },
  ]);
  notices[1]!.send?.run();
  expect(sendShareChanges).toHaveBeenCalledTimes(1);
});

it("names a new Collection by its folder", async () => {
  const { notices } = await setup();
  await saved({
    status: "pushed",
    writes: [{ result: "refused", paths: ["trip/ideas/collection.yaml", "trip/ideas/a.md"], reason: "" }],
  });
  expect(notices[0]!.message).toBe("ana@example.com's server didn't take your change to ideas. Send it as a proposal.");
});

it("offers Try again for a failure that may pass, and keeps the writes answered before it", async () => {
  const { notices } = await setup();
  await saved({
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
  await act(async () => {
    notices[1]!.retry?.();
    await vi.runOnlyPendingTimersAsync();
  });
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(2);
});

it("offers Send as proposal for a lasting refusal, such as a grant that is not Edit", async () => {
  const { notices } = await setup();
  await saved({ status: "failed", writes: [], errorMessage: "read only", lasting: true });
  expect(notices).toEqual([expect.objectContaining({
    kind: "direct-write-refused",
    message: "ana@example.com's share doesn't take your Collection changes directly. Send them as a proposal.",
    retry: null,
    send: expect.objectContaining({ label: "Send as proposal" }),
  })]);
});

it("counts several refused writes and gives the first reason", async () => {
  const { notices } = await setup();
  await saved({
    status: "pushed",
    writes: [
      { result: "refused", paths: ["trip/a/collection.yaml"], reason: "trip/a/collection.yaml is not a valid collection.yaml" },
      { result: "refused", paths: ["trip/b/collection.yaml"], reason: "trip/b/collection.yaml is not a valid collection.yaml" },
    ],
  });
  expect(notices[0]!.message).toBe(
    "ana@example.com's server didn't take 2 of your changes: trip/a/collection.yaml is not a valid collection.yaml. Send them as a proposal.",
  );
});

it("says once that the server takes no direct changes, offers Send changes, and stops asking", async () => {
  const { notices, sendShareChanges, hook } = await setup(true, "lane-off-view");
  await saved({ status: "unavailable" }, "lane-off-view");
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(1);
  act(() => edited?.({ workspaceId: "lane-off-view" }));
  await settle();
  hook.unmount();
  pushShareDirectWrites.mockClear();
  // Opening the view again pushes nothing, on open or after a save.
  renderHook(() =>
    useShareDirectWrites({
      workspaceId: "lane-off-view", enabled: true, ownerName: "ana@example.com",
      refreshShareView: vi.fn(), sendShareChanges: vi.fn(), showNotice: vi.fn(),
    }),
  );
  await act(async () => { await vi.runOnlyPendingTimersAsync(); });
  act(() => edited?.({ workspaceId: "lane-off-view" }));
  await settle();
  expect(pushShareDirectWrites).not.toHaveBeenCalled();
  expect(notices).toEqual([expect.objectContaining({
    kind: "direct-write-unavailable",
    message: "ana@example.com's server doesn't take Collection changes directly. Send your changes for ana@example.com to review.",
    send: expect.objectContaining({ label: "Send changes" }),
  })]);
  notices[0]!.send?.run();
  expect(sendShareChanges).toHaveBeenCalledTimes(1);
});

it("pushes again after a push that was running when another save came", async () => {
  await setup();
  let finish!: (result: PushShareDirectWritesResult) => void;
  pushShareDirectWrites.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(NOTHING);
    await vi.runOnlyPendingTimersAsync();
  });
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(2);
});

it("ignores an answer that arrives after the view closed", async () => {
  const { notices, hook } = await setup();
  let finish!: (result: PushShareDirectWritesResult) => void;
  pushShareDirectWrites.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  hook.unmount();
  await act(async () => {
    finish({ status: "failed", writes: [], errorMessage: "late", lasting: false });
  });
  expect(notices).toEqual([]);
});
