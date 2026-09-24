import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimWorkspace,
  closeTestStorages,
  createShare,
  testHandler,
  testStorage,
} from "@dohc/sync-relay/testing";
import { NOTICE_READ_RETENTION_MS } from "@dohc/workspace-contracts/relay";
import type { SyncRelayHandler } from "@dohc/sync-relay";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createNoticeStore,
  NoticeNotSentError,
  type NoticeAccount,
  type NoticeStore,
  type PostNoticeInput,
} from "./noticeStore";

afterEach(closeTestStorages);

const WORKSPACE = "workspace-trip";
let clock = 10_000;

interface Relay {
  handler: SyncRelayHandler;
  online: boolean;
  // Answers 404 for every notice route, as a server older than the list does.
  outdated: boolean;
}

async function relay(): Promise<Relay> {
  clock = 10_000;
  const storage = await testStorage();
  const handler = testHandler(storage, {
    nowMs: () => clock,
    lookupUserDisplayName: (userId) => `Name ${userId}`,
  });
  await claimWorkspace(handler, "owner", WORKSPACE);
  return { handler, online: true, outdated: false };
}

function account(server: Relay, userId: string): NoticeAccount {
  return {
    key: `https://server.test#https://relay.test#${userId}`,
    userId,
    relay: {
      baseUrl: "https://relay.test",
      token: `user:${userId}`,
      fetch: async (input, init) => {
        if (!server.online) throw new TypeError("fetch failed");
        const request = new Request(input, init);
        if (server.outdated && new URL(request.url).pathname.startsWith("/sync/notices")) {
          return Response.json({ ok: false, error: "not found", code: "not_found" }, { status: 404 });
        }
        return await server.handler(request);
      },
    },
  };
}

interface Computer {
  store: NoticeStore;
  directory: string;
  changes: number;
  signedIn: NoticeAccount | null;
  // Workspaces that sync through the signed-in account.
  synced: Set<string>;
}

async function computer(signedIn: NoticeAccount | null, directory?: string): Promise<Computer> {
  const state: Computer = {
    directory: directory ?? await createTestScratch("notices-"),
    changes: 0,
    signedIn,
    synced: new Set([WORKSPACE]),
    store: undefined as unknown as NoticeStore,
  };
  state.store = createNoticeStore({
    directory: state.directory,
    currentAccount: async () => state.signedIn,
    accountForWorkspace: async (workspaceId) =>
      state.synced.has(workspaceId) ? state.signedIn : null,
    installId: () => "install-a",
    onChanged: () => { state.changes += 1; },
    nowMs: () => clock,
  });
  return state;
}

function notice(overrides: Partial<PostNoticeInput> = {}): PostNoticeInput {
  return {
    workspaceId: WORKSPACE,
    noticeId: "agent-run:1",
    kind: "agent-run",
    title: "Your agent finished",
    body: "Planned day 2.",
    ...overrides,
  };
}

async function titles(computer: Computer): Promise<string[]> {
  return (await computer.store.list()).map((row) => `${row.store}:${row.title}${row.readAtMs === null ? "" : " (read)"}`);
}

describe("notices on one person's computers", () => {
  it("reaches the person's other computer and carries read and dismissed back", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    const desktop = await computer(account(server, "ana"));

    await laptop.store.postNotice(notice());
    expect(await titles(laptop)).toEqual(["account:Your agent finished"]);
    await laptop.store.sync();
    await desktop.store.sync();
    expect(await desktop.store.list()).toEqual([expect.objectContaining({
      store: "account",
      noticeId: "agent-run:1",
      kind: "agent-run",
      senderKind: "agent",
      senderLabel: "Name ana",
      body: "Planned day 2.",
      createdAtMs: 10_000,
      readAtMs: null,
    })]);
    expect(desktop.changes).toBe(1);

    clock = 11_000;
    await desktop.store.mark({ store: "account", noticeId: "agent-run:1" }, "read");
    expect(await titles(desktop)).toEqual(["account:Your agent finished (read)"]);
    await desktop.store.sync();
    await laptop.store.sync();
    expect(await titles(laptop)).toEqual(["account:Your agent finished (read)"]);

    await laptop.store.mark({ store: "account", noticeId: "agent-run:1" }, "dismissed");
    expect(await laptop.store.list()).toEqual([]);
    await laptop.store.sync();
    await desktop.store.sync();
    expect(await desktop.store.list()).toEqual([]);
  });

  it("posts a notice id once", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    const desktop = await computer(account(server, "ana"));
    await laptop.store.postNotice(notice());
    await laptop.store.postNotice(notice({ title: "Changed" }));
    await laptop.store.sync();
    await desktop.store.postNotice(notice({ title: "From the desktop" }));
    await desktop.store.sync();
    expect(await titles(desktop)).toEqual(["account:Your agent finished"]);
  });

  it("keeps a notice and a mark while offline and sends them later", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    const desktop = await computer(account(server, "ana"));
    server.online = false;

    await laptop.store.postNotice(notice());
    await laptop.store.mark({ store: "account", noticeId: "agent-run:1" }, "read");
    await laptop.store.sync();
    expect(await titles(laptop)).toEqual(["account:Your agent finished (read)"]);

    server.online = true;
    await laptop.store.sync();
    await desktop.store.sync();
    expect(await titles(desktop)).toEqual(["account:Your agent finished (read)"]);
  });

  it("keeps the list, cursor, and outbox across a restart", async () => {
    const server = await relay();
    const first = await computer(account(server, "ana"));
    server.online = false;
    await first.store.postNotice(notice());

    const restarted = await computer(first.signedIn, first.directory);
    expect(await titles(restarted)).toEqual(["account:Your agent finished"]);
    server.online = true;
    await restarted.store.sync();
    await restarted.store.sync();
    expect(await titles(restarted)).toEqual(["account:Your agent finished"]);
    expect(restarted.changes).toBe(1);
  });

  it("hides the account's notices after signing out", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    const signedIn = laptop.signedIn;

    laptop.signedIn = null;
    expect(await laptop.store.list()).toEqual([]);
    laptop.signedIn = signedIn;
    expect(await titles(laptop)).toEqual(["account:Your agent finished"]);
  });
});

describe("notices that stay on this computer", () => {
  it("keeps notices local with nobody signed in or for a workspace the account does not sync", async () => {
    const server = await relay();
    const signedOut = await computer(null);
    await signedOut.store.postNotice(notice());
    const elsewhere = await computer(account(server, "ana"));
    elsewhere.synced.clear();
    await elsewhere.store.postNotice(notice({ noticeId: "agent-run:2" }));
    await elsewhere.store.sync();

    expect(await titles(signedOut)).toEqual(["local:Your agent finished"]);
    expect(await titles(elsewhere)).toEqual(["local:Your agent finished"]);
    const other = await computer(account(server, "ana"));
    await other.store.sync();
    expect(await other.store.list()).toEqual([]);

    await signedOut.store.mark({ store: "local", noticeId: "agent-run:1" }, "read");
    expect(await titles(signedOut)).toEqual(["local:Your agent finished (read)"]);
    await signedOut.store.mark({ store: "local", noticeId: "agent-run:1" }, "dismissed");
    expect(await signedOut.store.list()).toEqual([]);
  });

  it("keeps notices local and says so once when the server has no notice list", async () => {
    const server = await relay();
    server.outdated = true;
    const laptop = await computer(account(server, "ana"));

    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    await laptop.store.sync();
    await laptop.store.postNotice(notice({ noticeId: "agent-run:2", title: "Your agent finished again" }));
    const rows = await laptop.store.list();
    expect(rows.map((row) => `${row.store}:${row.kind}:${row.title}`).sort()).toEqual([
      "local:agent-run:Your agent finished",
      "local:agent-run:Your agent finished again",
      "local:server-outdated:Your server doesn't sync notices",
    ]);

    // Once the server is updated, notices go to the account again.
    server.outdated = false;
    await laptop.store.sync();
    await laptop.store.postNotice(notice({ noticeId: "agent-run:3", title: "Third run" }));
    await laptop.store.sync();
    expect((await laptop.store.list()).filter((row) => row.store === "account").map((row) => row.title))
      .toEqual(["Third run"]);
  });

  it("drops local rows past the read retention", async () => {
    const laptop = await computer(null);
    await laptop.store.postNotice(notice());
    await laptop.store.mark({ store: "local", noticeId: "agent-run:1" }, "read");
    clock += NOTICE_READ_RETENTION_MS;
    await laptop.store.postNotice(notice({ noticeId: "agent-run:2", title: "Later" }));
    expect(await titles(laptop)).toEqual(["local:Later"]);
    expect(await readdir(laptop.directory)).toEqual(["local.json"]);
  });
});

describe("notices for another person", () => {
  it("sends to someone who can read the target and reports a refusal", async () => {
    const server = await relay();
    const shareId = await createShare(server.handler, "owner", WORKSPACE, {
      paths: ["trip"],
      recipientUserId: "ana",
    });
    const owner = await computer(account(server, "owner"));
    const ana = await computer(account(server, "ana"));
    const failed = notice({
      noticeId: "automation-failed:run-1",
      kind: "automation-failed",
      title: "Stamp the finish date failed",
      target: { path: "trip/tasks" },
      recipientUserId: "ana",
    });

    await owner.store.postNotice(failed);
    await ana.store.sync();
    expect(await ana.store.list()).toEqual([expect.objectContaining({
      store: "account",
      senderLabel: "Name owner",
      senderKind: "automation",
      recipientShareId: shareId,
    })]);
    expect(await owner.store.list()).toEqual([]);

    await expect(owner.store.postNotice({ ...failed, noticeId: "x", target: { path: "budget" } }))
      .rejects.toThrow(new NoticeNotSentError("This person can't open what the notice points to."));
    owner.synced.clear();
    await expect(owner.store.postNotice({ ...failed, noticeId: "y" })).rejects.toBeInstanceOf(NoticeNotSentError);
  });
});
