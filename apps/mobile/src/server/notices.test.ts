import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerClient, REQUEST_TIMEOUT_MS, type Fetch } from "./client";
import { noticePage, readNotices, sendNoticeMarks } from "./notices";
import { noticePageBody, relayRow } from "./testServer";

const ORIGIN = "https://dohc.example.com";

const page = (notices: unknown[], fields: Record<string, unknown> = {}) =>
  noticePageBody(notices, { nextCursor: "7", ...fields });

afterEach(() => void vi.useRealTimers());

describe("a page of Notices", () => {
  it("keeps only a removed row's ID and sequence", () => {
    const removed = relayRow("gone", { removed: true, title: "", changeSeq: 9 });
    expect(noticePage(page([removed]))?.changes).toEqual([
      { gone: true, noticeId: "gone", changeSeq: 9 },
    ]);
  });

  it("drops a row of a kind this build doesn't know, as a removal", () => {
    expect(noticePage(page([relayRow("new", { kind: "future-kind" })]))?.changes).toEqual([
      { gone: true, noticeId: "new", changeSeq: 1 },
    ]);
  });

  it("refuses the whole page when one live row is malformed", () => {
    expect(noticePage(page([relayRow("a"), relayRow("b", { title: "" })]))).toBeNull();
    expect(noticePage(page([relayRow("a", { workspaceId: null })]))).toBeNull();
    expect(noticePage(page([relayRow("a", { recipientShareId: "s1" })]))).toBeNull();
    expect(noticePage(page([relayRow("a", { target: { secret: "x" } })]))).toBeNull();
    expect(noticePage(page([relayRow("a", { readAtMs: "soon" })]))).toBeNull();
    expect(noticePage(page([], { hasMore: "yes" }))).toBeNull();
  });

  it("keeps a live row's fields, and none of the sender's IDs", () => {
    const [change] = noticePage(page([relayRow("a")]))?.changes ?? [];
    expect(change).toEqual({
      gone: false,
      record: {
        noticeId: "a",
        changeSeq: 1,
        workspaceId: "w1",
        recipientShareId: null,
        kind: "agent-run",
        senderKind: "agent",
        senderLabel: "Nova",
        title: "Nova replied (a)",
        body: "The train leaves at 8:09.",
        target: { thread: "thread-1", message: "m-1" },
        createdAtMs: 1000,
        readAtMs: null,
        dismissedAtMs: null,
        expiresAtMs: 10_000_000,
      },
    });
  });
});

describe("reading and marking Notices", () => {
  function client(fetch: Fetch) {
    return createServerClient({
      origin: ORIGIN,
      token: "t",
      fetch,
      signal: new AbortController().signal,
    });
  }

  it("asks for the phone's scope, with an encoded cursor and the wait only when given", async () => {
    const urls: string[] = [];
    const fetch: Fetch = async (url) => {
      urls.push(url);
      return { status: 200, json: async () => page([]) };
    };
    const signal = new AbortController().signal;
    await readNotices(client(fetch), { cursor: null, waitMs: 0 }, signal);
    await readNotices(client(fetch), { cursor: "4.9", waitMs: 0 }, signal);
    await readNotices(client(fetch), { cursor: "12", waitMs: 25_000 }, signal);
    expect(urls).toEqual([
      `${ORIGIN}/sync/notices?scope=phone&limit=100`,
      `${ORIGIN}/sync/notices?scope=phone&limit=100&cursor=4.9`,
      `${ORIGIN}/sync/notices?scope=phone&limit=100&cursor=12&wait=25000`,
    ]);
  });

  it("gives a held read its wait plus the usual timeout before it counts as offline", async () => {
    vi.useFakeTimers();
    const fetch: Fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const read = readNotices(
      client(fetch),
      { cursor: "12", waitMs: 25_000 },
      new AbortController().signal,
    );
    const settled = vi.fn();
    read.then(settled, settled);
    await vi.advanceTimersByTimeAsync(25_000 + REQUEST_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).rejects.toMatchObject({ problem: "offline" });
  });

  it("sends exactly the marks, in the phone's scope", async () => {
    const sent: { url: string; body: string | undefined }[] = [];
    const fetch: Fetch = async (url, init) => {
      sent.push({ url, body: init.body });
      return { status: 200, json: async () => ({ ok: true, dismissed: [] }) };
    };
    await sendNoticeMarks(
      client(fetch),
      [{ noticeId: "a", mark: "restore" }],
      new AbortController().signal,
    );
    expect(sent).toEqual([
      {
        url: `${ORIGIN}/sync/notices/marks?scope=phone`,
        body: JSON.stringify({ marks: [{ noticeId: "a", mark: "restore" }] }),
      },
    ]);
  });
});
