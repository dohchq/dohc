import { describe, expect, it, vi } from "vitest";
import type { DirectConversation, DirectMessage } from "@dohc/security-contract/direct-messages";
import { DIRECT_INACTIVE_MESSAGE, directMessageOperations } from "../ipc/directMessageOperations";
import { DIRECT_START_INACTIVE_MESSAGE } from "../ipc/errorWords";
import { deferred } from "../testing/deferred";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { ipcWireError, readError } from "../ipc/errorWords";
import { CredentialSessionCache } from "./credentialSessionCache";
import { createDirectMessages, DirectMessageError, directScope } from "./directMessages";

interface Account {
  relayUrl?: string;
  userId: string;
  token?: string;
}

const message = (seq: number, body = `m${seq}`, authorId = "bob"): DirectMessage => ({
  seq,
  messageId: `id-${seq}`,
  authorId,
  authorName: "Bob",
  body,
  createdAtMs: seq * 1000,
});
const conversation = (last: DirectMessage, unread = 1): DirectConversation => ({
  conversationId: "c1",
  person: { personId: "bob", name: "Bob", blocked: false },
  last,
  unread,
});

function harness(
  options: {
    account?: Account | null;
    retryMs?: number;
    credentials?: () => Promise<Account | null>;
  } = {},
) {
  let account: Account | null =
    options.account === undefined
      ? { relayUrl: "https://relay.test", userId: "ann" }
      : options.account;
  let offline = false;
  const routes = new Map<string, () => Response | Promise<Response>>();
  const requests: string[] = [];
  const tokens: string[] = [];
  let changes = 0;
  let listedChanges = 0;
  let held: Promise<void> | null = null;
  let nextRead: "reject" | "signed-out" | null = null;
  const servers: string[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const service = createDirectMessages<Account>({
    credentials:
      options.credentials ??
      (async () => {
        await held;
        const once = nextRead;
        nextRead = null;
        if (once === "reject") throw new Error("the keychain did not answer");
        return once === "signed-out" ? null : account;
      }),
    relayResponse: async (credentials, path, init) => {
      requests.push(`${init.method ?? "GET"} ${path}`);
      servers.push(credentials.relayUrl ?? "");
      signals.push(init.signal);
      tokens.push(credentials.token ?? "");
      if (offline) throw new TypeError("fetch failed");
      // Like a server, answer on a later turn so a follow loop yields.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const route = routes.get(path.split("?")[0]!);
      if (!route) return Response.json({ error: "not found" }, { status: 404 });
      return route();
    },
    changed: () => {
      changes += 1;
    },
    listedChanged: () => {
      listedChanges += 1;
    },
    retryMs: options.retryMs ?? 1,
  });
  return {
    service,
    routes,
    requests,
    /** The server each request went to. */
    servers,
    signals,
    tokens,
    /** Holds every credential read until the returned function runs. */
    holdCredentials: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });
      return release;
    },
    /** The next credential read rejects, as when the keychain fails once, or finds nobody signed in. */
    nextCredentials: (how: "reject" | "signed-out") => {
      nextRead = how;
    },
    changes: () => changes,
    listedChanges: () => listedChanges,
    goOffline: () => {
      offline = true;
    },
    goOnline: () => {
      offline = false;
    },
    signInAs: (next: Account | null) => {
      account = next;
    },
  };
}

/** The account a window's list names, as main gives it. */
const viewer = (userId: string, relayUrl = "https://relay.test") => ({
  viewerId: userId,
  scope: directScope({ relayUrl, userId }),
});
const ANN = viewer("ann");
const ANN_ACCOUNT = { relayUrl: "https://relay.test", userId: "ann" };

describe("direct messages for the signed-in account", () => {
  it("fails plainly while the server is unreachable, with nothing kept on this computer", async () => {
    const h = harness();
    h.routes.set("/sync/direct/conversations", () =>
      Response.json({ revision: 3, conversations: [conversation(message(2))] }),
    );
    expect(await h.service.list()).toMatchObject({
      viewerId: "ann",
      conversations: [{ conversationId: "c1" }],
    });
    h.goOffline();
    await expect(h.service.list()).rejects.toMatchObject({ failure: "unreachable" });
    await expect(h.service.history(ANN, "c1")).rejects.toMatchObject({ failure: "unreachable" });
  });

  it("refuses a call that names an account no longer signed in, before it reaches the server", async () => {
    const h = harness();
    h.routes.set("/sync/direct/send", () => Response.json({ conversationId: "c1", seq: 1 }));
    // The window read Ann's list, then the account changed to Cat before its calls arrived.
    h.signInAs({ relayUrl: "https://relay.test", userId: "cat" });
    const calls = [
      h.service.send({
        viewer: ANN,
        conversationId: "c1",
        messageId: "m1",
        body: "for Ann's friend",
      }),
      h.service.history(ANN, "c1"),
      h.service.read(ANN, "c1", 1),
      h.service.block(ANN, "c1", true),
      h.service.resolve("ann", {
        person: { workspaceId: "w", memberId: "owner" },
        admitted: { relayUrl: "https://relay.test", userId: "ann" },
        assertCurrent: () => {},
      }),
    ];
    for (const call of calls) await expect(call).rejects.toMatchObject({ failure: "refused" });
    expect(h.requests).toEqual([]);
    // The account that is signed in still acts.
    expect(
      await h.service.send({
        viewer: viewer("cat"),
        conversationId: "c1",
        messageId: "m2",
        body: "hi",
      }),
    ).toEqual({ conversationId: "c1", seq: 1 });
  });

  it("sends a member pick only to the server main admitted it on", async () => {
    const h = harness();
    h.routes.set("/sync/direct/send", () => Response.json({ conversationId: "c1", seq: 1 }));
    const pick = {
      person: { workspaceId: "w", memberId: "owner" },
      admitted: { relayUrl: "https://relay.test", userId: "ann" },
      assertCurrent: () => {},
    };
    // Main admitted the pick for Ann on one server. Before the send read the
    // account, Ann signed in on another server that has the same ids.
    h.signInAs({ relayUrl: "https://other.test", userId: "ann" });
    await expect(
      h.service.send({
        viewerId: "ann",
        pick,
        messageId: "m1",
        body: "for the first server's owner",
      }),
    ).rejects.toMatchObject({ failure: "refused" });
    await expect(h.service.resolve("ann", pick)).rejects.toMatchObject({ failure: "refused" });
    expect(h.requests).toEqual([]);
    h.signInAs({ relayUrl: "https://relay.test", userId: "ann" });
    await expect(
      h.service.send({ viewerId: "ann", pick, messageId: "m2", body: "hi" }),
    ).resolves.toEqual({
      conversationId: "c1",
      seq: 1,
    });
    // The conversation that send started goes on, as the account the window's list named.
    await expect(
      h.service.send({ viewer: ANN, conversationId: "c1", messageId: "m3", body: "again" }),
    ).resolves.toEqual({ conversationId: "c1", seq: 1 });
    expect(h.requests).toEqual(["POST /sync/direct/send", "POST /sync/direct/send"]);
  });

  it("sends no member pick once its window changed workspaces while the account was read", async () => {
    const h = harness();
    h.routes.set("/sync/direct/send", () => Response.json({ conversationId: "c1", seq: 1 }));
    h.routes.set("/sync/direct/resolve", () =>
      Response.json({
        conversationId: null,
        person: { personId: "bob", name: "Bob", blocked: false },
      }),
    );
    let current = true;
    const pick = {
      person: { workspaceId: "w", memberId: "owner" },
      admitted: { relayUrl: "https://relay.test", userId: "ann" },
      // What main passes: the operation's own check, which throws once the window left the workspace.
      assertCurrent: () => {
        if (!current) throw new Error(DIRECT_INACTIVE_MESSAGE);
      },
    };
    const release = h.holdCredentials();
    const sending = h.service.send({
      viewerId: "ann",
      pick,
      messageId: "m1",
      body: "for the old workspace",
    });
    const resolving = h.service.resolve("ann", pick);
    current = false;
    release();
    await expect(sending).rejects.toThrow(DIRECT_INACTIVE_MESSAGE);
    await expect(resolving).rejects.toThrow(DIRECT_INACTIVE_MESSAGE);
    expect(h.requests).toEqual([]);
    // A window still on its workspace sends as before.
    current = true;
    await expect(
      h.service.send({ viewerId: "ann", pick, messageId: "m2", body: "hi" }),
    ).resolves.toEqual({
      conversationId: "c1",
      seq: 1,
    });
  });

  it("checks a member pick's window in the same turn its request leaves", async () => {
    const h = harness();
    h.routes.set("/sync/direct/send", () => Response.json({ conversationId: "c1", seq: 1 }));
    h.routes.set("/sync/direct/resolve", () =>
      Response.json({
        conversationId: null,
        person: { personId: "bob", name: "Bob", blocked: false },
      }),
    );
    // Requests already made by the time anything queued after the window check runs.
    const seen: number[] = [];
    const pick = {
      person: { workspaceId: "w", memberId: "owner" },
      admitted: { relayUrl: "https://relay.test", userId: "ann" },
      assertCurrent: () => {
        queueMicrotask(() => seen.push(h.requests.length));
      },
    };
    await h.service.resolve("ann", pick);
    await h.service.send({ viewerId: "ann", pick, messageId: "m1", body: "hi" });
    expect(seen).toEqual([1, 2]);
  });

  it("acts in a conversation only on the server whose list named it, even where another lists the same ids", async () => {
    const h = harness();
    h.routes.set("/sync/direct/conversations", () =>
      Response.json({ revision: 1, conversations: [conversation(message(1))] }),
    );
    h.routes.set("/sync/direct/send", () => Response.json({ conversationId: "c1", seq: 2 }));
    h.routes.set("/sync/direct/conversations/c1/messages", () =>
      Response.json({ conversationId: "c1", messages: [message(1)], more: false }),
    );
    h.routes.set("/sync/direct/conversations/c1/read", () => Response.json({ ok: true }));
    h.routes.set("/sync/direct/conversations/c1/block", () => Response.json({ ok: true }));
    // Both servers have Ann and c1, as when one server's store was copied to the other.
    const first = await h.service.list();
    h.signInAs({ relayUrl: "https://other.test", userId: "ann" });
    const second = await h.service.list();
    expect(second.conversations.map((entry) => entry.conversationId)).toEqual(["c1"]);
    const listed = h.servers.length;
    // An old window, or a notice's Try again, still carries the first server's list.
    const calls = [
      h.service.send({
        viewer: first,
        conversationId: "c1",
        messageId: "m1",
        body: "for the first server",
      }),
      h.service.history(first, "c1"),
      h.service.read(first, "c1", 1),
      h.service.block(first, "c1", true),
    ];
    for (const call of calls)
      await expect(call).rejects.toMatchObject({
        failure: "refused",
        message: "You signed in as someone else. Open Chats again to see their direct messages.",
      });
    expect(h.servers.slice(listed)).toEqual([]);
    // The second server's own list acts there.
    await expect(
      h.service.send({ viewer: second, conversationId: "c1", messageId: "m2", body: "hi" }),
    ).resolves.toEqual({ conversationId: "c1", seq: 2 });
    await h.service.history(second, "c1");
    await h.service.read(second, "c1", 1);
    await h.service.block(second, "c1", true);
    expect(h.servers.slice(listed)).toEqual(Array(4).fill("https://other.test"));
  });

  it("says a conversation is missing when its server has no such conversation", async () => {
    const h = harness();
    h.routes.set("/sync/direct/conversations", () =>
      Response.json({ revision: 1, conversations: [] }),
    );
    const listed = await h.service.list();
    await expect(h.service.history(listed, "gone")).rejects.toMatchObject({
      failure: "refused",
      status: 404,
      message: "dohc could not find this conversation or person. They may have left the workspace.",
    });
  });

  it("refuses as signed out without calling the server", async () => {
    const h = harness({ account: { userId: "ann" } });
    await expect(h.service.list()).rejects.toBeInstanceOf(DirectMessageError);
    await expect(h.service.list()).rejects.toMatchObject({ failure: "signed-out" });
    expect(h.requests).toEqual([]);
  });

  it("says plainly when the other person blocked the sender", async () => {
    const h = harness();
    h.routes.set("/sync/direct/send", () =>
      Response.json({ code: "direct_blocked", error: "blocked" }, { status: 403 }),
    );
    await expect(
      h.service.send({ viewer: ANN, conversationId: "c1", messageId: "m1", body: "hi" }),
    ).rejects.toMatchObject({
      failure: "refused",
      code: "direct_blocked",
      message: "You can't message this person.",
    });
  });

  it("refuses a file link before it reaches the server, with no Try again", async () => {
    const h = harness();
    h.routes.set("/sync/direct/send", () => Response.json({ conversationId: "c1", seq: 1 }));
    const refused = await h.service
      .send({
        viewer: ANN,
        conversationId: "c1",
        messageId: "m1",
        body: "Read @[notes/private.md]",
      })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(refused).toBeInstanceOf(DirectMessageError);
    const afterIpc = readError(
      new Error(
        `Error invoking remote method 'desktop:direct-send': ${String(ipcWireError(refused))}`,
      ),
    );
    expect(afterIpc).toMatchObject({
      words: "Files can't be linked in a direct message.",
      canRetry: false,
    });
    expect(h.requests).toEqual([]);
    await expect(
      h.service.send({
        viewerId: "ann",
        pick: {
          person: { workspaceId: "w", memberId: "bob" },
          admitted: { relayUrl: "https://relay.test", userId: "ann" },
          assertCurrent: () => {},
        },
        messageId: "m2",
        body: "Hello Bob",
      }),
    ).resolves.toEqual({ conversationId: "c1", seq: 1 });
    expect(h.requests).toEqual(["POST /sync/direct/send"]);
  });

  it("offers Try again only where trying again can help", async () => {
    // What the renderer reads: main's wire error, as Electron passes it on.
    const afterIpc = async (call: Promise<unknown>) => {
      const error = await call.then(
        () => null,
        (cause: unknown) => cause,
      );
      return readError(
        new Error(
          `Error invoking remote method 'desktop:direct-send': ${String(ipcWireError(error))}`,
        ),
      );
    };
    const send = (h: ReturnType<typeof harness>, as = ANN) =>
      h.service.send({ viewer: as, conversationId: "c1", messageId: "m1", body: "hi" });
    const h = harness();
    h.routes.set("/sync/direct/send", () =>
      Response.json({ code: "direct_blocked", error: "blocked" }, { status: 403 }),
    );
    expect(await afterIpc(send(h))).toMatchObject({
      words: "You can't message this person.",
      canRetry: false,
    });
    expect(await afterIpc(send(h, viewer("cat")))).toMatchObject({ canRetry: false });
    h.routes.set("/sync/direct/send", () => Response.json({ error: "busy" }, { status: 429 }));
    expect((await afterIpc(send(h))).canRetry).toBeUndefined();
    h.goOffline();
    expect(await afterIpc(send(h))).toMatchObject({
      words: "dohc could not reach your server. Check your connection.",
    });
    expect((await afterIpc(send(h))).canRetry).toBeUndefined();
    expect(await afterIpc(harness({ account: { userId: "ann" } }).service.list())).toMatchObject({
      canRetry: false,
    });
  });

  it("reads the list once per move for the windows and Notices, and again after this computer writes", async () => {
    const h = harness({ retryMs: 50 });
    let lists = 0;
    let unread = 1;
    h.routes.set("/sync/direct/activity", () => Response.json({ revision: 4 }));
    h.routes.set("/sync/direct/conversations", () => {
      lists += 1;
      return Response.json({ revision: 4, conversations: [conversation(message(2), unread)] });
    });
    h.routes.set("/sync/direct/conversations/c1/read", () => Response.json({ ok: true }));
    const stop = h.service.listen();
    await expect.poll(() => h.changes()).toBe(1);
    expect(h.listedChanges()).toBe(1);
    expect(h.service.listed(ANN_ACCOUNT)?.conversations[0]?.unread).toBe(1);
    // Another account's Notices never see Ann's list.
    expect(h.service.listed({ relayUrl: "https://relay.test", userId: "cat" })).toBeNull();
    // The same user id on another server is another account.
    expect(h.service.listed({ relayUrl: "https://other.test", userId: "ann" })).toBeNull();
    // A window's read right after is served from that read.
    await h.service.list();
    expect(lists).toBe(1);
    // A read mark changes the list, so the next read goes to the server.
    unread = 0;
    await h.service.read(ANN, "c1", 2);
    expect((await h.service.list()).conversations[0]?.unread).toBe(0);
    expect(lists).toBe(2);
    expect(h.service.listed(ANN_ACCOUNT)?.conversations[0]?.unread).toBe(0);
    stop();
  });

  it("keeps the newer list when an older read answers after it, so a read Notice stays cleared", async () => {
    const h = harness();
    const answers: Array<(response: Response) => void> = [];
    let activity = 0;
    h.routes.set("/sync/direct/activity", () =>
      activity++ === 0 ? Response.json({ revision: 1 }) : new Promise<Response>(() => {}),
    );
    h.routes.set(
      "/sync/direct/conversations",
      () => new Promise<Response>((resolve) => answers.push(resolve)),
    );
    const stop = h.service.listen();
    // The follow loop's read at revision 1 is on its way; a window's read overtakes it after a read mark.
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const windowRead = h.service.list();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!(Response.json({ revision: 2, conversations: [conversation(message(2), 0)] }));
    expect((await windowRead).conversations[0]!.unread).toBe(0);
    answers[0]!(Response.json({ revision: 1, conversations: [conversation(message(2), 1)] }));
    await vi.waitFor(() => expect(h.changes()).toBe(1));
    expect(h.service.listed(ANN_ACCOUNT)?.conversations[0]!.unread).toBe(0);
    stop();
  });

  it("takes a newer read's list even when the server's revision went backwards, as after a relay reset", async () => {
    const h = harness();
    let answer = { revision: 5, conversations: [conversation(message(2), 1)] };
    h.routes.set("/sync/direct/conversations", () => Response.json(answer));
    expect((await h.service.list()).conversations).toHaveLength(1);
    answer = { revision: 1, conversations: [] };
    expect((await h.service.list()).conversations).toEqual([]);
  });

  it("tells listeners when the account's revision moves, and stops when nobody listens", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let revision = 1;
      let polls = 0;
      h.routes.set("/sync/direct/activity", () => {
        polls += 1;
        if (polls === 3) revision = 2;
        return Response.json({ revision });
      });
      h.routes.set("/sync/direct/conversations", () =>
        Response.json({ revision, conversations: [] }),
      );
      const stop = h.service.listen();
      // The first answer, then the move to revision 2.
      while (h.changes() < 2) await vi.advanceTimersByTimeAsync(1);
      expect(h.changes()).toBe(2);
      stop();
      // Every activity request carries the loop's one signal, and stopping aborts it.
      const signals = h.signals.filter((signal) => signal !== undefined && signal !== null);
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      const after = h.requests.length;
      // A loop still running would keep setting timers, and this would never finish.
      await vi.runAllTimersAsync();
      expect(h.requests.length).toBe(after);
      expect(h.requests[0]).toBe("GET /sync/direct/activity?since=0&waitMs=0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spin when the server answers at once with nothing new", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ retryMs: 50 });
      let polls = 0;
      h.routes.set("/sync/direct/activity", () => {
        polls += 1;
        return Response.json({ revision: 7 });
      });
      h.routes.set("/sync/direct/conversations", () =>
        Response.json({ revision: 7, conversations: [] }),
      );
      const stop = h.service.listen();
      // The first answer is a change; the second has nothing new.
      while (polls < 2) await vi.advanceTimersByTimeAsync(1);
      // The next poll waits out the retry delay.
      await vi.advanceTimersByTimeAsync(45);
      expect(polls).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(polls).toBe(3);
      expect(h.changes()).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells listeners on each failure while the server is away, and once when it answers again", async () => {
    const h = harness();
    h.routes.set("/sync/direct/activity", () => Response.json({ revision: 7 }));
    h.routes.set("/sync/direct/conversations", () =>
      Response.json({ revision: 7, conversations: [] }),
    );
    const stop = h.service.listen();
    await expect.poll(() => h.changes()).toBe(1);
    h.goOffline();
    // Losing the server is a change, so an open conversation shows that it failed.
    await expect.poll(() => h.changes()).toBeGreaterThanOrEqual(3);
    // The window reads the list again on that change, and it fails rather than repeating the last answer.
    await expect(h.service.list()).rejects.toMatchObject({ failure: "unreachable" });
    h.goOnline();
    const offline = h.changes();
    await expect.poll(() => h.changes()).toBeGreaterThan(offline);
    // Back online with nothing new, it stops telling.
    const settled = h.changes();
    const from = h.requests.length;
    await expect.poll(() => h.requests.length).toBeGreaterThan(from + 2);
    expect(h.changes()).toBe(settled);
    stop();
  });

  it("follows with the newest token when the same account signs in again", async () => {
    const h = harness({ account: { relayUrl: "https://relay.test", userId: "ann", token: "old" } });
    h.routes.set("/sync/direct/activity", () => Response.json({ revision: 1 }));
    h.routes.set("/sync/direct/conversations", () =>
      Response.json({ revision: 1, conversations: [] }),
    );
    const stop = h.service.listen();
    await expect.poll(() => h.tokens.length).toBeGreaterThan(0);
    h.signInAs({ relayUrl: "https://relay.test", userId: "ann", token: "new" });
    const at = h.tokens.length;
    await expect.poll(() => h.tokens.slice(at).includes("new")).toBe(true);
    stop();
    expect(h.tokens.slice(at + 2).every((token) => token === "new")).toBe(true);
  });

  it("starts no follow for a listener that stopped while the account was still being read", async () => {
    const h = harness();
    h.routes.set("/sync/direct/activity", () => Response.json({ revision: 1 }));
    h.routes.set("/sync/direct/conversations", () =>
      Response.json({ revision: 1, conversations: [] }),
    );
    const release = h.holdCredentials();
    h.service.listen()();
    release();
    // Everything the follow loop would do before its first request runs on this turn's microtasks.
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.requests).toEqual([]);
    // A listener that stays still starts following.
    const stop = h.service.listen();
    await expect.poll(() => h.requests.length).toBeGreaterThan(0);
    stop();
  });

  it.each([
    ["fails once", "reject"],
    // The loop ends on that read. The follow it starts finds the same account back, so it must not think the loop still runs.
    ["finds nobody signed in, and the same account is back on the next read", "signed-out"],
  ] as const)("keeps one follow going after a read of the account %s", async (_, how) => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let polls = 0;
      let waiting = 0;
      h.routes.set("/sync/direct/activity", () => {
        polls += 1;
        if (polls === 1) return Response.json({ revision: 1 });
        if (polls === 2) {
          // Nothing new, so the loop pauses and reads the account again.
          h.nextCredentials(how);
          return Response.json({ revision: 1 });
        }
        waiting += 1;
        return new Promise<Response>(() => {});
      });
      h.routes.set("/sync/direct/conversations", () =>
        Response.json({ revision: 1, conversations: [] }),
      );
      const stop = h.service.listen();
      // A loop that is not waiting on the server always has a timer to run. Once none is left, every loop waits.
      await vi.runAllTimersAsync();
      expect(waiting).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows once a failed read of the account gives way, and a failed read stops no follow", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      let waiting = 0;
      h.routes.set("/sync/direct/activity", () => {
        waiting += 1;
        return new Promise<Response>(() => {});
      });
      // The read made as main starts listening fails, as when the keychain is not ready yet.
      h.nextCredentials("reject");
      const stop = h.service.listen();
      await vi.runAllTimersAsync();
      expect(waiting).toBe(1);
      // A failed read when the account may have changed leaves the running follow to read the account itself.
      h.nextCredentials("reject");
      h.service.accountChanged();
      await vi.runAllTimersAsync();
      expect(waiting).toBe(1);
      expect(h.signals.at(-1)?.aborted).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows once main's first read of the stored account fails and the next succeeds", async () => {
    vi.useFakeTimers();
    try {
      // Main reads the account through its credential cache.
      const cache = new CredentialSessionCache<Account>();
      let loads = 0;
      const load = async () => {
        loads += 1;
        if (loads === 1) throw new Error("the keychain did not answer");
        return { relayUrl: "https://relay.test", userId: "ann" };
      };
      const h = harness({
        credentials: () => cache.read(load),
      });
      let waiting = 0;
      h.routes.set("/sync/direct/activity", () => {
        waiting += 1;
        return new Promise<Response>(() => {});
      });
      const stop = h.service.listen();
      await vi.runAllTimersAsync();
      expect(loads).toBe(2);
      expect(waiting).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the last account's list once another signs in", async () => {
    const h = harness();
    h.routes.set("/sync/direct/activity", () => Response.json({ revision: 1 }));
    h.routes.set("/sync/direct/conversations", () =>
      Response.json({ revision: 1, conversations: [conversation(message(1))] }),
    );
    const stop = h.service.listen();
    await expect.poll(() => h.service.listed(ANN_ACCOUNT)).not.toBeNull();
    h.signInAs({ relayUrl: "https://relay.test", userId: "cat" });
    h.service.accountChanged();
    await expect.poll(() => h.service.listed(ANN_ACCOUNT)).toBeNull();
    stop();
  });

  it("says a first message may not have been sent when its window changes workspaces while the send is out", async () => {
    const h = harness();
    const answer = deferred<Response>();
    let posted = 0;
    h.routes.set("/sync/direct/send", () => {
      posted += 1;
      return answer.promise;
    });
    // Main runs directStart in the window's workspace operation, with the row's own words.
    let current = true;
    const attachmentId = Symbol("attachment");
    const run = createRendererWorkspaceOperationRunner<
      object,
      { workspaceId: string; attachmentId: symbol; rootPath: string },
      Record<string, never>,
      { workspaceId: string; attachmentId: symbol; isCurrent(): boolean }
    >({
      currentSession: () => ({ workspaceId: "w", attachmentId, isCurrent: () => current }),
      withPhysicalOperation: async (_workspaceId, work) =>
        work({
          workspace: { workspaceId: "w", attachmentId, rootPath: "C:/w" },
          state: {},
          signal: new AbortController().signal,
          assertCurrent: () => {},
        }),
    });
    const sending = run({}, "w", directMessageOperations.directStart.inactiveMessage, (operation) =>
      h.service.send({
        viewerId: "ann",
        pick: {
          person: { workspaceId: "w", memberId: "owner" },
          admitted: { relayUrl: "https://relay.test", userId: "ann" },
          assertCurrent: () => operation.assertCurrent(),
        },
        messageId: "m1",
        body: "hi",
      }),
    );
    await expect.poll(() => posted).toBe(1);
    current = false;
    answer.resolve(Response.json({ conversationId: "c1", seq: 1 }));
    await expect(sending).rejects.toThrow(DIRECT_START_INACTIVE_MESSAGE);
    expect(h.requests).toEqual(["POST /sync/direct/send"]);
  });
});
