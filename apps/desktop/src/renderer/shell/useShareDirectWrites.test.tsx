// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DohcDesktopBridge, PushShareDirectWritesResult, ShareDirectWritesPushedEvent } from "../../ipc/bridgeContract";
import { useShareDirectWrites, type DirectWriteNotice, type ShareViewRefresh } from "./useShareDirectWrites";

let pushed: ((event: ShareDirectWritesPushedEvent) => void) | null = null;
const pushShareDirectWrites = vi.fn<(payload: { workspaceId: string }) => Promise<PushShareDirectWritesResult>>();
const NOTHING: PushShareDirectWritesResult = { status: "pushed", writes: [] };

beforeEach(() => {
  pushed = null;
  pushShareDirectWrites.mockReset();
  pushShareDirectWrites.mockResolvedValue(NOTHING);
  window.dohcDesktop = {
    pushShareDirectWrites,
    onShareDirectWritesPushed: (listener: (event: ShareDirectWritesPushedEvent) => void) => {
      pushed = listener;
      return () => { pushed = null; };
    },
  } as unknown as DohcDesktopBridge;
});

afterEach(() => {
  cleanup();
  delete window.dohcDesktop;
});

async function setup(options: { enabled?: boolean; workspaceId?: string; opened?: PushShareDirectWritesResult; ended?: boolean } = {}) {
  const workspaceId = options.workspaceId ?? "share-view";
  if (options.opened) pushShareDirectWrites.mockResolvedValueOnce(options.opened);
  const notices: DirectWriteNotice[] = [];
  const refreshShareView = vi.fn(async (): Promise<ShareViewRefresh> => (options.ended ? "ended" : "current"));
  const sendShareChanges = vi.fn(async () => undefined);
  const hook = renderHook(() =>
    useShareDirectWrites({
      workspaceId,
      enabled: options.enabled ?? true,
      ownerName: "ana@example.com",
      refreshShareView,
      sendShareChanges,
      showNotice: (notice) => notices.push(notice),
    }),
  );
  // The push on open.
  await act(async () => { await Promise.resolve(); });
  return { notices, refreshShareView, sendShareChanges, hook };
}

function answer(result: PushShareDirectWritesResult, workspaceId = "share-view") {
  act(() => pushed?.({ workspaceId, result }));
}

it("pushes when the view opens and shows what that push answered", async () => {
  const { notices } = await setup({
    opened: { status: "pushed", writes: [{ result: "refused", paths: ["trip/packing/automations.yaml"], reason: "" }] },
  });
  expect(pushShareDirectWrites).toHaveBeenCalledWith({ workspaceId: "share-view" });
  expect(notices.map((notice) => notice.message)).toEqual([
    "ana@example.com's server didn't take your change to packing/automations.yaml. Send it as a proposal.",
  ]);
});

it("listens to nothing and pushes nothing when the share view cannot write", async () => {
  await setup({ enabled: false });
  expect(pushed).toBeNull();
  expect(pushShareDirectWrites).not.toHaveBeenCalled();
});

it("shows only the answers main reports for its own share view", async () => {
  const { notices, refreshShareView } = await setup();
  answer({ status: "pushed", writes: [{ result: "written", paths: ["trip/packing/collection.yaml"] }] });
  answer({ status: "pushed", writes: [{ result: "refused", paths: ["trip/a/collection.yaml"], reason: "" }] }, "other");
  expect(notices).toEqual([]);
  expect(refreshShareView).not.toHaveBeenCalled();
});

it("refreshes after a stale write and offers each unsent write as a proposal, with the relay's reason", async () => {
  const { notices, refreshShareView, sendShareChanges } = await setup();
  answer({
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
  answer({
    status: "pushed",
    writes: [{ result: "refused", paths: ["trip/ideas/collection.yaml", "trip/ideas/a.md"], reason: "" }],
  });
  expect(notices[0]!.message).toBe("ana@example.com's server didn't take your change to ideas. Send it as a proposal.");
});

it("counts several refused writes and gives the first reason", async () => {
  const { notices } = await setup();
  answer({
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

it("offers Try again for a failure that may pass, and keeps the writes answered before it", async () => {
  const { notices } = await setup();
  answer({
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
  answer({ status: "failed", writes: [], errorMessage: "read only", lasting: true });
  answer({
    status: "failed",
    writes: [{ result: "refused", paths: ["trip/a/collection.yaml"], reason: "trip/a/collection.yaml is not a valid collection.yaml" }],
    errorMessage: "read only",
    lasting: true,
  });
  expect(notices).toEqual([
    expect.objectContaining({
      kind: "direct-write-refused",
      message: "ana@example.com's share doesn't take your Collection changes directly. Send them as a proposal.",
      retry: null,
      send: expect.objectContaining({ label: "Send as proposal" }),
    }),
    expect.objectContaining({
      kind: "direct-write-refused",
      message: "ana@example.com's server didn't take your change: trip/a/collection.yaml is not a valid collection.yaml. ana@example.com's share doesn't take your Collection changes directly. Send them as a proposal.",
    }),
  ]);
});

it("says the person's access ended once the view's refresh finds the share ended", async () => {
  const { notices, refreshShareView } = await setup({ opened: { status: "unavailable" }, ended: true });
  await vi.waitFor(() => expect(notices).toHaveLength(1));
  expect(notices).toEqual([{
    kind: "direct-write-unavailable",
    message: "Your access to this share ended, so your Collection changes didn't reach ana@example.com. Ask ana@example.com to share it again.",
    retry: null,
    send: null,
  }]);
  expect(refreshShareView).toHaveBeenCalledTimes(1);
});

it("says the changes did not go, with Try again, when the refresh finds the share still open", async () => {
  const { notices, refreshShareView } = await setup({ opened: { status: "unavailable" }, ended: false });
  await vi.waitFor(() => expect(notices).toHaveLength(1));
  expect(refreshShareView).toHaveBeenCalledTimes(1);
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
  pushShareDirectWrites.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { notices, hook } = await setup();
  hook.unmount();
  await act(async () => {
    finish({ status: "failed", writes: [], errorMessage: "late", lasting: false });
  });
  expect(notices).toEqual([]);
});
