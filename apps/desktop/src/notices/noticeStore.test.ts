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
import { NOTICE_ROWS_PER_SENDER } from "../../../../services/sync-relay/src/storage/limits";
import {
  NOTICE_DISMISSED_RETENTION_MS,
  NOTICE_LIST_ROW_LIMIT,
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
  // Posts of notices fail in transit; marks still go.
  failPosts: boolean;
  failPulls: boolean;
  // Runs, and is awaited, as each request leaves.
  onRequest?: (request: Request) => void | Promise<void>;
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
        await server.onRequest?.(request);
        const path = new URL(request.url).pathname;
        const failing = request.method === "POST" ? server.failPosts && path === "/sync/notices" : server.failPulls;
        if (!server.online || failing) throw new TypeError("fetch failed");
        if (server.outdated && path.startsWith("/sync/notices")) {
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
  // Rises with every sign-in, sign-out, or account switch.
  generation: number;
  // How each of this computer's workspaces reaches the signed-in relay.
  reach: Map<string, NoticeReach>;
  // Runs when the store asks how a workspace reaches the relay.
  onReach?: () => void;
  // Runs when the store reads which account a session belongs to.
  onAccountRead?: () => void;
}

function switchTo(computer: Computer, signedIn: NoticeAccount | null): void {
  computer.signedIn = signedIn;
  computer.generation += 1;
}

async function computer(
  signedIn: NoticeAccount | null,
  options: { directory?: string; outboxPostLimit?: number } = {},
): Promise<Computer> {
  const state: Computer = {
    directory: options.directory ?? await createTestScratch("notices-"),
    changes: 0,
    signedIn,
    generation: 0,
    reach: new Map([[WORKSPACE, { workspaceId: WORKSPACE }]]),
    store: undefined as unknown as NoticeStore,
  };
  state.store = createNoticeStore({
    directory: state.directory,
    session: async () => {
      const account = state.signedIn;
      const generation = state.generation;
      if (!account) return null;
      return {
        get account() {
          state.onAccountRead?.();
          return account;
        },
        isCurrent: () => state.generation === generation,
        reachFor: (workspaceId) => {
          state.onReach?.();
          return state.reach.get(workspaceId) ?? null;
        },
      };
    },
    installId: () => "install-a",
    onChanged: () => { state.changes += 1; },
    nowMs: () => clock,
    ...(options.outboxPostLimit === undefined ? {} : { outboxPostLimit: options.outboxPostLimit }),
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

function shareNotice(shareId: string) {
  return expect.objectContaining({
    store: "account",
    noticeId: "from:owner:share-received:grant-0",
    kind: "share-received",
    recipientShareId: shareId,
    target: { share: shareId },
    readAtMs: null,
  });
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

    const restarted = await computer(first.signedIn, { directory: first.directory });
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

    switchTo(laptop, null);
    expect(await laptop.store.list()).toEqual([]);
    switchTo(laptop, signedIn);
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
    }), shareNotice(shareId)]);
  });

  it("keeps your notice on this computer when the relay refuses it", async () => {
    const server = await relay();
    const shareId = await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    const laptop = await computer(account(server, "ana"));
    laptop.reach = new Map([["ana-trip", { shareId }]]);
    server.online = false;
    await laptop.store.postNotice(notice({ workspaceId: "ana-trip" }));
    const readAtMs = clock;
    await laptop.store.mark({ store: "account", noticeId: "agent-run:1" }, "read");

    // The share ends before the notice leaves, so the relay refuses it.
    expect(server.storage.revokeShare(shareId, clock)).toBe(true);
    server.online = true;
    clock += 1;
    await laptop.store.sync();
    await laptop.store.sync();
    expect(await laptop.store.list()).toEqual([expect.objectContaining({
      store: "local", noticeId: "agent-run:1", workspaceId: "ana-trip", title: "Your agent finished", readAtMs,
    })]);
    const outbox = await file(laptop, "account");
    expect([outbox.posts, outbox.marks]).toEqual([[], []]);
  });

  it("drops a notice the relay removed to make room", async () => {
    const server = await relay();
    await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    const fromOwner = (index: number) => server.storage.postNotice({
      noticeId: `n${index}`, recipientUserId: "ana", reach: { workspaceId: WORKSPACE }, kind: "automation-failed",
      title: `Failure ${index}`, body: "", target: { path: "trip/tasks" }, originInstallId: "install-b",
      senderUserId: "owner", senderLabel: "Owner", nowMs: clock + index,
    });
    for (let index = 0; index < NOTICE_ROWS_PER_SENDER; index += 1) fromOwner(index);
    const laptop = await computer(account(server, "ana"));
    await laptop.store.sync();
    expect(await laptop.store.list()).toHaveLength(NOTICE_ROWS_PER_SENDER);

    fromOwner(NOTICE_ROWS_PER_SENDER);
    await laptop.store.sync();
    const titlesNow = (await laptop.store.list()).map((row) => row.title);
    expect(titlesNow).toHaveLength(NOTICE_ROWS_PER_SENDER);
    expect(titlesNow).not.toContain("Failure 0");
    expect(titlesNow).toContain(`Failure ${NOTICE_ROWS_PER_SENDER}`);
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
    switchTo(laptop, account(server, "ana"));
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

describe("notices while the signed-in account changes", () => {
  it("queues a notice for the account signed in when it is queued", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    // Ben signs in while the notice is being placed.
    laptop.onReach = () => {
      laptop.onReach = undefined;
      switchTo(laptop, account(server, "ben"));
    };
    await laptop.store.postNotice(notice());
    await laptop.store.sync();

    const ana = await computer(account(server, "ana"));
    const ben = await computer(account(server, "ben"));
    await ana.store.sync();
    await ben.store.sync();
    expect(await ana.store.list()).toEqual([]);
    expect(await titles(ben)).toEqual(["account:Your agent finished"]);
  });

  it("queues a notice for the account signed in when the lists change, not when they load", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    // Ben signs in while the store loads Ana's list.
    laptop.onAccountRead = () => {
      laptop.onAccountRead = undefined;
      switchTo(laptop, account(server, "ben"));
    };
    await laptop.store.postNotice(notice());
    await laptop.store.sync();

    const ana = await computer(account(server, "ana"));
    const ben = await computer(account(server, "ben"));
    await ana.store.sync();
    await ben.store.sync();
    expect(await ana.store.list()).toEqual([]);
    expect(await titles(ben)).toEqual(["account:Your agent finished"]);
  });

  it("stops sending once the account changes during a pass", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    server.online = false;
    await laptop.store.postNotice(notice({ noticeId: "one", title: "One" }));
    await laptop.store.postNotice(notice({ noticeId: "two", title: "Two" }));
    await laptop.store.sync();

    server.online = true;
    // Ana signs out as the first notice leaves.
    server.onRequest = () => {
      server.onRequest = undefined;
      switchTo(laptop, null);
    };
    await laptop.store.sync();
    const other = await computer(account(server, "ana"));
    await other.store.sync();
    expect((await other.store.list()).map((row) => row.noticeId)).toEqual(["one"]);
  });
});

describe("the outbox", () => {
  it("holds a mark on your notice until the relay has the notice", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    server.failPosts = true;
    await laptop.store.postNotice(notice());
    await laptop.store.mark({ store: "account", noticeId: "agent-run:1" }, "read");
    await laptop.store.sync();
    expect((await file(laptop, "account")).marks).toEqual([
      { noticeId: "agent-run:1", mark: "read", atMs: clock },
    ]);

    server.failPosts = false;
    await laptop.store.sync();
    expect((await file(laptop, "account")).marks).toEqual([]);
    const other = await computer(account(server, "ana"));
    await other.store.sync();
    expect(await titles(other)).toEqual(["account:Your agent finished (read)"]);
  });

  for (const mark of ["read", "dismissed"] as const) {
    for (const answer of ["accepts", "refuses"] as const) {
      it(`keeps a notice ${mark} while its post is on the way when the relay ${answer} it`, async () => {
        const server = await relay();
        const shareId = await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
        const laptop = await computer(account(server, "ana"));
        laptop.reach = new Map([["ana-trip", { shareId }]]);
        server.online = false;
        await laptop.store.postNotice(notice({ workspaceId: "ana-trip" }));
        server.online = true;

        const markedAtMs = clock;
        server.onRequest = async (request) => {
          if (request.method !== "POST" || new URL(request.url).pathname !== "/sync/notices") return;
          server.onRequest = undefined;
          // Ana marks the notice while the post is on its way; for a
          // refusal, the share ends before the relay reads the post.
          await laptop.store.mark({ store: "account", noticeId: "agent-run:1" }, mark);
          if (answer === "refuses") expect(server.storage.revokeShare(shareId, clock)).toBe(true);
          clock += 1;
        };
        await laptop.store.sync();
        await laptop.store.sync();
        // The relay stamps a read with its own clock when the mark arrives.
        const readAtMs = answer === "accepts" ? expect.any(Number) : markedAtMs;
        // A grant revoked before the first pull never delivers its share notice.
        const expectedNotices = [
          ...(mark === "read" ? [expect.objectContaining({ noticeId: "agent-run:1", readAtMs })] : []),
          ...(answer === "accepts" ? [shareNotice(shareId)] : []),
        ];

        if (answer === "accepts") {
          const other = await computer(account(server, "ana"));
          await other.store.sync();
          expect(await other.store.list()).toEqual(expectedNotices);
        } else {
          const local = (await file(laptop, "local")).rows;
          expect(local).toEqual([expect.objectContaining({
            noticeId: "agent-run:1",
            workspaceId: "ana-trip",
            readAtMs: mark === "read" ? markedAtMs : null,
            dismissedAtMs: mark === "dismissed" ? markedAtMs : null,
          })]);
        }
        expect(await laptop.store.list()).toEqual(expectedNotices);
        const outbox = await file(laptop, "account");
        expect([outbox.posts, outbox.marks]).toEqual([[], []]);
      });
    }
  }

  it("keeps at most the limit of unsent notices, dropping the oldest with its marks", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"), { outboxPostLimit: 3 });
    server.online = false;
    for (const id of ["a", "b", "c"]) await laptop.store.postNotice(notice({ noticeId: id, title: id }));
    await laptop.store.mark({ store: "account", noticeId: "a" }, "read");
    await laptop.store.mark({ store: "account", noticeId: "b" }, "read");
    await laptop.store.postNotice(notice({ noticeId: "d", title: "d" }));
    await laptop.store.sync();

    const outbox = await file(laptop, "account");
    expect(outbox.posts.map((post) => (post as { request: { noticeId: string } }).request.noticeId))
      .toEqual(["b", "c", "d"]);
    expect(outbox.marks).toEqual([{ noticeId: "b", mark: "read", atMs: clock }]);
    expect((await titles(laptop)).sort()).toEqual(["account:b (read)", "account:c", "account:d"]);
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
    }), shareNotice(shareId)]);
    expect(await owner.store.list()).toEqual([]);

    await ana.store.mark({ store: "account", noticeId: "from:owner:automation-failed:run-1" }, "read");
    await ana.store.sync();
    expect(await titles(ana)).toEqual([
      "account:Stamp the finish date failed (read)",
      "account:Name owner shared trip with you",
    ]);

    await expect(owner.store.postNotice({ ...failed, noticeId: "x", target: { path: "budget" } }))
      .rejects.toThrow(new NoticeNotSentError("This person can't open what the notice points to."));
    await expect(owner.store.postNotice({ ...failed, noticeId: "y" }))
      .rejects.toThrow(new NoticeNotSentError("Too many notices went to other people. Wait a minute, then try again."));
    owner.reach.clear();
    await expect(owner.store.postNotice({ ...failed, noticeId: "z" })).rejects.toBeInstanceOf(NoticeNotSentError);

    // When Ana loses the share, the notice stays and its target goes.
    expect(server.storage.revokeShare(shareId, clock)).toBe(true);
    await ana.store.sync();
    expect(await ana.store.list()).toEqual([
      expect.objectContaining({ title: "Stamp the finish date failed", target: null }),
      expect.objectContaining({
        noticeId: "from:owner:share-received:grant-0", kind: "share-received", target: null, readAtMs: null,
      }),
    ]);
  });

  it("says when a person's notices are full of unread ones", async () => {
    const server = await relay();
    await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    for (let index = 0; index < NOTICE_LIST_ROW_LIMIT; index += 1) {
      server.storage.postNotice({
        noticeId: `own-${index}`, recipientUserId: "ana", reach: { workspaceId: WORKSPACE }, kind: "mention",
        title: "Mentioned", body: "", target: {}, originInstallId: "install-b",
        senderUserId: "ana", senderLabel: "Ana", nowMs: clock + index,
      });
    }
    clock += NOTICE_LIST_ROW_LIMIT;
    const owner = await computer(account(server, "owner"));
    await expect(owner.store.postNotice(notice({
      kind: "automation-failed", title: "Stamp the finish date failed", target: { path: "trip/tasks" }, recipientUserId: "ana",
    }))).rejects.toThrow(new NoticeNotSentError("This person has too many unread notices to get this one."));
    // Filling a list of 1,000 rows takes seconds on a loaded machine.
  }, 60_000);
});
