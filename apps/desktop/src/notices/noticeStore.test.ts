import { open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TokenBucketLimiter } from "@dohc/service-http";
import { claimWorkspace, closeTestStorages, inspectDatabase, storagePath, createShare, testHandler, testStorage, type HandlerOverrides } from "@dohc/sync-relay/testing";
import type { SyncRelayHandler } from "@dohc/sync-relay";
import type { SyncRelayStorage } from "@dohc/sync-relay/storage";
import { type NoticeReach } from "@dohc/workspace-contracts/relay";
import { ListNoticesResult, RetryAutomationNoticeResult } from "../ipc/bridgeContract";
import { AUTOMATION_SWITCHED_OFF_BODY, AUTOMATION_SWITCHED_OFF_VIEW_BODY } from "@dohc/automation-executor/automation-failed-notice";
import { RETRY_ELSEWHERE, retryAutomationRun, retryFromFailureNotice, sendFailureNotices, switcherNameFor } from "../automations/automationNotices";
import { createAutomationWakeConsumer, createAutomationWakeIntents } from "../automations/automationWakeIntents";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";
import { NoticeNotSentError } from "@dohc/automation-executor/automation-chat";
import { createNoticeStore, type NoticeAccount, type NoticeStore, type PostNoticeInput } from "./noticeStore";

afterEach(closeTestStorages);

describe("Notice save durability", () => {
  it.each(["account"] as const)("reloads the %s list after postNotice fails to sync the directory", async (where: "local" | "account") => {
    const server = await relay();
    server.online = false;
    let fail = false;
    const error = new Error("directory sync failed");
    const laptop = await computer(where === "local" ? null : account(server, "ana"), { fileOperations: {
      platform: "linux",
      open: async (path, flags, mode) => {
        if (flags === "r") return {
          writeFile: async () => {},
          sync: async () => { if (fail) throw error; },
          close: async () => {},
        };
        return open(path, flags, mode);
      },
    } });
    await laptop.store.postNotice(notice({ noticeId: "first" }));
    await laptop.store.sync();
    fail = true;
    await expect(laptop.store.postNotice(notice({ noticeId: "second" }))).rejects.toBe(error);
    fail = false;
    await laptop.store.postNotice(notice({ noticeId: "third" }));
    await laptop.store.sync();
    const restarted = await computer(laptop.signedIn, { directory: laptop.directory });
    expect((await restarted.store.list()).notices.map(row => row.noticeId).sort()).toEqual(["first", "second", "third"]);
  });

  it.each(["account"] as const)("rejects a failed %s temp sync, preserves the old file, and permits retry", async (where: "local" | "account") => {
    const server = await relay();
    server.online = false;
    let fail = false;
    const error = new Error("sync failed");
    const close = vi.fn();
    const laptop = await computer(where === "local" ? null : account(server, "ana"), { fileOperations: {
      open: async (...args) => {
        const handle = await open(...args);
        return { writeFile: handle.writeFile.bind(handle), sync: async () => { if (fail) throw error; await handle.sync(); },
          close: async () => { close(); await handle.close(); } };
      },
    } });
    await laptop.store.postNotice(notice({ noticeId: "first" }));
    await laptop.store.sync();
    const name = (await readdir(laptop.directory)).find((entry) => entry.endsWith(".json"))!;
    const prior = await readFile(join(laptop.directory, name), "utf8");
    close.mockClear();
    fail = true;
    await expect(laptop.store.postNotice(notice({ noticeId: "failed:0" }))).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(join(laptop.directory, name), "utf8")).toBe(prior);
    expect(await readdir(laptop.directory)).toEqual([name]);
    expect((await laptop.store.list()).notices.map(row => row.noticeId)).toEqual(["first"]);
    fail = false;
    await laptop.store.postNotice(notice({ noticeId: "failed:0" }));
    await laptop.store.sync();
    expect((await computer(laptop.signedIn, { directory: laptop.directory }).then(c => c.store.list())).notices).toHaveLength(2);
  });
});

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
  // Runs after each change the store publishes, as main's listeners do.
  onChanged?: () => void;
}

function switchTo(computer: Computer, signedIn: NoticeAccount | null): void {
  computer.signedIn = signedIn;
  computer.generation += 1;
}

async function computer(
  signedIn: NoticeAccount | null,
  options: { directory?: string; outboxPostLimit?: number; installId?: string; onPersonalAgentsRevision?: Parameters<typeof createNoticeStore>[0]["onPersonalAgentsRevision"]; refusalNotices?: Parameters<typeof createNoticeStore>[0]["refusalNotices"]; dismissRefusal?: Parameters<typeof createNoticeStore>[0]["dismissRefusal"]; fileOperations?: Parameters<typeof createNoticeStore>[0]["fileOperations"] } = {},
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
    onChanged: () => { state.changes += 1; state.onChanged?.(); },
    nowMs: () => clock,
    onPersonalAgentsRevision: options.onPersonalAgentsRevision,
    refusalNotices: options.refusalNotices,
    dismissRefusal: options.dismissRefusal,
    fileOperations: options.fileOperations,
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

describe("Notices passes requested by a shared view", () => {


  it("drops a late missing-route response instead of moving Notices into another account's local list", async () => {
    const server = await relay(); server.outdated = true;
    const recipient = await computer(account(server, "owner"));
    const started = deferred(); const release = deferred();
    server.onRequest = async () => { started.resolve(); await release.promise; };
    let current = true; const syncing = recipient.store.sync(() => current);
    await started.promise; current = false; switchTo(recipient, account(server, "ben"));
    release.resolve(); await syncing;
    expect(recipient.changes).toBe(0);
    expect((await recipient.store.list()).notices).toEqual([]);
  });

  it.each(["account"] as const)("drops a late pull after the %s changes without starting a pass for another account", async change => {
    const server = await relay();
    const signedIn = account(server, "owner");
    const owner = await computer(signedIn);
    await owner.store.postNotice(notice()); await owner.store.sync();
    const recipient = await computer(signedIn);
    const started = deferred(); const response = deferred<Response>();
    const fetch = signedIn.relay.fetch!;
    signedIn.relay.fetch = async (input, init) => {
      const result = await fetch(input, init); started.resolve(); return response.promise.then(() => result);
    };
    let current = true;
    const changes = recipient.changes;
    const syncing = recipient.store.sync(() => current);
    await started.promise;
    current = false;
    if (change === "account") switchTo(recipient, account(server, "ben"));
    response.resolve(Response.json({})); await syncing;
    expect(recipient.changes).toBe(changes);
    expect((await recipient.store.list()).notices).toEqual([]);
    switchTo(recipient, signedIn);
    expect((await recipient.store.list()).notices).toEqual([]);
  });

});

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
  // Each pull hands the roster cache the account's personal agents revision,
  // so a rename on another computer reaches this one with the next pull.

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

});

describe("notices while the signed-in account changes", () => {

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

it("keeps an owner's held note available through an unavailable engine and removes it after authoritative completion", async () => {
  let available = true, owed = true;
  const coordinate = {obligationOrder: 12, checkpointSha256: "owner-only-edits", headSha256: null};
  const refusalNotices = async () => [{workspaceId: WORKSPACE, notices: !available ? null : owed ? [{
    noticeId: "owner-hold", originId: null, originSeq: null, refusalCoordinates: [coordinate], reason: "markdown-write-held",
    document: {versionId: "main", path: "trip/note.md", objectId: "note", lineageClaimId: "owner-lineage", conflictId: null},
  }] : []}];
  const first = await computer(null, {refusalNotices});
  const [shown] = (await first.store.list()).notices;
  expect(shown).toMatchObject({store: "local", workspaceId: WORKSPACE, kind: "markdown-write-held", target: {path: "trip/note.md"}});
  await first.store.mark([shown!], "read", null);
  available = false;
  const restarted = await computer(null, {directory: first.directory, refusalNotices});
  expect((await restarted.store.list()).notices).toEqual([expect.objectContaining({noticeId: "owner-hold",
    readAtMs: clock, target: {path: "trip/note.md"}, refusalCoordinates: [coordinate]})]);
  // Completion while closed is learned from the next authoritative engine read.
  owed = false;
  expect((await restarted.store.list()).notices).toHaveLength(1);
  available = true;
  expect((await restarted.store.list()).notices).toEqual([]);
  expect((await computer(null, {directory: first.directory, refusalNotices}).then(c => c.store.list())).notices).toEqual([]);
});

it("does not let a dismissed absent-head hold hide a later head for the same note", async () => {
  const firstCoordinate = {obligationOrder: 12, checkpointSha256: "accepted", headSha256: null as string | null};
  let coordinate = firstCoordinate;
  let dismissed: typeof firstCoordinate | undefined;
  let owed = true;
  const dismissRefusal = vi.fn(async (_workspace: string, _notice: string, shown: unknown[]) => {
    expect(shown).toEqual([firstCoordinate]); dismissed = firstCoordinate;
  });
  const refusalNotices = async () => [{workspaceId: WORKSPACE, notices: !owed || dismissed === coordinate ? [] : [{
    noticeId: "head-hold", originId: null, originSeq: null, refusalCoordinates: [coordinate], reason: "markdown-write-held",
    document: {versionId: "main", path: "note.md", objectId: "note", lineageClaimId: "lineage", conflictId: null},
  }]}];
  const first = await computer(null, {refusalNotices, dismissRefusal});
  await first.store.mark((await first.store.list()).notices, "dismissed", null);
  expect(owed).toBe(true);
  const restarted = await computer(null, {directory: first.directory, refusalNotices, dismissRefusal});
  expect((await restarted.store.list()).notices).toEqual([]);
  coordinate = {...firstCoordinate, headSha256: "c".repeat(64)};
  expect((await restarted.store.list()).notices).toEqual([expect.objectContaining({noticeId: "head-hold",
    kind: "markdown-write-held", readAtMs: null, target: {path: "note.md"}, refusalCoordinates: [coordinate]})]);
  owed = false;
  expect((await restarted.store.list()).notices).toEqual([]);
  expect(dismissRefusal).toHaveBeenCalledOnce();
});

it("rejects a refusal dismissal without shown coordinates", async () => {
  const dismissRefusal = vi.fn(async () => {});
  const first = await computer(null, { dismissRefusal, refusalNotices: async () => [{ workspaceId: WORKSPACE, notices: [{
    noticeId: "refusal", originId: "peer", originSeq: 1, refusalCoordinates: [{ originId: "peer", originSeq: 1 }],
    reason: "Review this file", document: null,
  }] }] });
  const [shown] = (await first.store.list()).notices;
  await expect(first.store.mark([{ ...shown!, refusalCoordinates: [] }], "dismissed", null))
    .rejects.toThrow("The engine could not dismiss this Notice. Try again.");
  expect(dismissRefusal).not.toHaveBeenCalled();
  expect((await first.store.list()).notices).toHaveLength(1);
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

describe("refusal work after quit stops it", () => {
  const first = { originId: "peer", originSeq: 1 };
  const second = { originId: "peer", originSeq: 2 };
  const hold = () => ({ started: deferred(), release: deferred() });

  // One workspace's engine with one refusal Notice. Null coordinates mean the
  // workspace could not be read.
  function engine() {
    const state = {
      coordinates: [first] as (typeof first)[] | null,
      read: null as ReturnType<typeof hold> | null,
      dismissal: null as ReturnType<typeof hold> | null,
      events: [] as string[],
    };
    const refusalNotices = vi.fn(async () => {
      const held = state.read;
      state.read = null;
      if (held) { held.started.resolve(); await held.release.promise; }
      const coordinates = state.coordinates;
      return [{ workspaceId: WORKSPACE, notices: coordinates && [{ noticeId: "refusal", ...coordinates.at(-1)!,
        refusalCoordinates: coordinates, reason: "Review this file", document: null }] }];
    });
    const dismissRefusal = vi.fn(async () => {
      const held = state.dismissal;
      state.dismissal = null;
      if (held) { held.started.resolve(); await held.release.promise; }
      state.events.push("dismissed");
    });
    return Object.assign(state, {
      refusalNotices,
      dismissRefusal,
      holdRead: () => state.read = hold(),
      holdDismissal: () => state.dismissal = hold(),
    });
  }

  // Leaves a refusal with a dismissal queued for its first coordinate and a
  // newer second coordinate still shown.
  async function withQueuedDismissal(refusals: ReturnType<typeof engine>, options: { directory?: string } = {}) {
    const each = await computer(null, { ...options, refusalNotices: refusals.refusalNotices, dismissRefusal: refusals.dismissRefusal });
    const [shown] = (await each.store.list()).notices;
    refusals.coordinates = null;
    await each.store.mark([shown!], "dismissed", null);
    refusals.coordinates = [first, second];
    const [row] = (await each.store.list()).notices;
    expect(row).toMatchObject({ noticeId: "refusal", refusalCoordinates: [second] });
    return { each, row: row! };
  }

  const localFile = (each: Computer) => readFile(join(each.directory, "local.json"), "utf8");

  it("finishes the refresh already running, skips queued ones, and returns one drain", async () => {
    const refusals = engine();
    const { each } = await withQueuedDismissal(refusals);
    const reads = refusals.refusalNotices.mock.calls.length;
    const changes = each.changes;
    refusals.coordinates = [first, second, { originId: "peer", originSeq: 3 }];
    const read = refusals.holdRead();
    const dismissal = refusals.holdDismissal();
    const running = each.store.refreshRefusals(WORKSPACE);
    await read.started.promise;
    const queued = each.store.refreshRefusals();
    const listed = each.store.list();
    const drain = each.store.stopWorkspaceRefusals();
    expect(each.store.stopWorkspaceRefusals()).toBe(drain);
    void drain.then(() => refusals.events.push("drained"));
    read.release.resolve();
    // The running refresh replays the queued dismissal before it saves.
    await dismissal.started.promise;
    expect(refusals.events).toEqual(["dismissed", "dismissed"]);
    dismissal.release.resolve();
    await drain;
    expect(refusals.events.slice(-2)).toEqual(["dismissed", "drained"]);
    await expect(running).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();
    expect((await listed).notices).toEqual([expect.objectContaining({ refusalCoordinates: [second, { originId: "peer", originSeq: 3 }] })]);
    expect(refusals.refusalNotices).toHaveBeenCalledTimes(reads + 1);
    expect(each.changes).toBe(changes + 1);
    // The running refresh's save reached the file before the drain settled.
    const restarted = await computer(null, { directory: each.directory });
    expect((await restarted.store.list()).notices).toEqual([expect.objectContaining({
      noticeId: "refusal", refusalCoordinates: [second, { originId: "peer", originSeq: 3 }] })]);
    expect(JSON.parse(await localFile(each)).rows[0].pendingRefusalDismissals).toEqual([first]);
  });

  it("rejects a refusal dismissal queued before or sent after the stop, keeping rows and queued coordinates", async () => {
    const refusals = engine();
    const { each, row } = await withQueuedDismissal(refusals);
    await each.store.postNotice(notice({ onlyHere: true }));
    const read = refusals.holdRead();
    const running = each.store.refreshRefusals(WORKSPACE);
    await read.started.promise;
    const queuedMark = expect(each.store.mark([row], "dismissed", null)).rejects.toMatchObject({ name: "AbortError" });
    const drain = each.store.stopWorkspaceRefusals();
    read.release.resolve();
    await drain;
    await running;
    const dismissals = refusals.dismissRefusal.mock.calls.length;
    const saved = await localFile(each);
    const changes = each.changes;
    await queuedMark;
    // The whole batch stops, so the other Notice in it stays too.
    await expect(each.store.mark([row, { store: "local", noticeId: "agent-run:1" }], "dismissed", null))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(refusals.dismissRefusal).toHaveBeenCalledTimes(dismissals);
    expect(await localFile(each)).toBe(saved);
    expect(each.changes).toBe(changes);
    expect(JSON.parse(saved).rows).toEqual(expect.arrayContaining([expect.objectContaining({
      noticeId: "refusal", refusalCoordinates: [second], pendingRefusalDismissals: [first], dismissedAtMs: null })]));
    expect((await each.store.list()).notices.map(listed => listed.noticeId).sort()).toEqual(["agent-run:1", "refusal"]);
    // Marking read reaches no engine, so it still works.
    await each.store.mark([row], "read", null);
    expect((await each.store.list()).notices.find(listed => listed.noticeId === "refusal")?.readAtMs).toBe(clock);
    expect(refusals.dismissRefusal).toHaveBeenCalledTimes(dismissals);
  });
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

  it.each(["edit"] as const)("keeps switch-off controls and %s recovery wording through Notice storage and IPC", async (access) => {
    const server = await relay();
    await createShare(server.handler, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana", access });
    const owner = await computer(account(server, "owner"), { installId: "install-a" });
    const ana = await computer(account(server, "ana"), { installId: "install-b" });
    const stopped = { ...report(3, { startedBy: "ana" }), failure: { ...failure(3), error: "private-step-token".repeat(200),
      switchedOff: { reason: "consecutive-timeouts" as const, collectionPath: "trip/tasks" } } };
    await sendFailureNotices(sender(owner.store, "install-a"), WORKSPACE, stopped);
    await owner.store.sync();
    await ana.store.sync();
    const ownerOther = await computer(account(server, "owner"), { installId: "install-other" });
    await ownerOther.store.sync();
    const target = { recovery: "automation-controls" as const, automation: AUTOMATION, path: "trip/tasks/automations.yaml" };
    let off = true;
    const recovery = async () => off ? target : null;
    const remoteRetry = vi.fn(async () => ({ status: "queued" as const, press: false }));
    await expect(retryAutomationRun({ notices: ownerOther.store, installId: "install-other", holds: async () => false, recovery, retry: remoteRetry },
      { workspaceId: WORKSPACE, automationId: AUTOMATION, claimId: "atc_1", startOver: false }))
      .resolves.toEqual({ status: "switched-off", target });
    expect(remoteRetry).not.toHaveBeenCalled();
    const [received] = await failedIn(ana);
    expect(received?.body).toBe(access === "edit" ? AUTOMATION_SWITCHED_OFF_BODY : AUTOMATION_SWITCHED_OFF_VIEW_BODY);
    expect((await failedIn(owner))[0]!.body.startsWith(AUTOMATION_SWITCHED_OFF_BODY)).toBe(true);
    expect(received?.target).toEqual(target);
    const retry = vi.fn(async () => ({ status: "queued" as const, press: false }));
    expect(ListNoticesResult.parse(await ana.store.list()).notices[0]!.target).toEqual(received!.target);
    expect(retry).not.toHaveBeenCalled();
    expect(await failedIn(ana)).toHaveLength(1);
    off = false;
    await expect(retryAutomationRun({ notices: ownerOther.store, installId: "install-other", holds: async () => false, recovery, retry: remoteRetry },
      { workspaceId: WORKSPACE, automationId: AUTOMATION, claimId: "atc_1", startOver: false }))
      .resolves.toMatchObject({ status: "refused", reason: RETRY_ELSEWHERE });
    const elsewhere = (await failedIn(ownerOther))[0]!;
    await expect(retryFromFailureNotice({ notices: ownerOther.store, retry: remoteRetry },
      { notice: refOf(elsewhere), account: ownerOther.signedIn!.key, startOver: false }))
      .resolves.toEqual({ status: "refused", reason: RETRY_ELSEWHERE });
    expect(remoteRetry).not.toHaveBeenCalled();
    const own = (await failedIn(owner))[0]!;
    const result = await retryFromFailureNotice({ notices: owner.store, retry }, { notice: refOf(own), account: owner.signedIn!.key, startOver: false });
    expect(RetryAutomationNoticeResult.parse(result)).toEqual(result);
    expect(result).toEqual({ status: "queued", press: false });
    expect(retry).toHaveBeenCalledOnce();
    expect(await failedIn(owner)).toHaveLength(0);
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
      { notices: owner.store, installId: "install-a", holds: async () => false, recovery: async () => null, retry },
      { workspaceId: WORKSPACE, automationId: AUTOMATION, claimId: "atc_1", startOver: false },
    )).resolves.toEqual({ status: "queued", press: false });
    expect(retry).toHaveBeenCalledTimes(1);
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
        { notices: ana.store, installId: "install-c", holds: async () => holds, recovery: async () => null, retry: own },
        { workspaceId: WORKSPACE, automationId: AUTOMATION, claimId: "atc_1", startOver: false },
      )).resolves.toEqual({ status: "queued", press: false });
    }
    expect(own).toHaveBeenCalledTimes(2);
  });

  describe("History of an automation", () => {
    it("names a person by email only to the owner, who shared with it", () => {
      const names = { ownerUserId: "owner", ownerName: "Ice", emailOf: (userId: string) => `${userId}@dohc.test` };
      expect(switcherNameFor({ ...names, switchedOffBy: { kind: "person", userId: "ana" }, recipient: "owner" })).toBe("ana@dohc.test");
      expect(switcherNameFor({ ...names, switchedOffBy: { kind: "person", userId: "ana" }, recipient: "ben" })).toBe("Someone");
      expect(switcherNameFor({ ...names, switchedOffBy: { kind: "person", userId: "owner" }, recipient: "ben" })).toBe("Ice");
      expect(switcherNameFor({ ...names, switchedOffBy: { kind: "link" }, recipient: "owner" })).toBe("Someone with an Edit link");
    });
  });
});

describe("the relay hands an agent wake to one owner computer", () => {
  const wake = { automationId: "collection:Tasks#ask", name: "Ask", depth: 2, body: "Check the task. ".repeat(100) };
  const postWake = (server: Relay) => server.storage.postAutomationWake({
    workspaceId: WORKSPACE, ownerUserId: "owner", claimId: "claim", keySeed: "hash", effectId: "claim/hash/0/wake", startedAtMs: clock, wake, senderLabel: "Ice", nowMs: clock,
  }).noticeId;

  it("keeps the full payload in main, executes on one computer, and never exposes it through the UI list", async () => {
    const server = await relay();
    const id = postWake(server);
    const laptop = await computer(account(server, "owner"), { installId: "laptop" });
    const desktop = await computer(account(server, "owner"), { installId: "desktop" });
    await Promise.all([laptop.store.sync(), desktop.store.sync()]);
    expect(await laptop.store.pendingAutomationWakes()).toEqual([{
      account: laptop.signedIn!.key, noticeId: id, workspaceId: WORKSPACE, wake,
    }]);
    expect((await laptop.store.list()).notices[0]).not.toHaveProperty("wake");
    const ran: string[] = [];
    const errors: unknown[] = [];
    const consumer = (c: Computer, name: string) => createAutomationWakeConsumer({
      intents: createAutomationWakeIntents(join(c.directory, "wakes.json")),
      pending: () => c.store.pendingAutomationWakes(),
      ready: async (intent) => c.signedIn?.key === intent.account,
      enabled: async () => true,
      enabledIfOpen: async () => true,
      dismiss: (intent) => c.store.dismissFirst({ store: "account", noticeId: intent.noticeId }, intent.account),
      wake: async (_intent, message) => { expect(message.automation.depth).toBe(2); expect(message.body).toBe(wake.body); ran.push(name); },
      onError: (error) => errors.push(error),
    });
    await Promise.all([consumer(laptop, "laptop").resume(), consumer(desktop, "desktop").resume()]);
    expect(errors).toEqual([]);
    expect(ran).toHaveLength(1);
    await Promise.all([laptop.store.sync(), desktop.store.sync()]);
    expect(await laptop.store.pendingAutomationWakes()).toEqual([]);
    expect(await desktop.store.pendingAutomationWakes()).toEqual([]);
  });

  it("removes a saved intent after ownership changes without retrying or waking", async () => {
    const server = await relay();
    postWake(server);
    const laptop = await computer(account(server, "owner"));
    await laptop.store.sync();
    const [intent] = await laptop.store.pendingAutomationWakes();
    const intents = createAutomationWakeIntents(join(laptop.directory, "wakes.json"));
    await intents.save({ ...intent!, claimed: false });
    const db = inspectDatabase(storagePath(server.storage));
    try { db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'other' WHERE workspace_id = ?").run(WORKSPACE); }
    finally { db.close(); }
    const errors: unknown[] = [];
    let wakes = 0;
    const consumer = createAutomationWakeConsumer({
      intents, pending: () => laptop.store.pendingAutomationWakes(), ready: async () => true, enabled: async () => true,
      enabledIfOpen: async () => true,
      dismiss: (row) => laptop.store.dismissFirst({ store: "account", noticeId: row.noticeId }, row.account),
      wake: async () => { wakes++; }, onError: (error) => errors.push(error),
    });
    await consumer.resume();
    await consumer.resume();
    expect(await intents.list()).toEqual([]);
    expect(await laptop.store.pendingAutomationWakes()).toEqual([]);
    expect(wakes).toBe(0);
    expect(errors).toEqual([]);
  });

  it("does not offer a wake through a share view, another account, or a stale session", async () => {
    const server = await relay();
    postWake(server);
    const laptop = await computer(account(server, "owner"));
    await laptop.store.sync();
    laptop.reach.set(WORKSPACE, { shareId: "share-view" });
    expect(await laptop.store.pendingAutomationWakes()).toEqual([]);
    laptop.reach.set(WORKSPACE, { workspaceId: WORKSPACE });
    switchTo(laptop, account(server, "ana"));
    await laptop.store.sync();
    expect(await laptop.store.pendingAutomationWakes()).toEqual([]);
    switchTo(laptop, account(server, "owner"));
    laptop.onReach = () => switchTo(laptop, account(server, "ana"));
    expect(await laptop.store.pendingAutomationWakes()).toEqual([]);
  });

  describe("when a computer quits", () => {
    const wakesOn = (c: Computer, ran: string[], errors: unknown[], overrides: Partial<Parameters<typeof createAutomationWakeConsumer>[0]> = {}) =>
      createAutomationWakeConsumer({
        intents: createAutomationWakeIntents(join(c.directory, "wakes.json")),
        pending: () => c.store.pendingAutomationWakes(),
        ready: async (intent) => c.signedIn?.key === intent.account,
        enabled: async () => true,
        enabledIfOpen: async () => true,
        dismiss: (intent) => c.store.dismissFirst({ store: "account", noticeId: intent.noticeId }, intent.account),
        wake: async () => { ran.push(c.directory); },
        onError: (error) => errors.push(error),
        ...overrides,
      });

    it("settles a claim it admitted, and after restart wakes the saved winner without dismissing again", async () => {
      const server = await relay();
      postWake(server);
      const laptop = await computer(account(server, "owner"), { installId: "laptop" });
      const desktop = await computer(account(server, "owner"), { installId: "desktop" });
      await Promise.all([laptop.store.sync(), desktop.store.sync()]);
      const ran: string[] = [];
      const errors: unknown[] = [];
      const dismiss = vi.fn((intent: { account: string; noticeId: string }) =>
        laptop.store.dismissFirst({ store: "account", noticeId: intent.noticeId }, intent.account));
      const answered = deferred();
      const reply = deferred();
      const quitting = wakesOn(laptop, ran, errors, {
        // The relay has named this computer first; its saved intent is not claimed yet.
        dismiss: async (intent) => {
          const result = await dismiss(intent);
          answered.resolve();
          await reply.promise;
          return result;
        },
        // The wake fails at quit, so the claimed winner parks.
        wake: async () => { throw new Error("dohc is quitting"); },
      });
      void quitting.resume();
      await answered.promise;
      const drain = quitting.stop();
      reply.resolve();
      await drain;
      const journal = createAutomationWakeIntents(join(laptop.directory, "wakes.json"));
      expect(await journal.list()).toEqual([expect.objectContaining({ claimed: true })]);
      expect(errors).toHaveLength(1);

      await desktop.store.sync();
      await wakesOn(desktop, ran, errors).resume();
      await wakesOn(laptop, ran, errors, { dismiss }).resume();
      expect(ran).toEqual([laptop.directory]);
      expect(dismiss).toHaveBeenCalledOnce();
      expect(await journal.list()).toEqual([]);
      expect(errors).toHaveLength(1);
    });

  });
});
