// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICE_READ_BATCH_MAX, type NoticeRef, type NoticeRow } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { SENT_NOTICE_TOAST_MS, useSentNotices } from "./useSentNotices";

function notice(noticeId: string, overrides: Partial<NoticeRow> = {}): NoticeRow {
  return {
    store: "account",
    noticeId,
    kind: "agent-run",
    workspaceId: "trip",
    recipientShareId: null,
    senderKind: "agent",
    senderLabel: "Ana",
    title: `Notice ${noticeId}`,
    body: "",
    target: {},
    createdAtMs: Date.now() - 1_000,
    readAtMs: null,
    ...overrides,
  };
}

let listed: NoticeRow[] = [];
let emitChanged: (() => void) | null = null;
const bridge = {
  listNotices: vi.fn(async () => ({ notices: listed })),
  onNoticesChanged: vi.fn((listener: () => void) => {
    emitChanged = listener;
    return () => {
      emitChanged = null;
    };
  }),
  readNotices: vi.fn(async (_payload: { notices: NoticeRef[] }) => undefined),
  dismissNotice: vi.fn(async (_payload: NoticeRef) => undefined),
};

beforeEach(() => {
  listed = [];
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  bridge.readNotices.mockImplementation(async () => undefined);
  bridge.dismissNotice.mockImplementation(async () => undefined);
});

async function arrive(next: NoticeRow[]) {
  listed = next;
  await act(async () => emitChanged?.());
}

describe("sent notices in a window", () => {
  it("gives no toast for what was already there when the window opened", async () => {
    listed = [notice("before")];
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(result.current.notices).toHaveLength(1));
    expect(result.current.toast).toBeNull();
  });

  it("toasts the newest recent unread arrival, never an old or read one", async () => {
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(bridge.listNotices).toHaveBeenCalledTimes(1));

    await arrive([
      notice("old", { createdAtMs: Date.now() - SENT_NOTICE_TOAST_MS - 1 }),
      notice("read", { readAtMs: Date.now() }),
    ]);
    expect(result.current.notices).toHaveLength(2);
    expect(result.current.toast).toBeNull();

    // Main lists newest first.
    await arrive([notice("newest"), notice("newer"), ...listed]);
    expect(result.current.toast?.noticeId).toBe("newest");

    // One at a time: the next arrival takes the toast.
    await arrive([notice("next"), ...listed]);
    expect(result.current.toast?.noticeId).toBe("next");
    act(() => result.current.hideToast());
    expect(result.current.toast).toBeNull();
  });

  it("drops the toast once its notice is read", async () => {
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(bridge.listNotices).toHaveBeenCalledTimes(1));
    await arrive([notice("a")]);
    expect(result.current.toast?.noticeId).toBe("a");
    await act(async () => result.current.read([{ store: "account", noticeId: "a" }]));
    expect(result.current.toast).toBeNull();
  });

  it("shows a read and a dismissal at once and holds them until main has them", async () => {
    listed = [notice("a"), notice("b")];
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(result.current.notices).toHaveLength(2));
    const reading = deferred<undefined>();
    bridge.readNotices.mockImplementationOnce(() => reading.promise);
    const dismissing = deferred<undefined>();
    bridge.dismissNotice.mockImplementationOnce(() => dismissing.promise);

    let read: Promise<void> = Promise.resolve();
    let dismissed: Promise<void> = Promise.resolve();
    act(() => {
      read = result.current.read([{ store: "account", noticeId: "a" }]);
      dismissed = result.current.dismiss({ store: "account", noticeId: "b" });
    });
    expect(result.current.notices.map((row) => [row.noticeId, row.readAtMs !== null])).toEqual([["a", true]]);

    // A list that left before main had the marks does not undo them.
    await act(async () => emitChanged?.());
    expect(result.current.notices.map((row) => [row.noticeId, row.readAtMs !== null])).toEqual([["a", true]]);

    listed = [notice("a", { readAtMs: Date.now() })];
    await act(async () => {
      reading.resolve(undefined);
      dismissing.resolve(undefined);
      await Promise.all([read, dismissed]);
    });
    expect(result.current.notices.map((row) => [row.noticeId, row.readAtMs !== null])).toEqual([["a", true]]);
    expect(bridge.readNotices).toHaveBeenCalledWith({ notices: [{ store: "account", noticeId: "a" }] });
    expect(bridge.dismissNotice).toHaveBeenCalledWith({ store: "account", noticeId: "b" });
  });

  it("brings a notice back when main refuses to dismiss it", async () => {
    listed = [notice("a")];
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(result.current.notices).toHaveLength(1));
    bridge.dismissNotice.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      await expect(result.current.dismiss({ store: "account", noticeId: "a" })).rejects.toThrow("disk full");
    });
    expect(result.current.notices.map((row) => row.noticeId)).toEqual(["a"]);
  });

  it("marks a long list read in batches main accepts", async () => {
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(bridge.listNotices).toHaveBeenCalledTimes(1));
    const refs = Array.from({ length: NOTICE_READ_BATCH_MAX * 2 + 1 }, (_, index) => ({
      store: "local" as const,
      noticeId: `n${index}`,
    }));
    await act(async () => result.current.read(refs));
    expect(bridge.readNotices.mock.calls.map(([payload]) => payload.notices.length))
      .toEqual([NOTICE_READ_BATCH_MAX, NOTICE_READ_BATCH_MAX, 1]);
  });

  it("asks main for nothing in a window that shows no workspace", () => {
    renderHook(() => useSentNotices(false));
    expect(bridge.listNotices).not.toHaveBeenCalled();
    expect(bridge.onNoticesChanged).not.toHaveBeenCalled();
  });
});
