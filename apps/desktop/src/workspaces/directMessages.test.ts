import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DirectConversation, DirectMessage } from "@dohc/security-contract/direct-messages";
import { createDirectMessages, DirectMessageError } from "./directMessages";

interface Account { relayUrl?: string; userId: string; token?: string }

const message = (seq: number, body = `m${seq}`): DirectMessage => ({
  seq, messageId: `id-${seq}`, authorId: "bob", authorName: "Bob", body, createdAtMs: seq * 1000,
});
const conversation = (last: DirectMessage | null): DirectConversation => ({
  conversationId: "c1", people: [{ personId: "bob", name: "Bob", blocked: false }], last, unread: last ? 1 : 0, blocked: false,
});

let stateDir: string;
beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), "dohc-direct-")); });
afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

function harness(options: { account?: Account | null; retryMs?: number } = {}) {
  let account: Account | null = options.account === undefined ? { relayUrl: "https://relay.test", userId: "ann" } : options.account;
  let offline = false;
  const routes = new Map<string, () => Response>();
  const requests: string[] = [];
  const tokens: string[] = [];
  let changes = 0;
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
    stateDir: () => stateDir,
    changed: () => { changes += 1; },
    retryMs: options.retryMs ?? 1,
  });
  return {
    service, routes, requests, tokens,
    changes: () => changes,
    goOffline: () => { offline = true; },
    goOnline: () => { offline = false; },
    signInAs: (next: Account | null) => { account = next; },
  };
}

describe("direct messages on this computer", () => {
  it("shows the saved list and history when the server is unreachable", async () => {
    const h = harness();
    h.routes.set("/sync/direct/conversations", () => Response.json({ revision: 3, conversations: [conversation(message(2))] }));
    h.routes.set("/sync/direct/conversations/c1/messages", () => Response.json({ conversationId: "c1", messages: [message(1), message(2)], more: false }));

    expect(await h.service.list()).toMatchObject({ saved: false, conversations: [{ conversationId: "c1" }] });
    expect((await h.service.history("c1")).messages.map((entry) => entry.seq)).toEqual([1, 2]);

    h.goOffline();
    expect(await h.service.list()).toMatchObject({ saved: true, conversations: [{ conversationId: "c1" }] });
    expect(await h.service.history("c1")).toMatchObject({ saved: true, more: false, messages: [{ seq: 1 }, { seq: 2 }] });
    expect((await h.service.history("c1", 2)).messages.map((entry) => entry.seq)).toEqual([1]);
  });

  it("merges older pages into the saved copy by seq", async () => {
    const h = harness();
    let page = { conversationId: "c1", messages: [message(3), message(4)], more: true };
    h.routes.set("/sync/direct/conversations/c1/messages", () => Response.json(page));
    await h.service.history("c1");
    page = { conversationId: "c1", messages: [message(1), message(2), message(3, "edited copy")], more: false };
    await h.service.history("c1", 3);

    h.goOffline();
    const saved = await h.service.history("c1");
    expect(saved.messages.map((entry) => [entry.seq, entry.body])).toEqual([[1, "m1"], [2, "m2"], [3, "edited copy"], [4, "m4"]]);
  });

  it("keeps each account's copy apart", async () => {
    const h = harness();
    h.routes.set("/sync/direct/conversations", () => Response.json({ revision: 1, conversations: [conversation(message(1))] }));
    await h.service.list();

    h.signInAs({ relayUrl: "https://relay.test", userId: "cat" });
    h.goOffline();
    await expect(h.service.list()).rejects.toMatchObject({ failure: "unreachable" });
  });

  it("refuses as signed out without calling the server", async () => {
    const h = harness({ account: { userId: "ann" } });
    await expect(h.service.list()).rejects.toBeInstanceOf(DirectMessageError);
    await expect(h.service.list()).rejects.toMatchObject({ failure: "signed-out" });
    expect(h.requests).toEqual([]);
  });

  it("says plainly when the other person blocked the sender", async () => {
    const h = harness();
    h.routes.set("/sync/direct/send", () => Response.json({ code: "direct_blocked", error: "blocked" }, { status: 403 }));
    await expect(h.service.send({ conversationId: "c1", messageId: "m1", body: "hi" }))
      .rejects.toMatchObject({ failure: "refused", code: "direct_blocked", message: "You can't message this person." });
  });

  it("does not fall back to the saved copy when the server refuses", async () => {
    const h = harness();
    h.routes.set("/sync/direct/conversations/c1/messages", () => Response.json({ conversationId: "c1", messages: [message(1)], more: false }));
    await h.service.history("c1");
    h.routes.set("/sync/direct/conversations/c1/messages", () => Response.json({ error: "gone" }, { status: 404 }));
    await expect(h.service.history("c1")).rejects.toMatchObject({ failure: "refused", status: 404 });
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
    h.routes.set("/sync/direct/activity", () => { polls += 1; return Response.json({ revision: 7 }); });
    const stop = h.service.listen();
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(5);
    expect(h.changes()).toBe(1);
  });

  it("keeps only the signed-in account's saved copy, and none once signed out", async () => {
    const h = harness();
    h.routes.set("/sync/direct/conversations", () => Response.json({ revision: 1, conversations: [conversation(message(1))] }));
    await h.service.list();
    h.signInAs({ relayUrl: "https://relay.test", userId: "cat" });
    await h.service.list();
    const folders = () => readdir(join(stateDir, "direct-messages")).catch(() => [] as string[]);
    expect(await folders()).toHaveLength(2);

    await h.service.credentialsChanged({ relayUrl: "https://relay.test", userId: "cat" });
    expect(await folders()).toHaveLength(1);
    h.goOffline();
    expect(await h.service.list()).toMatchObject({ saved: true });

    await h.service.credentialsChanged(null);
    expect(await folders()).toEqual([]);
    // A read that lands after sign-out saves nothing.
    h.signInAs({ relayUrl: "https://relay.test", userId: "ann" });
    await expect(h.service.list()).rejects.toMatchObject({ failure: "unreachable" });
    expect(await folders()).toEqual([]);
  });

  it("tells listeners once the server answers after starting offline", async () => {
    const h = harness();
    h.routes.set("/sync/direct/activity", () => Response.json({ revision: 42 }));
    h.goOffline();
    const stop = h.service.listen();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.changes()).toBe(0);
    h.goOnline();
    await expect.poll(() => h.changes()).toBe(1);
    stop();
  });

  it("follows with the newest token when the same account signs in again", async () => {
    const h = harness({ account: { relayUrl: "https://relay.test", userId: "ann", token: "old" } });
    h.routes.set("/sync/direct/activity", () => Response.json({ revision: 1 }));
    const stop = h.service.listen();
    await expect.poll(() => h.tokens.length).toBeGreaterThan(0);
    h.signInAs({ relayUrl: "https://relay.test", userId: "ann", token: "new" });
    const at = h.tokens.length;
    await expect.poll(() => h.tokens.slice(at).includes("new")).toBe(true);
    stop();
    expect(h.tokens.slice(at + 1).every((token) => token === "new")).toBe(true);
  });
});
