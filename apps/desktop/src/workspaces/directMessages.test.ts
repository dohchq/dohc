import { describe, expect, it, vi } from "vitest";
import type { DirectConversation, DirectMessage } from "@dohc/security-contract/direct-messages";
import { ipcWireError, readError } from "../ipc/errorWords";
import { createDirectMessages, DirectMessageError } from "./directMessages";

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

function harness(options: { account?: Account | null; retryMs?: number } = {}) {
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
  const service = createDirectMessages<Account>({
    credentials: async () => account,
    relayResponse: async (credentials, path, init) => {
      requests.push(`${init.method ?? "GET"} ${path}`);
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
    tokens,
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
    await expect(h.service.history("ann", "c1")).rejects.toMatchObject({ failure: "unreachable" });
  });

  it("refuses a call that names an account no longer signed in, before it reaches the server", async () => {
    const h = harness();
    h.routes.set("/sync/direct/send", () => Response.json({ conversationId: "c1", seq: 1 }));
    // The window read Ann's list, then the account changed to Cat before its calls arrived.
    h.signInAs({ relayUrl: "https://relay.test", userId: "cat" });
    const calls = [
      h.service.send("ann", { conversationId: "c1", messageId: "m1", body: "for Ann's friend" }),
      h.service.history("ann", "c1"),
      h.service.read("ann", "c1", 1),
      h.service.block("ann", "c1", true),
      h.service.resolve("ann", { workspaceId: "w", memberId: "owner" }),
    ];
    for (const call of calls) await expect(call).rejects.toMatchObject({ failure: "refused" });
    expect(h.requests).toEqual([]);
    // The account that is signed in still acts.
    expect(
      await h.service.send("cat", { conversationId: "c1", messageId: "m2", body: "hi" }),
    ).toEqual({ conversationId: "c1", seq: 1 });
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
      h.service.send("ann", { conversationId: "c1", messageId: "m1", body: "hi" }),
    ).rejects.toMatchObject({
      failure: "refused",
      code: "direct_blocked",
      message: "You can't message this person.",
    });
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
    const send = (h: ReturnType<typeof harness>, as = "ann") =>
      h.service.send(as, { conversationId: "c1", messageId: "m1", body: "hi" });
    const h = harness();
    h.routes.set("/sync/direct/send", () =>
      Response.json({ code: "direct_blocked", error: "blocked" }, { status: 403 }),
    );
    expect(await afterIpc(send(h))).toMatchObject({
      words: "You can't message this person.",
      canRetry: false,
    });
    expect(await afterIpc(send(h, "cat"))).toMatchObject({ canRetry: false });
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
    expect(h.service.listed("ann")?.conversations[0]?.unread).toBe(1);
    // Another account's Notices never see Ann's list.
    expect(h.service.listed("cat")).toBeNull();
    // A window's read right after is served from that read.
    await h.service.list();
    expect(lists).toBe(1);
    // A read mark changes the list, so the next read goes to the server.
    unread = 0;
    await h.service.read("ann", "c1", 2);
    expect((await h.service.list()).conversations[0]?.unread).toBe(0);
    expect(lists).toBe(2);
    expect(h.service.listed("ann")?.conversations[0]?.unread).toBe(0);
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
    expect(h.service.listed("ann")?.conversations[0]!.unread).toBe(0);
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
    await expect.poll(() => h.changes()).toBe(2);
    stop();
    const after = polls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(polls - after).toBeLessThanOrEqual(1);
    expect(h.requests[0]).toBe("GET /sync/direct/activity?since=0&waitMs=0");
  });

  it("does not spin when the server answers at once with nothing new", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(5);
    expect(h.changes()).toBe(1);
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

  it("forgets the last account's list once another signs in", async () => {
    const h = harness();
    h.routes.set("/sync/direct/activity", () => Response.json({ revision: 1 }));
    h.routes.set("/sync/direct/conversations", () =>
      Response.json({ revision: 1, conversations: [conversation(message(1))] }),
    );
    const stop = h.service.listen();
    await expect.poll(() => h.service.listed("ann")).not.toBeNull();
    h.signInAs({ relayUrl: "https://relay.test", userId: "cat" });
    h.service.accountChanged();
    await expect.poll(() => h.service.listed("ann")).toBeNull();
    stop();
  });
});
