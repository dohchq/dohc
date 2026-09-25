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

beforeEach(() => {
  vi.useFakeTimers();
  edited = null;
  pushShareDirectWrites.mockReset();
  pushShareDirectWrites.mockResolvedValue({ ok: true, writes: [] });
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

function setup(enabled = true) {
  const notices: DirectWriteNotice[] = [];
  const refreshShareView = vi.fn(async () => undefined);
  const sendShareChanges = vi.fn(async () => undefined);
  const hook = renderHook(() =>
    useShareDirectWrites({
      workspaceId: "share-view",
      enabled,
      ownerName: "ana@example.com",
      refreshShareView,
      sendShareChanges,
      showNotice: (notice) => notices.push(notice),
    }),
  );
  return { notices, refreshShareView, sendShareChanges, hook };
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DIRECT_WRITE_PUSH_DELAY_MS);
  });
}

it("pushes once after a burst of saves in its own share view", async () => {
  setup();
  act(() => {
    edited?.({ workspaceId: "share-view" });
    edited?.({ workspaceId: "other" });
    edited?.({ workspaceId: "share-view" });
  });
  await settle();
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(1);
  expect(pushShareDirectWrites).toHaveBeenCalledWith({ workspaceId: "share-view" });
});

it("listens to nothing when the share view cannot write", async () => {
  setup(false);
  expect(edited).toBeNull();
  await settle();
  expect(pushShareDirectWrites).not.toHaveBeenCalled();
});

it("stays quiet when every write went", async () => {
  pushShareDirectWrites.mockResolvedValue({
    ok: true,
    writes: [{ result: "written", paths: ["trip/packing/collection.yaml"] }],
  });
  const { notices, refreshShareView } = setup();
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  expect(notices).toEqual([]);
  expect(refreshShareView).not.toHaveBeenCalled();
});

it("refreshes after a stale write and offers each unsent write as a proposal", async () => {
  pushShareDirectWrites.mockResolvedValue({
    ok: true,
    writes: [
      { result: "stale", paths: ["trip/packing/collection.yaml"], stalePath: "trip/packing/collection.yaml" },
      {
        result: "stale",
        paths: ["trip/ideas/collection.yaml", "trip/ideas/a.md"],
        stalePath: "trip/ideas",
      },
      { result: "refused", paths: ["trip/packing/automations.yaml"], reason: "" },
    ],
  });
  const { notices, refreshShareView, sendShareChanges } = setup();
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  expect(refreshShareView).toHaveBeenCalledTimes(1);
  expect(notices.map(({ kind, message, retry }) => ({ kind, message, retry }))).toEqual([
    {
      kind: "direct-write-stale",
      message:
        "packing/collection.yaml and 1 more changed before your change reached ana@example.com. Check the new version, or send yours as a proposal.",
      retry: null,
    },
    {
      kind: "direct-write-refused",
      message:
        "dohc could not save your change to packing/automations.yaml directly. Send it to ana@example.com as a proposal.",
      retry: null,
    },
  ]);
  notices[1]!.sendAsProposal?.();
  expect(sendShareChanges).toHaveBeenCalledTimes(1);
});

it("names a new Collection by its folder", async () => {
  pushShareDirectWrites.mockResolvedValue({
    ok: true,
    writes: [{ result: "refused", paths: ["trip/ideas/collection.yaml", "trip/ideas/a.md"], reason: "" }],
  });
  const { notices } = setup();
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  expect(notices[0]!.message).toBe(
    "dohc could not save your change to ideas directly. Send it to ana@example.com as a proposal.",
  );
});

it("reports a failed push with Try again", async () => {
  pushShareDirectWrites.mockResolvedValueOnce({ ok: false, errorMessage: "The relay did not answer." });
  const { notices } = setup();
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  expect(notices).toEqual([
    expect.objectContaining({
      kind: "direct-write-failed",
      message: "dohc could not send your Collection changes to ana@example.com. The relay did not answer.",
      sendAsProposal: null,
    }),
  ]);
  await act(async () => {
    notices[0]!.retry?.();
    await vi.runOnlyPendingTimersAsync();
  });
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(2);
});

it("pushes again after a push that was running when another save came", async () => {
  let finish!: (result: PushShareDirectWritesResult) => void;
  pushShareDirectWrites.mockImplementationOnce(
    () => new Promise((resolve) => { finish = resolve; }),
  );
  setup();
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({ ok: true, writes: [] });
    await vi.runOnlyPendingTimersAsync();
  });
  expect(pushShareDirectWrites).toHaveBeenCalledTimes(2);
});

it("ignores an answer that arrives after the view closed", async () => {
  let finish!: (result: PushShareDirectWritesResult) => void;
  pushShareDirectWrites.mockImplementationOnce(
    () => new Promise((resolve) => { finish = resolve; }),
  );
  const { notices, hook } = setup();
  act(() => edited?.({ workspaceId: "share-view" }));
  await settle();
  hook.unmount();
  await act(async () => {
    finish({ ok: false, errorMessage: "late" });
  });
  expect(notices).toEqual([]);
});
