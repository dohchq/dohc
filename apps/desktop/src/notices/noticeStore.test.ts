import { mkdir, readdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { MomentAuthor, VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { ListNoticesResult } from "../ipc/bridgeContract";
import { FAILED_ELSEWHERE_BODY } from "@dohc/automation-executor/automation-failed-notice";
import {
  RETRY_ELSEWHERE,
  retryAutomationRun,
  retryFromFailureNotice,
  sendFailureNotices,
  switchedOffNotice,
  switcherNameFor,
  whoChangedLast,
  whoSwitchedOff,
  type AutomationsFileHistory,
} from "../automations/automationNotices";
import { createTestScratch } from "../workspaces/testTemp";
import { NoticeNotSentError } from "@dohc/automation-executor/automation-chat";
import {
  createNoticeStore,
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
  // Posts of notices are refused, as the relay refuses a settled skipped notice.
  refusePosts?: boolean;
  // Posts of notices reach the relay, and their answer is lost.
  losePostReplies?: boolean;
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
        if (server.refusePosts && request.method === "POST" && path === "/sync/notices") {
          return Response.json({ ok: false, error: "refused", code: "notice_refused" }, { status: 403 });
        }
        if (server.outdated && path.startsWith("/sync/notices")) {
          return Response.json({ ok: false, error: "not found", code: "not_found" }, { status: 404 });
        }
        const answer = await server.handler(request);
        if (server.losePostReplies && request.method === "POST" && path === "/sync/notices") throw new TypeError("fetch failed");
        return answer;
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
  options: { directory?: string; outboxPostLimit?: number; installId?: string; refusalNotices?: Parameters<typeof createNoticeStore>[0]["refusalNotices"]; dismissRefusal?: Parameters<typeof createNoticeStore>[0]["dismissRefusal"] } = {},
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
    installId: () => options.installId ?? "install-a",
    onChanged: () => { state.changes += 1; },
    nowMs: () => clock,
    refusalNotices: options.refusalNotices,
    dismissRefusal: options.dismissRefusal,
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
  return (await computer.store.list()).notices.map((row) => `${row.store}:${row.title}${row.readAtMs === null ? "" : " (read)"}`);
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
    expect((await desktop.store.list()).notices).toEqual([expect.objectContaining({
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
    await desktop.store.mark([{ store: "account", noticeId: "agent-run:1" }], "read", desktop.signedIn?.key ?? null);
    expect(await titles(desktop)).toEqual(["account:Your agent finished (read)"]);
    await desktop.store.sync();
    await laptop.store.sync();
    expect(await titles(laptop)).toEqual(["account:Your agent finished (read)"]);

    await laptop.store.mark([{ store: "account", noticeId: "agent-run:1" }], "dismissed", laptop.signedIn?.key ?? null);
    expect((await laptop.store.list()).notices).toEqual([]);
    await laptop.store.sync();
    await desktop.store.sync();
    expect((await desktop.store.list()).notices).toEqual([]);
  });

  it("tells only the first computer to dismiss a notice that it did", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    const desktop = await computer(account(server, "ana"), { installId: "install-b" });
    const ref = { store: "account" as const, noticeId: "agent-run:1" };
    await laptop.store.postNotice(notice());
    // The post has not left yet: the dismissal sends it first.
    expect(await laptop.store.dismissFirst(ref, laptop.signedIn?.key ?? null)).toBe("first");
    expect(await laptop.store.dismissFirst(ref, laptop.signedIn?.key ?? null), "asked again after a lost answer").toBe("first");
    await desktop.store.sync();
    expect(await desktop.store.dismissFirst(ref, desktop.signedIn?.key ?? null)).toBe("not-first");
    expect((await laptop.store.list()).notices, "dismissed rows leave the list").toEqual([]);

    server.online = false;
    expect(await laptop.store.dismissFirst({ store: "account", noticeId: "other" }, laptop.signedIn?.key ?? null)).toBe("unanswered");
    expect(await laptop.store.dismissFirst(ref, "another account")).toBe("unanswered");
  });

  it("lets this computer's own dismissal decide for a notice only it holds", async () => {
    const signedOut = await computer(null);
    await signedOut.store.postNotice(notice());
    const ref = { store: "local" as const, noticeId: "agent-run:1" };
    expect(await signedOut.store.dismissFirst(ref, null)).toBe("first");
    expect(await signedOut.store.dismissFirst(ref, null), "asked again after a crash").toBe("first");
    expect(await signedOut.store.dismissFirst({ store: "local", noticeId: "gone" }, null)).toBe("not-first");
  });

  it("drops a skipped schedule's notice the relay refuses, and never keeps it here", async () => {
    const server = await relay();
    server.refusePosts = true;
    const laptop = await computer(account(server, "ana"));
    const skipped = notice({ noticeId: "schedule-skipped:ws:collection:T#r:1000", kind: "schedule-skipped", title: "Report skipped once", body: "" });
    await laptop.store.postNotice(skipped);
    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    expect((await laptop.store.list()).notices.map((row) => [row.store, row.noticeId]), "only the other notice moved here")
      .toEqual([["local", "agent-run:1"]]);
  });

  it("never drops a waiting skipped schedule's notice to make room", async () => {
    const server = await relay();
    server.online = false;
    const laptop = await computer(account(server, "ana"), { outboxPostLimit: 2 });
    await laptop.store.postNotice(notice({ noticeId: "schedule-skipped:ws:collection:T#r:1000", kind: "schedule-skipped", title: "Report skipped once", body: "" }));
    for (const id of ["agent-run:1", "agent-run:2", "agent-run:3"]) await laptop.store.postNotice(notice({ noticeId: id }));
    const ids = (await laptop.store.list()).notices.map((row) => row.noticeId);
    expect(ids).toContain("schedule-skipped:ws:collection:T#r:1000");
    expect(ids).not.toContain("agent-run:1");
  });

  it("dismisses a withdrawn notice whose post was already on its way", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    server.onRequest = async (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/sync/notices") return;
      server.onRequest = undefined;
      await laptop.store.withdraw("agent-run:1");
    };
    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    await laptop.store.sync();
    const desktop = await computer(account(server, "ana"), { installId: "install-b" });
    await desktop.store.sync();
    expect((await desktop.store.list()).notices, "the relay holds it dismissed").toEqual([]);
    expect((await laptop.store.list()).notices).toEqual([]);
  });

  it("dismisses a withdrawn notice the relay took although its answer was lost", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    server.losePostReplies = true;
    server.onRequest = async (request) => {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/sync/notices") return;
      server.onRequest = undefined;
      await laptop.store.withdraw("agent-run:1");
    };
    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    // The next pass confirms the post before its dismissal goes.
    server.losePostReplies = false;
    await laptop.store.sync();
    await laptop.store.sync();
    const desktop = await computer(account(server, "ana"), { installId: "install-b" });
    await desktop.store.sync();
    expect((await desktop.store.list()).notices, "held and dismissed on the relay").toEqual([]);
  });

  it("takes back a notice it posted", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    server.online = false;
    await laptop.store.postNotice(notice());
    await laptop.store.withdraw("agent-run:1");
    expect((await laptop.store.list()).notices, "an unsent post goes").toEqual([]);
    server.online = true;
    await laptop.store.postNotice(notice({ noticeId: "agent-run:2" }));
    await laptop.store.sync();
    await laptop.store.withdraw("agent-run:2");
    await laptop.store.sync();
    expect((await laptop.store.list()).notices, "a sent one is dismissed").toEqual([]);
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
    await laptop.store.mark([{ store: "account", noticeId: "agent-run:1" }], "read", laptop.signedIn?.key ?? null);
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

    await laptop.store.mark([{ store: "account", noticeId: "agent-run:1" }], "read", laptop.signedIn?.key ?? null);
    await laptop.store.mark([{ store: "account", noticeId: "agent-run:1" }], "dismissed", laptop.signedIn?.key ?? null);
    await laptop.store.mark([{ store: "account", noticeId: "agent-run:1" }], "read", laptop.signedIn?.key ?? null);
    await laptop.store.sync();
    expect((await file(laptop, "account")).marks).toEqual([
      { noticeId: "agent-run:1", mark: "dismissed", atMs: clock },
    ]);

    server.online = true;
    await laptop.store.sync();
    expect((await file(laptop, "account")).marks).toEqual([]);
    const other = await computer(account(server, "ana"));
    await other.store.sync();
    expect((await other.store.list()).notices).toEqual([]);
  });

  it("marks a whole list read in one write and one relay call", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    await laptop.store.postNotice(notice({ noticeId: "a", title: "A" }));
    await laptop.store.postNotice(notice({ noticeId: "b", title: "B" }));
    laptop.reach.clear();
    await laptop.store.postNotice(notice({ noticeId: "c", title: "C" }));
    await laptop.store.sync();
    const markRequests: string[] = [];
    server.onRequest = (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/sync/notices/marks") markRequests.push(path);
    };
    const changes = laptop.changes;

    const { account: shown, notices } = await laptop.store.list();
    await laptop.store.mark(notices.map(({ store, noticeId }) => ({ store, noticeId })), "read", shown);
    expect((await titles(laptop)).sort()).toEqual(["account:A (read)", "account:B (read)", "local:C (read)"]);
    expect(laptop.changes).toBe(changes + 1);
    await laptop.store.sync();
    expect(markRequests).toHaveLength(1);
    expect((await file(laptop, "account")).marks).toEqual([]);
  });

  it("marks nothing in the account signed in now for a list shown for another", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    await laptop.store.postNotice(notice());
    laptop.reach.clear();
    await laptop.store.postNotice(notice({ noticeId: "here", title: "Here" }));
    await laptop.store.sync();
    const shown = await laptop.store.list();
    expect(shown.account).toBe(laptop.signedIn?.key);

    // Ben signs in on this computer and has a notice with the same id.
    switchTo(laptop, account(server, "ben"));
    laptop.reach.set(WORKSPACE, { workspaceId: WORKSPACE });
    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    await laptop.store.mark(shown.notices.map(({ store, noticeId }) => ({ store, noticeId })), "read", shown.account);

    expect((await titles(laptop)).sort()).toEqual(["account:Your agent finished", "local:Here (read)"]);
    expect((await laptop.store.list()).account).toBe(laptop.signedIn?.key);
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
    expect((await laptop.store.list()).notices).toEqual([expect.objectContaining({ senderLabel: "Name ana" })]);
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
    await laptop.store.mark([{ store: "account", noticeId: "gone" }], "dismissed", laptop.signedIn?.key ?? null);
    await laptop.store.sync();
    clock += NOTICE_DISMISSED_RETENTION_MS;
    await laptop.store.postNotice(notice({ noticeId: "sweeps", title: "Sweeps" }));
    await laptop.store.sync();

    // The desktop cannot send, but still pulls the whole list.
    server.failPosts = true;
    await desktop.store.postNotice(notice({ noticeId: "waiting", title: "Waiting" }));
    await desktop.store.mark([{ store: "account", noticeId: "kept" }], "read", desktop.signedIn?.key ?? null);
    await desktop.store.sync();
    expect((await titles(desktop)).sort()).toEqual(["account:Kept (read)", "account:Sweeps", "account:Waiting"]);

    server.failPosts = false;
    await desktop.store.sync();
    await laptop.store.sync();
    expect((await titles(laptop)).sort()).toEqual(["account:Kept (read)", "account:Sweeps", "account:Waiting"]);
  });

  it("keeps a notice whose save failed out of the list, so a retry saves it", async () => {
    const server = await relay();
    server.online = false;
    for (const signedIn of [null, account(server, "ana")]) {
      const laptop = await computer(signedIn);
      await laptop.store.postNotice(notice({ noticeId: "first", title: "First" }));
      // Sync saves the account outbox before sending, even when the relay is offline.
      await laptop.store.sync();
      const name = (await readdir(laptop.directory)).find((entry) => entry.endsWith(".json"))!;
      const where = signedIn ? "account" : "local";
      // A folder where the save writes its temporary file makes the save fail.
      await mkdir(join(laptop.directory, `${name}.tmp`));
      await expect(laptop.store.postNotice(notice({ noticeId: "second", title: "Second" }))).rejects.toThrow();
      expect(await titles(laptop)).toEqual([`${where}:First`]);

      await rmdir(join(laptop.directory, `${name}.tmp`));
      await laptop.store.postNotice(notice({ noticeId: "second", title: "Second" }));
      // dohc runs one store per profile; let this one's background sync finish before the next opens.
      await laptop.store.sync();
      const restarted = await computer(signedIn, { directory: laptop.directory });
      expect(await titles(restarted)).toEqual([`${where}:First`, `${where}:Second`]);
    }
  });

  it("keeps the list, cursor, and outbox across a restart", async () => {
    const server = await relay();
    const first = await computer(account(server, "ana"));
    server.online = false;
    await first.store.postNotice(notice());
    // dohc runs one store per profile; let this one's background sync finish before the next opens.
    await first.store.sync();

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
    expect((await laptop.store.list()).notices).toEqual([]);
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
    expect((await desktop.store.list()).notices).toEqual([expect.objectContaining({
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
    await laptop.store.mark([{ store: "account", noticeId: "agent-run:1" }], "read", laptop.signedIn?.key ?? null);

    // The share ends before the notice leaves, so the relay refuses it.
    expect(server.storage.revokeShare(shareId, clock)).toBe(true);
    server.online = true;
    clock += 1;
    await laptop.store.sync();
    await laptop.store.sync();
    expect((await laptop.store.list()).notices).toEqual([expect.objectContaining({
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
    expect((await laptop.store.list()).notices).toHaveLength(NOTICE_ROWS_PER_SENDER);

    fromOwner(NOTICE_ROWS_PER_SENDER);
    await laptop.store.sync();
    const titlesNow = (await laptop.store.list()).notices.map((row) => row.title);
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
    const listed = await laptop.store.list();
    expect(listed.notices.map((row) => row.senderLabel)).toEqual([label]);
    expect(ListNoticesResult.parse(listed).notices).toHaveLength(1);
  });

  it("drops cached rows past retention on a sync that brings nothing new", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    await laptop.store.postNotice(notice());
    await laptop.store.mark([{ store: "account", noticeId: "agent-run:1" }], "read", laptop.signedIn?.key ?? null);
    await laptop.store.sync();
    expect((await file(laptop, "account")).rows).toHaveLength(1);

    clock += NOTICE_READ_RETENTION_MS;
    const changes = laptop.changes;
    await laptop.store.sync();
    expect((await file(laptop, "account")).rows).toEqual([]);
    expect(laptop.changes).toBe(changes + 1);
  });
});

describe("a notice whose sender stopped", () => {
  it("sends nothing and keeps nothing once its signal ends", async () => {
    const server = await relay();
    const signedIn = await computer(account(server, "owner"));
    const stopped = AbortSignal.abort();
    await expect(signedIn.store.postNotice(notice({ noticeId: "automation-notify:1", signal: stopped })))
      .rejects.toMatchObject({ name: "AbortError" });
    await expect(signedIn.store.postNotice(notice({ noticeId: "automation-notify:2", recipientUserId: "ana", signal: stopped })))
      .rejects.toMatchObject({ name: "AbortError" });
    await signedIn.store.sync();
    expect((await signedIn.store.list()).notices).toEqual([]);
    const ana = await computer(account(server, "ana"));
    await ana.store.sync();
    expect((await ana.store.list()).notices).toEqual([]);
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
    expect((await other.store.list()).notices).toEqual([]);

    await signedOut.store.mark([{ store: "local", noticeId: "agent-run:1" }], "read", signedOut.signedIn?.key ?? null);
    expect(await titles(signedOut)).toEqual(["local:Your agent finished (read)"]);
    await signedOut.store.mark([{ store: "local", noticeId: "agent-run:1" }], "dismissed", signedOut.signedIn?.key ?? null);
    expect((await signedOut.store.list()).notices).toEqual([]);
    // A dismissed local notice is not posted again.
    await signedOut.store.postNotice(notice());
    expect((await signedOut.store.list()).notices).toEqual([]);
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
    expect((await other.store.list()).notices).toEqual([]);
  });

  it("keeps a notice only here when asked, even signed in to an account that syncs the workspace", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    // A retry posts the same id, and it is kept once.
    await laptop.store.postNotice(notice({ kind: "automation-notify", onlyHere: true }));
    await laptop.store.postNotice(notice({ kind: "automation-notify", onlyHere: true }));
    await laptop.store.sync();
    expect(await titles(laptop)).toEqual(["local:Your agent finished"]);
    const other = await computer(account(server, "ana"));
    await other.store.sync();
    expect((await other.store.list()).notices).toEqual([]);
  });

  it("keeps notices local and says so once when the server has no notice list", async () => {
    const server = await relay();
    server.outdated = true;
    const laptop = await computer(account(server, "ana"));

    await laptop.store.postNotice(notice());
    await laptop.store.sync();
    await laptop.store.sync();
    await laptop.store.postNotice(notice({ noticeId: "agent-run:2", title: "Your agent finished again" }));
    const rows = (await laptop.store.list()).notices;
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
    expect((await laptop.store.list()).notices.filter((row) => row.store === "account").map((row) => row.title))
      .toEqual(["Third run"]);
  });

  it("drops local rows past retention when listing", async () => {
    const laptop = await computer(null);
    await laptop.store.postNotice(notice());
    await laptop.store.mark([{ store: "local", noticeId: "agent-run:1" }], "read", laptop.signedIn?.key ?? null);
    clock += NOTICE_READ_RETENTION_MS;
    expect((await laptop.store.list()).notices).toEqual([]);
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
    expect((await laptop.store.list()).notices).toEqual([]);
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
    expect((await ana.store.list()).notices).toEqual([]);
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
    expect((await ana.store.list()).notices).toEqual([]);
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
    expect((await other.store.list()).notices.map((row) => row.noticeId)).toEqual(["one"]);
  });
});

describe("the outbox", () => {
  it("holds a mark on your notice until the relay has the notice", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "ana"));
    server.failPosts = true;
    await laptop.store.postNotice(notice());
    await laptop.store.mark([{ store: "account", noticeId: "agent-run:1" }], "read", laptop.signedIn?.key ?? null);
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
          await laptop.store.mark([{ store: "account", noticeId: "agent-run:1" }], mark, laptop.signedIn?.key ?? null);
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
          expect((await other.store.list()).notices).toEqual(expectedNotices);
        } else {
          const local = (await file(laptop, "local")).rows;
          expect(local).toEqual([expect.objectContaining({
            noticeId: "agent-run:1",
            workspaceId: "ana-trip",
            readAtMs: mark === "read" ? markedAtMs : null,
            dismissedAtMs: mark === "dismissed" ? markedAtMs : null,
          })]);
        }
        expect((await laptop.store.list()).notices).toEqual(expectedNotices);
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
    await laptop.store.mark([{ store: "account", noticeId: "a" }], "read", laptop.signedIn?.key ?? null);
    await laptop.store.mark([{ store: "account", noticeId: "b" }], "read", laptop.signedIn?.key ?? null);
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
    expect((await ana.store.list()).notices).toEqual([expect.objectContaining({
      store: "account",
      noticeId: "from:owner:automation-failed:run-1",
      workspaceId: null,
      recipientShareId: shareId,
      senderLabel: "Name owner",
      senderKind: "automation",
      target: { path: "trip/tasks" },
    }), shareNotice(shareId)]);
    expect((await owner.store.list()).notices).toEqual([]);

    await ana.store.mark([{ store: "account", noticeId: "from:owner:automation-failed:run-1" }], "read", ana.signedIn?.key ?? null);
    await ana.store.sync();
    expect(await titles(ana)).toEqual([
      "account:Stamp the finish date failed (read)",
      "account:Name owner (owner@dohc.test) shared a folder or file with you",
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
    expect((await ana.store.list()).notices).toEqual([
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

it("rebuilds refusal Notices from the engine and keeps read marks across restart", async () => {
  let pending = [{ noticeId: "sync-refusal-a", originId: "peer", originSeq: 1, refusalCoordinates: [{ originId: "peer", originSeq: 1 }],
    reason: "plaintext projection exceeds limit", document: { versionId: "main", path: "doc.md",
      objectId: "object-a", lineageClaimId: "inactive", conflictId: "review" } }];
  const refusalNotices = async () => [{workspaceId: WORKSPACE, notices: pending}];
  let failDismiss = false;
  const dismissRefusal = async (workspaceId: string, noticeId: string) => {
    expect(workspaceId).toBe(WORKSPACE);
    if (failDismiss) throw new Error("engine unavailable");
    pending = pending.filter(row => row.noticeId !== noticeId);
  };
  const first = await computer(null, {refusalNotices, dismissRefusal});
  const [notice] = (await first.store.list()).notices;
  expect(notice).toMatchObject({kind: "sync-refusal", workspaceId: WORKSPACE, target: {path: "doc.md"}});
  expect(notice!.body).toContain("Open its conflict and choose a copy.");
  expect(notice!.detail).toContain("Object: object-a\nLineage: inactive");
  await first.store.mark([notice!], "read", null);
  clock += 365 * 24 * 60 * 60_000;
  const restarted = await computer(null, {directory: first.directory, refusalNotices, dismissRefusal});
  expect((await restarted.store.list()).notices[0]!.readAtMs).not.toBeNull();
  failDismiss = true;
  await expect(restarted.store.mark([notice!], "dismissed", null)).rejects.toThrow("engine unavailable");
  expect((await restarted.store.list()).notices).toHaveLength(1);
  failDismiss = false;
  await restarted.store.mark([notice!], "dismissed", null);
  const again = await computer(null, {directory: first.directory, refusalNotices, dismissRefusal});
  expect((await again.store.list()).notices).toEqual([]);
});

it("lists engine refusals without the local row limit and removes resolved rows", async () => {
  let pending = Array.from({length: 1_001}, (_, index) => ({noticeId: `sync-refusal-${index}`,
    originId: "peer", originSeq: index, refusalCoordinates: [{ originId: "peer", originSeq: index }], reason: "Review this file", document: null}));
  const refusalNotices = async () => [{workspaceId: WORKSPACE, notices: pending}];
  const first = await computer(null, {refusalNotices});
  expect((await first.store.list()).notices).toHaveLength(1_001);
  await first.store.postNotice(notice());
  expect((await first.store.list()).notices).toHaveLength(1_002);
  pending = [];
  expect((await first.store.list()).notices).toHaveLength(1);
});

it("recovers engine Notices even if the desktop file was lost", async () => {
  const refusalNotices = async () => [{workspaceId: WORKSPACE, notices: [{noticeId: "sync-refusal-a",
    originId: "peer", originSeq: 1, refusalCoordinates: [{ originId: "peer", originSeq: 1 }], reason: "Review this file", document: null}]}];
  const first = await computer(null, {refusalNotices});
  expect((await first.store.list()).notices).toHaveLength(1);
  const fresh = await computer(null, {refusalNotices});
  expect((await fresh.store.list()).notices).toHaveLength(1);
});

it("keeps a queued refusal dismissal hidden when applying it fails, then retries", async () => {
  const pending = [{ noticeId: "queued-refusal", originId: "peer", originSeq: 1, refusalCoordinates: [{ originId: "peer", originSeq: 1 }],
    reason: "Review this file", document: null }];
  let open = true;
  const refusalNotices = async () => [{ workspaceId: WORKSPACE, notices: open ? pending : null }];
  const dismissRefusal = vi.fn(async () => {});
  const first = await computer(null, { refusalNotices, dismissRefusal });
  const [row] = (await first.store.list()).notices;
  open = false;
  await first.store.mark([row!], "dismissed", null);
  open = true;
  dismissRefusal.mockRejectedValueOnce(new Error("engine unavailable"));
  await first.store.refreshRefusals(WORKSPACE);
  expect((await first.store.list()).notices).toEqual([]);
  expect(dismissRefusal).toHaveBeenCalledTimes(3);
});

it.each([undefined, []])("rejects a refusal dismissal without shown coordinates: %s", async (refusalCoordinates) => {
  const dismissRefusal = vi.fn(async () => {});
  const first = await computer(null, { dismissRefusal, refusalNotices: async () => [{ workspaceId: WORKSPACE, notices: [{
    noticeId: "refusal", originId: "peer", originSeq: 1, refusalCoordinates: [{ originId: "peer", originSeq: 1 }],
    reason: "Review this file", document: null,
  }] }] });
  const [shown] = (await first.store.list()).notices;
  await expect(first.store.mark([{ ...shown!, refusalCoordinates }], "dismissed", null))
    .rejects.toThrow("The engine could not dismiss this Notice. Try again.");
  expect(dismissRefusal).not.toHaveBeenCalled();
  expect((await first.store.list()).notices).toHaveLength(1);
});

it("hides a failed queued dismissal when the newer refusal resolves", async () => {
  const firstCoordinate = { originId: "peer", originSeq: 1 };
  const secondCoordinate = { originId: "peer", originSeq: 2 };
  let coordinates = [firstCoordinate];
  let open = true;
  const refusalNotices = async () => [{ workspaceId: WORKSPACE, notices: open ? [{
    noticeId: "refusal", ...coordinates[coordinates.length - 1]!, refusalCoordinates: coordinates,
    reason: "Review this file", document: null,
  }] : null }];
  const dismissRefusal = vi.fn(async () => { if (open) throw new Error("engine unavailable"); });
  const first = await computer(null, { refusalNotices, dismissRefusal });
  const [shown] = (await first.store.list()).notices;
  open = false;
  await first.store.mark([shown!], "dismissed", null);
  coordinates = [firstCoordinate, secondCoordinate];
  open = true;
  expect((await first.store.list()).notices[0]?.refusalCoordinates).toEqual([secondCoordinate]);
  coordinates = [firstCoordinate];
  expect((await first.store.list()).notices).toEqual([]);
  const restarted = await computer(null, { directory: first.directory, refusalNotices, dismissRefusal });
  expect((await restarted.store.list()).notices).toEqual([]);
  expect(dismissRefusal.mock.calls).toEqual(Array.from({ length: 4 }, () => [WORKSPACE, "refusal", [firstCoordinate]]));
});

it("keeps a refusal read when its snapshot only loses coordinates", async () => {
  let coordinates = [{ originId: "peer", originSeq: 1 }, { originId: "peer", originSeq: 2 }];
  const first = await computer(null, { refusalNotices: async () => [{ workspaceId: WORKSPACE, notices: [{
    noticeId: "refusal", originId: "peer", originSeq: 2, refusalCoordinates: coordinates,
    reason: "Review this file", document: null,
  }] }] });
  const [shown] = (await first.store.list()).notices;
  await first.store.mark([shown!], "read", null);
  coordinates = [coordinates[1]!];
  expect((await first.store.list()).notices[0]?.readAtMs).not.toBeNull();
});

it("keeps unavailable workspace refusals while refreshing other workspaces", async () => {
  const refusal = (noticeId: string) => ({ noticeId, originId: "peer", originSeq: 1, refusalCoordinates: [{ originId: "peer", originSeq: 1 }],
    reason: "Review this file", document: null });
  let pending: Awaited<ReturnType<NonNullable<Parameters<typeof createNoticeStore>[0]["refusalNotices"]>>> = [
    { workspaceId: WORKSPACE, notices: [refusal("sync-refusal-a")] },
    { workspaceId: "unavailable", notices: [refusal("sync-refusal-b")] },
  ];
  const refusalNotices = async () => pending;
  const first = await computer(null, { refusalNotices });
  await first.store.postNotice(notice());
  const cached = (await first.store.list()).notices.find(row => row.noticeId === "sync-refusal-b")!;
  await first.store.mark([cached], "read", null);
  pending = [
    { workspaceId: WORKSPACE, notices: [refusal("sync-refusal-c")] },
    { workspaceId: "unavailable", notices: null },
  ];
  const restarted = await computer(null, { directory: first.directory, refusalNotices });
  const rows = (await restarted.store.list()).notices;
  expect(rows.map(row => row.noticeId).sort()).toEqual(["agent-run:1", "sync-refusal-b", "sync-refusal-c"]);
  expect(rows.find(row => row.noticeId === "sync-refusal-b")!.readAtMs).not.toBeNull();
  pending = pending.map(row => ({ ...row, notices: [] }));
  expect((await restarted.store.list()).notices.map(row => row.noticeId)).toEqual(["agent-run:1"]);
});

it("lists cached, local, and account Notices when the refusal reader fails", async () => {
  const server = await relay();
  let failRead = false;
  const first = await computer(account(server, "owner"), {
    refusalNotices: async () => {
      if (failRead) throw new Error("engine unavailable");
      return [{ workspaceId: WORKSPACE, notices: [{ noticeId: "sync-refusal-cached", originId: "peer",
        originSeq: 1, refusalCoordinates: [{ originId: "peer", originSeq: 1 }], reason: "Review this file", document: null }] }];
    },
  });
  await first.store.postNotice(notice());
  await first.store.sync();
  await first.store.list();
  failRead = true;
  first.reach.clear();
  await first.store.postNotice(notice({ noticeId: "local-notice" }));
  const rows = (await first.store.list()).notices;
  expect(rows).toHaveLength(3);
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ noticeId: "agent-run:1", store: "account" }),
    expect.objectContaining({ noticeId: "local-notice", store: "local" }),
    expect.objectContaining({ noticeId: "sync-refusal-cached", store: "local" }),
  ]));
});

describe("automation notices reach the people involved", () => {
  const AUTOMATION = "collection:object-tasks#stamp";
  const failure = (generation: number, claimId = "atc_1") => ({
    automationId: AUTOMATION, claimId, neverStarted: false, chainStopped: false,
    error: "The record is open elsewhere", updatedAtMs: 1_000, generation, datasetInstance: null,
  });
  const report = (
    generation: number,
    options: { replaces?: ReturnType<typeof failure>; startedBy?: string; claimId?: string } = {},
  ) => ({
    failure: failure(generation, options.claimId), name: "Stamp the finish date", collectionPath: "trip/tasks",
    startedBy: options.startedBy ?? null, replaces: options.replaces ?? null,
  });
  const sender = (store: NoticeStore, installId: string, extra: { throughShare?: boolean; lastChangedBy?: string } = {}) => ({
    notices: store,
    computer: { installId, label: `Computer ${installId}` },
    throughShare: extra.throughShare ?? false,
    lastChangedBy: async () => extra.lastChangedBy ?? null,
    onError: vi.fn(),
  });
  const refOf = (row: { store: "local" | "account"; noticeId: string }) => ({ store: row.store, noticeId: row.noticeId });
  const failedIn = async (each: Computer) => (await each.store.list()).notices.filter((row) => row.kind === "automation-failed");

  it("reaches the owner's other computer, tries again only where it ran, and dismisses everywhere once queued", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "owner"), { installId: "install-a" });
    const desktop = await computer(account(server, "owner"), { installId: "install-b" });
    await sendFailureNotices(sender(laptop.store, "install-a"), WORKSPACE, report(1));
    await laptop.store.sync();
    await desktop.store.sync();
    const [row] = (await desktop.store.list()).notices;
    expect(row).toMatchObject({
      kind: "automation-failed",
      title: 'Automation "Stamp the finish date" failed',
      body: "The record is open elsewhere. It ran on Computer install-a.",
      target: { automation: AUTOMATION, path: "trip/tasks/automations.yaml", run: "atc_1" },
      postedHere: false,
    });
    expect((await laptop.store.list()).notices).toEqual([expect.objectContaining({ postedHere: true })]);

    const retry = vi.fn(async () => ({ status: "queued" as const, press: false }));
    await expect(retryFromFailureNotice(
      { notices: desktop.store, retry },
      { notice: refOf(row!), account: desktop.signedIn!.key, startOver: false },
    )).resolves.toEqual({ status: "refused", reason: RETRY_ELSEWHERE });
    expect(retry).not.toHaveBeenCalled();

    await expect(retryFromFailureNotice(
      { notices: laptop.store, retry },
      { notice: refOf(row!), account: laptop.signedIn!.key, startOver: false },
    )).resolves.toEqual({ status: "queued", press: false });
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ noticeId: row!.noticeId }), {
      automationId: AUTOMATION, claimId: "atc_1", startOver: false,
    });
    await laptop.store.sync();
    await desktop.store.sync();
    expect((await laptop.store.list()).notices).toEqual([]);
    expect((await desktop.store.list()).notices).toEqual([]);
  });

  it("refuses an agent's Try again for another computer's run with the notice that names it, even once dismissed", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "owner"), { installId: "install-a" });
    const desktop = await computer(account(server, "owner"), { installId: "install-b" });
    await sendFailureNotices(sender(laptop.store, "install-a"), WORKSPACE, report(1));
    await laptop.store.sync();
    await desktop.store.sync();
    const run = { workspaceId: WORKSPACE, automationId: AUTOMATION, claimId: "atc_1", startOver: false };
    const retry = vi.fn(async () => ({ status: "queued" as const, press: false }));
    const elsewhere = {
      status: "refused",
      reason: RETRY_ELSEWHERE,
      notice: { title: 'Automation "Stamp the finish date" failed', body: "The record is open elsewhere. It ran on Computer install-a." },
    };
    const onDesktop = { notices: desktop.store, installId: "install-b", holds: async () => false, retry };

    await expect(retryAutomationRun(onDesktop, run)).resolves.toEqual(elsewhere);
    // Dismissed on this computer, the notice still names where the run is.
    const [row] = (await desktop.store.list()).notices;
    await desktop.store.mark([refOf(row!)], "dismissed", desktop.signedIn!.key);
    expect((await desktop.store.list()).notices).toEqual([]);
    await expect(retryAutomationRun(onDesktop, run)).resolves.toEqual(elsewhere);
    expect(retry).not.toHaveBeenCalled();

    // A run no notice names goes to this computer's executor, which says why it cannot.
    await expect(retryAutomationRun(onDesktop, { ...run, claimId: "atc_9" })).resolves.toEqual({ status: "queued", press: false });
    expect(retry).toHaveBeenLastCalledWith({ automationId: AUTOMATION, claimId: "atc_9", startOver: false });

    // The computer that holds the claim runs it, as the panel's Try again does, without reading notices.
    const sentFailure = vi.fn(laptop.store.sentFailure);
    await expect(retryAutomationRun({ notices: { sentFailure }, installId: "install-a", holds: async () => true, retry }, run))
      .resolves.toEqual({ status: "queued", press: false });
    expect(retry).toHaveBeenLastCalledWith({ automationId: AUTOMATION, claimId: "atc_1", startOver: false });
    expect(sentFailure).not.toHaveBeenCalled();
  });

  it("names another computer only from a notice this person sent", async () => {
    const server = await relay();
    const shareId = await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    const owner = await computer(account(server, "owner"), { installId: "install-a" });
    // Someone the owner shared with names the owner's run, and the owner reads it in their own workspace.
    server.storage.postNotice({
      noticeId: "automation-failed:ana", recipientUserId: "owner", reach: { shareId }, kind: "automation-failed",
      title: "Stamp failed", body: "It ran on Ana's laptop.",
      target: { automation: AUTOMATION, path: "trip/tasks/automations.yaml", run: "atc_1" },
      originInstallId: "install-c", senderUserId: "ana", senderLabel: "Ana", nowMs: clock,
    });
    await owner.store.sync();
    expect((await owner.store.list()).notices).toEqual([expect.objectContaining({ workspaceId: WORKSPACE, target: expect.objectContaining({ run: "atc_1" }) })]);
    const retry = vi.fn(async () => ({ status: "queued" as const, press: false }));
    await expect(retryAutomationRun(
      { notices: owner.store, installId: "install-a", holds: async () => false, retry },
      { workspaceId: WORKSPACE, automationId: AUTOMATION, claimId: "atc_1", startOver: false },
    )).resolves.toEqual({ status: "queued", press: false });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps a run's notice on this computer while nobody is signed in, and tries it again here", async () => {
    const alone = await computer(null, { installId: "install-a" });
    await sendFailureNotices(sender(alone.store, "install-a"), WORKSPACE, report(1));
    const [row] = (await alone.store.list()).notices;
    expect(row).toMatchObject({ store: "local", kind: "automation-failed", postedHere: true });
    const retry = vi.fn(async () => ({ status: "definition-changed" as const, repeatsMessages: false }));
    await expect(retryFromFailureNotice(
      { notices: alone.store, retry },
      { notice: refOf(row!), account: null, startOver: false },
    )).resolves.toEqual({ status: "definition-changed", repeatsMessages: false });
    // Nothing ran, so the notice stays.
    expect((await alone.store.list()).notices).toHaveLength(1);
  });

  it("replaces an automation's older failure with its newer one on every computer", async () => {
    const server = await relay();
    const laptop = await computer(account(server, "owner"), { installId: "install-a" });
    const desktop = await computer(account(server, "owner"), { installId: "install-b" });
    await sendFailureNotices(sender(laptop.store, "install-a"), WORKSPACE, report(1));
    await laptop.store.sync();
    // Try again of run 2 left run 1 the newest failed one: its notice comes back.
    await sendFailureNotices(sender(laptop.store, "install-a"), WORKSPACE, report(1, { claimId: "atc_2", replaces: failure(1) }));
    await laptop.store.sync();
    await desktop.store.sync();
    for (const each of [laptop, desktop]) {
      expect((await failedIn(each)).map((row) => row.target?.run)).toEqual(["atc_2"]);
    }
  });

  it("tells the owner and the person who changed it last when it fails on the computer of someone it was shared with", async () => {
    const server = await relay();
    const shareId = await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    const ana = await computer(account(server, "ana"), { installId: "install-c" });
    ana.reach = new Map([["ana-trip", { shareId }]]);
    const owner = await computer(account(server, "owner"), { installId: "install-a" });
    // Ana's computer cannot read who changed it last; the relay finds the owner, who did.
    await sendFailureNotices(sender(ana.store, "install-c", { throughShare: true }), "ana-trip", report(1));
    await ana.store.sync();
    await owner.store.sync();
    expect(await failedIn(ana)).toEqual([expect.objectContaining({
      postedHere: true, body: "The record is open elsewhere. It ran on Computer install-c.",
    })]);
    const [ownerCopy] = await failedIn(owner);
    expect(ownerCopy).toMatchObject({
      senderKind: "automation", workspaceId: WORKSPACE, postedHere: false,
      body: FAILED_ELSEWHERE_BODY, target: { automation: AUTOMATION, path: "trip/tasks/automations.yaml" },
    });
    expect(ownerCopy?.target?.run).toBeUndefined();
  });

  it("tells whoever changed it last and whoever's message started it, without this computer's name or the error", async () => {
    const server = await relay();
    await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ben" });
    const owner = await computer(account(server, "owner"), { installId: "install-a" });
    const ana = await computer(account(server, "ana"));
    const ben = await computer(account(server, "ben"));
    await sendFailureNotices(sender(owner.store, "install-a", { lastChangedBy: "ben" }), WORKSPACE, report(1, { startedBy: "ana" }));
    for (const each of [ana, ben]) {
      await each.store.sync();
      const [copy] = await failedIn(each);
      expect(copy).toMatchObject({ body: FAILED_ELSEWHERE_BODY, postedHere: false });
      expect(copy?.target?.run).toBeUndefined();
    }
    // The owner, who changed it last, gets only their own notice.
    await sendFailureNotices(sender(owner.store, "install-a", { lastChangedBy: "owner" }), WORKSPACE, report(2));
    await owner.store.sync();
    expect((await failedIn(owner)).map((row) => row.postedHere)).toEqual([true, true]);
  });

  it("tells everyone involved why a chain stopped, with no run to try again and no promise that someone can", async () => {
    const server = await relay();
    await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    const owner = await computer(account(server, "owner"), { installId: "install-a" });
    const ana = await computer(account(server, "ana"));
    const stopped = { ...report(1, { startedBy: "ana" }), failure: { ...failure(1), neverStarted: true, chainStopped: true, error: "chain-stopped" } };
    await sendFailureNotices(sender(owner.store, "install-a"), WORKSPACE, stopped);
    const why = '"Stamp the finish date" did not run. dohc stops a chain after automations and agents start each other 4 times in a row. Check which automations start each other.';
    await owner.store.sync();
    await ana.store.sync();
    const [own] = await failedIn(owner);
    expect(own).toMatchObject({ title: "An automation chain stopped", body: `${why} This happened on Computer install-a.`, postedHere: true });
    expect(own?.target?.run).toBeUndefined();
    const [copy] = await failedIn(ana);
    expect(copy).toMatchObject({ title: "An automation chain stopped", body: why, postedHere: false, target: { automation: AUTOMATION, path: "trip/tasks/automations.yaml" } });
    expect(copy?.target?.run).toBeUndefined();
  });

  it("sends a copy again when the connection drops, and never runs a notice someone else sent", async () => {
    const server = await relay();
    await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
    const owner = await computer(account(server, "owner"), { installId: "install-a" });
    const ana = await computer(account(server, "ana"), { installId: "install-a" });
    server.online = false;
    await expect(sendFailureNotices(sender(owner.store, "install-a"), WORKSPACE, report(1, { startedBy: "ana" })))
      .rejects.toBeInstanceOf(TypeError);
    server.online = true;
    await sendFailureNotices(sender(owner.store, "install-a"), WORKSPACE, report(1, { startedBy: "ana" }));
    await owner.store.sync();
    expect(await failedIn(owner)).toHaveLength(1);

    // A notice that names a run, from a computer with Ana's install id, is still not hers.
    await owner.store.postNotice({
      workspaceId: WORKSPACE, noticeId: "automation-failed:crafted", kind: "automation-failed", title: "Stamp failed", body: "",
      target: { automation: AUTOMATION, path: "trip/tasks/automations.yaml", run: "atc_1" }, recipientUserId: "ana",
    });
    await ana.store.sync();
    const crafted = (await ana.store.list()).notices.find((row) => row.noticeId.endsWith("automation-failed:crafted"))!;
    expect(crafted.postedHere).toBe(false);
    const retry = vi.fn();
    await expect(retryFromFailureNotice(
      { notices: ana.store, retry },
      { notice: refOf(crafted), account: ana.signedIn!.key, startOver: false },
    )).resolves.toEqual({ status: "refused", reason: RETRY_ELSEWHERE });
    expect(retry).not.toHaveBeenCalled();
    // Nor does it stop Ana's own Try again of a run her computer holds, or names another computer for it.
    const own = vi.fn(async () => ({ status: "queued" as const, press: false }));
    for (const holds of [true, false]) {
      await expect(retryAutomationRun(
        { notices: ana.store, installId: "install-c", holds: async () => holds, retry: own },
        { workspaceId: WORKSPACE, automationId: AUTOMATION, claimId: "atc_1", startOver: false },
      )).resolves.toEqual({ status: "queued", press: false });
    }
    expect(own).toHaveBeenCalledTimes(2);
  });

  describe("History of an automation", () => {
    const PATH = "trip/tasks/automations.yaml";
    const file = (enabled: boolean | null) => enabled === null
      ? "version: 1\nautomations: []\n"
      : `version: 1\nautomations:\n  - id: stamp\n    name: Stamp the finish date\n${enabled ? "" : "    enabled: false\n"}    when: {field-changed: Status}\n    do: [{set: {Done: true}}]\n`;
    const moment = (id: string, before: string | null, after: string, author?: MomentAuthor): VersionedTextMoment => ({
      id, workspaceId: WORKSPACE, versionId: "main", objectId: "object-1", path: PATH, recordedAtMs: 1, operation: "write",
      payload: { before: before === null ? null : { path: PATH, text: before }, after: { path: PATH, text: after } },
      metadata: { origin: "local-file" },
      ...(author ? { author } : {}),
    });
    const ana: MomentAuthor = { kind: "named", userId: "ana", grantId: "grant-0", grantGeneration: 1 };
    const dohc: MomentAuthor = { kind: "automation", automationId: AUTOMATION, depth: 1 };
    // Newest first, in pages, as History serves them.
    const history = (moments: VersionedTextMoment[]): AutomationsFileHistory => ({
      flush: async () => undefined,
      fileObjectIdForPath: async (path) => (path === PATH ? "object-1" : null),
      listMoments: async ({ limit, beforeMomentOrder }) => {
        const start = beforeMomentOrder ?? 0;
        return {
          moments: moments.slice(start, start + limit).map((entry) => ({ id: entry.id, protected: false })),
          nextBeforeMomentOrder: start + limit < moments.length ? start + limit : null,
        };
      },
      readMoment: async (id) => {
        const found = moments.find((entry) => entry.id === id);
        return found ? { protected: false, moment: found } : null;
      },
    });
    const at = { path: PATH, id: "stamp", ownerUserId: "owner" };
    const switched = { collectionPath: "trip/tasks", id: "stamp", automationId: AUTOMATION, name: "Stamp the finish date" };

    it("tells the person who changed it last who switched it off, through the relay", async () => {
      const found = await whoSwitchedOff(history([
        moment("m3", file(true), file(false)),
        moment("m2", file(null), file(true), ana),
        moment("m1", null, file(null)),
      ]), at);
      expect(found).toEqual({ switchedOffBy: { kind: "person", userId: "owner" }, lastChangedBy: "ana", contentHash: expect.any(String) });

      const server = await relay();
      await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana" });
      const owner = await computer(account(server, "owner"));
      const anaComputer = await computer(account(server, "ana"));
      const notice = switchedOffNotice({ workspaceId: WORKSPACE, switched, path: PATH, ...found!, switcherName: "Ice" });
      expect(notice).toMatchObject({ title: 'Ice switched off "Stamp the finish date"', recipientUserId: "ana" });
      await owner.store.postNotice(notice!);
      await anaComputer.store.sync();
      expect((await anaComputer.store.list()).notices).toContainEqual(expect.objectContaining({
        kind: "automation-switched-off", senderKind: "person", title: 'Ice switched off "Stamp the finish date"',
        target: { automation: AUTOMATION, path: PATH },
      }));
      // The owner's other computer reads the same change and posts the same notice once.
      await owner.store.postNotice(switchedOffNotice({ workspaceId: WORKSPACE, switched, path: PATH, ...found!, switcherName: "Ice" })!);
      await anaComputer.store.sync();
      expect((await anaComputer.store.list()).notices.filter((row) => row.kind === "automation-switched-off")).toHaveLength(1);
    });

    it("tells the owner when a person they shared with switches it off, however far back its last change is", async () => {
      // Other automations in the file changed many times in between.
      const others = Array.from({ length: 120 }, (_, index) =>
        moment(`o${index}`, `${file(true)}# ${index}\n`, `${file(true)}# ${index + 1}\n`, ana));
      const moments = [moment("m2", file(true), file(false), ana), ...others, moment("m1", file(null), file(true))];
      const found = await whoSwitchedOff(history(moments), at);
      expect(found).toMatchObject({ switchedOffBy: { kind: "person", userId: "ana" }, lastChangedBy: "owner" });
      await expect(whoChangedLast(history(moments), at)).resolves.toBe("ana");
    });

    it("blames nobody for dohc's own switch off, and skips it when finding who changed it last", async () => {
      const byDohc = [moment("m2", file(true), file(false), dohc), moment("m1", file(null), file(true), ana)];
      await expect(whoSwitchedOff(history(byDohc), at)).resolves.toBeNull();
      // Ana switches it on again after dohc switched it off; the owner switches it off.
      const later = [
        moment("m4", file(true), file(false)),
        moment("m3", file(false), file(true), ana),
        ...byDohc,
      ];
      await expect(whoSwitchedOff(history(later), at)).resolves.toMatchObject({ lastChangedBy: "ana" });
      await expect(whoChangedLast(history(byDohc), at)).resolves.toBe("ana");
    });

    it("says nothing when you switch off your own, or History does not show who changed it", async () => {
      const own = await whoSwitchedOff(history([
        moment("m2", file(true), file(false), ana),
        moment("m1", file(null), file(true), ana),
      ]), at);
      expect(switchedOffNotice({ workspaceId: WORKSPACE, switched, path: PATH, ...own!, switcherName: "Ana" })).toBeNull();
      await expect(whoSwitchedOff(history([moment("m2", file(true), file(false))]), at)).resolves.toBeNull();
    });

    it("tells who changed it last when an Edit link switches it off, and tells nobody for the link's own change", async () => {
      const link: MomentAuthor = { kind: "link", grantId: "grant-link", grantGeneration: 1, principalId: "holder" };
      const found = await whoSwitchedOff(history([
        moment("m2", file(true), file(false), link),
        moment("m1", file(null), file(true), ana),
      ]), at);
      expect(found).toMatchObject({ switchedOffBy: { kind: "link" }, lastChangedBy: "ana" });
      const switcherName = switcherNameFor({
        switchedOffBy: found!.switchedOffBy, recipient: "ana", ownerUserId: "owner", ownerName: "Ice", emailOf: () => null,
      });
      expect(switchedOffNotice({ workspaceId: WORKSPACE, switched, path: PATH, ...found!, switcherName }))
        .toMatchObject({ title: 'Someone with an Edit link switched off "Stamp the finish date"', recipientUserId: "ana" });
      // The link changed it last: it is no person to tell, and an earlier editor did not make that change.
      await expect(whoChangedLast(history([moment("m2", file(null), file(true), link), moment("m1", null, file(null), ana)]), at))
        .resolves.toBeNull();
    });

    it("names a person by email only to the owner, who shared with it", () => {
      const names = { ownerUserId: "owner", ownerName: "Ice", emailOf: (userId: string) => `${userId}@dohc.test` };
      expect(switcherNameFor({ ...names, switchedOffBy: { kind: "person", userId: "ana" }, recipient: "owner" })).toBe("ana@dohc.test");
      expect(switcherNameFor({ ...names, switchedOffBy: { kind: "person", userId: "ana" }, recipient: "ben" })).toBe("Someone");
      expect(switcherNameFor({ ...names, switchedOffBy: { kind: "person", userId: "owner" }, recipient: "ben" })).toBe("Ice");
      expect(switcherNameFor({ ...names, switchedOffBy: { kind: "link" }, recipient: "owner" })).toBe("Someone with an Edit link");
    });
  });
});
