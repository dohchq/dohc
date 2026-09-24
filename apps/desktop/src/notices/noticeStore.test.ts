import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  claimWorkspace,
  closeTestStorages,
  createShare,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "@dohc/sync-relay/testing";
import type { SyncRelayHandler } from "@dohc/sync-relay";
import type { SyncRelayStorage } from "@dohc/sync-relay/storage";
import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_READ_RETENTION_MS,
  NOTICE_SENDER_LABEL_MAX_CHARS,
  type NoticeReach,
} from "@dohc/workspace-contracts/relay";
import { ListNoticesResult } from "../ipc/bridgeContract";
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
  storage: SyncRelayStorage;
  online: boolean;
  // Answers 404 for every notice route, as a server older than the list does.
  outdated: boolean;
  failPosts: boolean;
  failPulls: boolean;
}

async function relay(overrides: HandlerOverrides = {}): Promise<Relay> {
  clock = 10_000;
  const storage = await testStorage();
  const handler = testHandler(storage, {
    nowMs: () => clock,
    lookupUserDisplayName: (userId) => `Name ${userId}`,
    ...overrides,
  });
  await claimWorkspace(handler, "owner", WORKSPACE);
  return { handler, storage, online: true, outdated: false, failPosts: false, failPulls: false };
}

function account(server: Relay, userId: string): NoticeAccount {
  return {
    key: `https://server.test#https://relay.test#${userId}`,
    userId,
    relay: {
      baseUrl: "https://relay.test",
      token: `user:${userId}`,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const failing = request.method === "POST" ? server.failPosts : server.failPulls;
        if (!server.online || failing) throw new TypeError("fetch failed");
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
  // How each of this computer's workspaces reaches the signed-in relay.
  reach: Map<string, NoticeReach>;
}

async function computer(signedIn: NoticeAccount | null, directory?: string): Promise<Computer> {
  const state: Computer = {
    directory: directory ?? await createTestScratch("notices-"),
    changes: 0,
    signedIn,
    reach: new Map([[WORKSPACE, { workspaceId: WORKSPACE }]]),
    store: undefined as unknown as NoticeStore,
  };
  state.store = createNoticeStore({
    directory: state.directory,
    currentAccount: async () => state.signedIn,
    reachFor: async (workspaceId) => (state.signedIn ? state.reach.get(workspaceId) ?? null : null),
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

async function file(computer: Computer, name: "local" | "account"): Promise<Record<string, unknown[]>> {
  const names = await readdir(computer.directory);
  const found = names.find((entry) => (name === "local" ? entry === "local.json" : entry.startsWith("account-") && entry.endsWith(".json")));
  if (!found) throw new Error(`no ${name} file`);
  return JSON.parse(await readFile(join(computer.directory, found), "utf8")) as Record<string, unknown[]>;
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
      workspaceId: WORKSPACE,
      recipientShareId: null,
      senderKind: "agent",
      senderLabel: "Name ana",
      body: "Planned day 2.",
      target: {},
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

  it("keeps one waiting mark per notice, with dismissed in place of read", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    server.online = false;

    await laptop.store.mark({ store: "account", noticeId: "agent-run:1" }, "read");
    await laptop.store.mark({ store: "account", noticeId: "agent-run:1" }, "dismissed");
    await laptop.store.mark({ store: "account", noticeId: "agent-run:1" }, "read");
    await laptop.store.sync();
    expect((await file(laptop, "account")).marks).toEqual([
      { noticeId: "agent-run:1", mark: "dismissed", atMs: clock },
    ]);

    server.online = true;
    await laptop.store.sync();
    expect((await file(laptop, "account")).marks).toEqual([]);
    const other = await computer(account(server, "ana"));
    await other.store.sync();
    expect(await other.store.list()).toEqual([]);
  });

  it("shows your notice after the relay accepts it until a pull settles it", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    server.failPulls = true;
    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    expect(await titles(laptop)).toEqual(["account:Your agent finished"]);
    expect((await file(laptop, "account")).posts).toEqual([expect.objectContaining({ sent: true })]);

    server.failPulls = false;
    await laptop.store.sync();
    expect(await laptop.store.list()).toEqual([expect.objectContaining({ senderLabel: "Name ana" })]);
    expect((await file(laptop, "account")).posts).toEqual([]);
  });

  it("takes the whole list when rows it holds were removed, keeping its waiting posts and marks", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    const desktop = await computer(account(server, "ana"));
    await laptop.store.postNotice(notice({ noticeId: "gone", title: "Gone" }));
    await laptop.store.postNotice(notice({ noticeId: "kept", title: "Kept" }));
    await laptop.store.sync();
    await desktop.store.sync();
    expect(await titles(desktop)).toEqual(["account:Gone", "account:Kept"]);

    // The laptop dismisses one; the relay drops it after its retention while
    // the desktop is away.
    await laptop.store.mark({ store: "account", noticeId: "gone" }, "dismissed");
    await laptop.store.sync();
    clock += NOTICE_DISMISSED_RETENTION_MS;
    await laptop.store.postNotice(notice({ noticeId: "sweeps", title: "Sweeps" }));
    await laptop.store.sync();

    // The desktop cannot send, but still pulls the whole list.
    server.failPosts = true;
    await desktop.store.postNotice(notice({ noticeId: "waiting", title: "Waiting" }));
    await desktop.store.mark({ store: "account", noticeId: "kept" }, "read");
    await desktop.store.sync();
    expect((await titles(desktop)).sort()).toEqual(["account:Kept (read)", "account:Sweeps", "account:Waiting"]);

    server.failPosts = false;
    await desktop.store.sync();
    await laptop.store.sync();
    expect((await titles(laptop)).sort()).toEqual(["account:Kept (read)", "account:Sweeps", "account:Waiting"]);
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

  it("reaches the relay through the share from a shared workspace", async () => {
    const server = await relay();
    const shareId = await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    const laptop = await computer(account(server, "ana"));
    laptop.reach = new Map([["ana-trip", { shareId }]]);
    await laptop.store.postNotice(notice({ workspaceId: "ana-trip", target: { path: "trip/day-1" } }));
    await laptop.store.sync();

    const desktop = await computer(account(server, "ana"));
    await desktop.store.sync();
    expect(await desktop.store.list()).toEqual([expect.objectContaining({
      workspaceId: null, recipientShareId: shareId, target: { path: "trip/day-1" },
    })]);
  });

  it("keeps a sender name at the relay's limit, counted in characters", async () => {
    const label = "🎉".repeat(NOTICE_SENDER_LABEL_MAX_CHARS);
    const server = await relay({ lookupUserDisplayName: () => label });
    const laptop = await computer(account(server, "ana"));
    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    const notices = await laptop.store.list();
    expect(notices.map((row) => row.senderLabel)).toEqual([label]);
    expect(ListNoticesResult.parse({ notices }).notices).toHaveLength(1);
  });

  it("drops cached rows past retention on a sync that brings nothing new", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    await laptop.store.postNotice(notice());
    await laptop.store.mark({ store: "account", noticeId: "agent-run:1" }, "read");
    await laptop.store.sync();
    expect((await file(laptop, "account")).rows).toHaveLength(1);

    clock += NOTICE_READ_RETENTION_MS;
    const changes = laptop.changes;
    await laptop.store.sync();
    expect((await file(laptop, "account")).rows).toEqual([]);
    expect(laptop.changes).toBe(changes + 1);
  });
});

describe("notices that stay on this computer", () => {
  it("keeps notices local with nobody signed in or for a workspace the account does not sync", async () => {
    const server = await relay();
    const signedOut = await computer(null);
    await signedOut.store.postNotice(notice());
    const elsewhere = await computer(account(server, "ana"));
    elsewhere.reach.clear();
    await elsewhere.store.postNotice(notice({ noticeId: "agent-run:2" }));
    // Naming yourself does not need the workspace to sync.
    await elsewhere.store.postNotice(notice({ noticeId: "agent-run:3", recipientUserId: "ana" }));
    await elsewhere.store.sync();

    expect(await titles(signedOut)).toEqual(["local:Your agent finished"]);
    expect(await titles(elsewhere)).toEqual(["local:Your agent finished", "local:Your agent finished"]);
    const other = await computer(account(server, "ana"));
    await other.store.sync();
    expect(await other.store.list()).toEqual([]);

    await signedOut.store.mark({ store: "local", noticeId: "agent-run:1" }, "read");
    expect(await titles(signedOut)).toEqual(["local:Your agent finished (read)"]);
    await signedOut.store.mark({ store: "local", noticeId: "agent-run:1" }, "dismissed");
    expect(await signedOut.store.list()).toEqual([]);
    // A dismissed local notice is not posted again.
    await signedOut.store.postNotice(notice());
    expect(await signedOut.store.list()).toEqual([]);
  });

  it("keeps a local notice local after signing in", async () => {
    const server = await relay();
    const laptop = await computer(null);
    await laptop.store.postNotice(notice());
    laptop.signedIn = account(server, "ana");
    await laptop.store.postNotice(notice({ title: "Again" }));
    await laptop.store.sync();
    expect(await titles(laptop)).toEqual(["local:Your agent finished"]);
    const other = await computer(account(server, "ana"));
    await other.store.sync();
    expect(await other.store.list()).toEqual([]);
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

  it("drops local rows past retention when listing", async () => {
    const laptop = await computer(null);
    await laptop.store.postNotice(notice());
    await laptop.store.mark({ store: "local", noticeId: "agent-run:1" }, "read");
    clock += NOTICE_READ_RETENTION_MS;
    expect(await laptop.store.list()).toEqual([]);
    expect((await file(laptop, "local")).rows).toEqual([]);
    expect(await readdir(laptop.directory)).toEqual(["local.json"]);
  });

  it("throws at the call site for a notice the relay would refuse", async () => {
    const laptop = await computer(null);
    for (const invalid of [
      notice({ title: " padded" }),
      notice({ title: "t".repeat(121) }),
      notice({ body: "carriage\rreturn" }),
      notice({ noticeId: "from:owner:x" }),
      notice({ target: { path: "trip", owner: "x" } as PostNoticeInput["target"] }),
    ]) {
      await expect(laptop.store.postNotice(invalid)).rejects.toThrow();
    }
    expect(await laptop.store.list()).toEqual([]);
  });
});

describe("notices for another person", () => {
  it("sends to someone who can read the target and reports a refusal", async () => {
    const server = await relay({ noticePostRateLimiter: new TokenBucketLimiter(2, 0.001, 10) });
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
      noticeId: "from:owner:automation-failed:run-1",
      workspaceId: null,
      recipientShareId: shareId,
      senderLabel: "Name owner",
      senderKind: "automation",
      target: { path: "trip/tasks" },
    })]);
    expect(await owner.store.list()).toEqual([]);

    await ana.store.mark({ store: "account", noticeId: "from:owner:automation-failed:run-1" }, "read");
    await ana.store.sync();
    expect(await titles(ana)).toEqual(["account:Stamp the finish date failed (read)"]);

    await expect(owner.store.postNotice({ ...failed, noticeId: "x", target: { path: "budget" } }))
      .rejects.toThrow(new NoticeNotSentError("This person can't open what the notice points to."));
    await expect(owner.store.postNotice({ ...failed, noticeId: "y" }))
      .rejects.toThrow(new NoticeNotSentError("Too many notices went to other people. Wait a minute, then try again."));
    owner.reach.clear();
    await expect(owner.store.postNotice({ ...failed, noticeId: "z" })).rejects.toBeInstanceOf(NoticeNotSentError);

    // When Ana loses the share, the notice stays and its target goes.
    expect(server.storage.revokeShare(shareId, clock)).toBe(true);
    await ana.store.sync();
    expect(await ana.store.list()).toEqual([expect.objectContaining({ title: "Stamp the finish date failed", target: null })]);
  });
});
