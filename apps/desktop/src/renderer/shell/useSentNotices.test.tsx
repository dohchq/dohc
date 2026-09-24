// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICE_MARK_BATCH_MAX, type MarkNoticesPayload, type NoticeRow } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { SENT_NOTICE_TOAST_MS, useSentNotices } from "./useSentNotices";

const ANA = "https://server.test#https://relay.test#ana";
const BEN = "https://server.test#https://relay.test#ben";

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

let account: string | null = ANA;
let listed: NoticeRow[] = [];
let emitChanged: (() => void) | null = null;
const bridge = {
  listNotices: vi.fn(async () => ({ account, notices: listed })),
  onNoticesChanged: vi.fn((listener: () => void) => {
    emitChanged = listener;
    return () => {
      emitChanged = null;
    };
  }),
  markNotices: vi.fn(async (_payload: MarkNoticesPayload) => undefined),
};

beforeEach(() => {
  account = ANA;
  listed = [];
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  bridge.listNotices.mockImplementation(async () => ({ account, notices: listed }));
  bridge.markNotices.mockImplementation(async () => undefined);
});

async function arrive(next: NoticeRow[], nextAccount: string | null = account) {
  listed = next;
  account = nextAccount;
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
    await waitFor(() => expect(result.current.settled).toBe(true));

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
    await waitFor(() => expect(result.current.settled).toBe(true));
    await arrive([notice("a")]);
    expect(result.current.toast?.noticeId).toBe("a");
    await act(async () => result.current.read([{ store: "account", noticeId: "a" }]));
    expect(result.current.toast).toBeNull();
  });

  it("shows a read and a dismissal at once and holds them until a list shows them", async () => {
    listed = [notice("a"), notice("b")];
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(result.current.notices).toHaveLength(2));
    const reading = deferred<undefined>();
    bridge.markNotices.mockImplementationOnce(() => reading.promise);
    const dismissing = deferred<undefined>();
    bridge.markNotices.mockImplementationOnce(() => dismissing.promise);

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
    expect(bridge.markNotices).toHaveBeenCalledWith({
      account: ANA, mark: "read", notices: [{ store: "account", noticeId: "a" }],
    });
    expect(bridge.markNotices).toHaveBeenCalledWith({
      account: ANA, mark: "dismissed", notices: [{ store: "account", noticeId: "b" }],
    });
  });

  it("brings a notice back when main refuses to dismiss it", async () => {
    listed = [notice("a")];
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(result.current.notices).toHaveLength(1));
    bridge.markNotices.mockRejectedValueOnce(new Error("disk full"));
    await act(async () => {
      await expect(result.current.dismiss({ store: "account", noticeId: "a" })).rejects.toThrow("disk full");
    });
    expect(result.current.notices.map((row) => row.noticeId)).toEqual(["a"]);
  });

  it("marks a long list read in batches main accepts", async () => {
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(result.current.settled).toBe(true));
    const refs = Array.from({ length: NOTICE_MARK_BATCH_MAX * 2 + 1 }, (_, index) => ({
      store: "local" as const,
      noticeId: `n${index}`,
    }));
    await act(async () => result.current.read(refs));
    expect(bridge.markNotices.mock.calls.map(([payload]) => [payload.account, payload.notices.length]))
      .toEqual([[ANA, NOTICE_MARK_BATCH_MAX], [ANA, NOTICE_MARK_BATCH_MAX], [ANA, 1]]);
  });

  it("keeps marks, the toast, and what it has seen to the account whose list showed them", async () => {
    const { result } = renderHook(() => useSentNotices(true));
    await waitFor(() => expect(result.current.settled).toBe(true));
    await arrive([notice("a"), notice("b")]);
    expect(result.current.toast?.noticeId).toBe("a");
    const reading = deferred<undefined>();
    bridge.markNotices.mockImplementationOnce(() => reading.promise);
    let read: Promise<void> = Promise.resolve();
    act(() => {
      read = result.current.read([{ store: "account", noticeId: "b" }]);
    });

    // Ben signs in. His notice "b" is his own and unread; his notices were
    // there before this window saw his list, so none of them toasts.
    await arrive([notice("c"), notice("b")], BEN);
    expect(result.current.notices.map((row) => [row.noticeId, row.readAtMs])).toEqual([["c", null], ["b", null]]);
    expect(result.current.toast).toBeNull();

    // The mark made on Ana's list still names Ana.
    await act(async () => {
      reading.resolve(undefined);
      await read;
    });
    expect(bridge.markNotices).toHaveBeenCalledWith({
      account: ANA, mark: "read", notices: [{ store: "account", noticeId: "b" }],
    });
    // Marks made now go out for Ben.
    await act(async () => result.current.dismiss({ store: "account", noticeId: "c" }));
    expect(bridge.markNotices).toHaveBeenLastCalledWith({
      account: BEN, mark: "dismissed", notices: [{ store: "account", noticeId: "c" }],
    });
  });

  it("is unsettled until the first list answers, and reports a failed list until one answers", async () => {
    const first = deferred<{ account: string | null; notices: NoticeRow[] }>();
    bridge.listNotices.mockImplementationOnce(() => first.promise);
    const { result } = renderHook(() => useSentNotices(true));
    expect(result.current.settled).toBe(false);

    const failure = new Error("notices file unreadable");
    await act(async () => first.reject(failure));
    expect(result.current.settled).toBe(true);
    expect(result.current.listFailure).toEqual({ error: failure });

    listed = [notice("a")];
    await act(async () => result.current.relist());
    expect(result.current.listFailure).toBeNull();
    expect(result.current.notices.map((row) => row.noticeId)).toEqual(["a"]);
  });

  it("asks main for nothing in a window that shows no workspace", () => {
    renderHook(() => useSentNotices(false));
    expect(bridge.listNotices).not.toHaveBeenCalled();
    expect(bridge.onNoticesChanged).not.toHaveBeenCalled();
  });
});
