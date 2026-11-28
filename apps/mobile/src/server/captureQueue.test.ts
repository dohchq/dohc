import { existsSync, readFileSync } from "node:fs";
import { accountWords } from "@dohc/interface-words/account";
import { describe, expect, it } from "vitest";
import { createAccount, type Account, type AccountState } from "./account";
import { CAPTURE_MAX_BODY_BYTES, capturePayloadBytes, createCaptureQueue } from "./captureQueue";
import { StoreError } from "./keptStore";
import { createOutbox } from "./outbox";
import { keptDisk } from "./testKeptDisk";
import { memoryStore, serveSessionEnd, testServer, type Answer } from "./testServer";

const ORIGIN = "https://dohc.example.com";
const CAPTURE_PATH = "/sync/ws-1/ops/captureInboxItem";
const okCapture = (): Answer => ({
  status: 200,
  body: {
    ok: true,
    result: {
      ok: true,
      path: "Inbox/2026-11-28-quick-note-aaaaaa.md",
      objectId: "obj-1",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    cursor: "0.1.1",
  },
});

const waitFor = async (check: () => boolean, limit = 100) => {
  for (let i = 0; i < limit; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for capture queue condition.");
};

function stubAccount(initial: AccountState) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    state: () => current,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next: AccountState) {
      current = next;
      for (const fn of listeners) fn();
    },
  };
}

async function signedInAccount(
  server: ReturnType<typeof testServer>,
  options: {
    userId?: string;
    onSignOut?: Parameters<typeof createAccount>[0]["onSignOut"];
  } = {},
) {
  const userId = options.userId ?? "u-1";
  const store = memoryStore({
    origin: ORIGIN,
    userId,
    token: `tok-${userId}`,
    email: `${userId}@dohc.test`,
  });
  const account = createAccount({
    store: store.store,
    fetch: server.fetch,
    onSignOut: options.onSignOut,
  });
  await account.restore();
  return account;
}

describe("captureQueue durability, offline retry, 401 hold, and Sign-out wipe", () => {
  it("persists captures across crash/relaunch and retries with the exact same requestId until saved", async () => {
    const disk = keptDisk();
    const server = testServer();
    server.on("POST", CAPTURE_PATH, () => ({
      status: 503,
      body: { ok: false, code: "server_busy" },
    }));
    const account = await signedInAccount(server);
    const store1 = disk.launch();
    const q1 = createCaptureQueue({
      store: store1,
      retryMs: () => 60_000,
    });
    const stop1 = q1.follow(account);
    await waitFor(() => q1.state().status === "ready");

    const queued = await q1.enqueue({
      workspaceId: "ws-1",
      title: "Offline thought",
      body: "Remember to pack adapter",
      kind: "note",
    });
    await waitFor(() => q1.state().lastEvent?.kind === "queued");
    expect(server.calls.filter((c) => c.path === CAPTURE_PATH)).toHaveLength(1);
    expect(disk.sql("SELECT request_id, stage FROM captures")).toEqual([
      { request_id: queued.requestId, stage: "queued" },
    ]);

    // Simulate abrupt app termination while queued, then relaunch with server back online.
    stop1();
    disk.crash();

    const savedWorkspaces: string[] = [];
    server.on("POST", CAPTURE_PATH, () => okCapture());
    const store2 = disk.launch();
    const q2 = createCaptureQueue({
      store: store2,
      retryMs: () => 10,
      onSaved: (ws) => savedWorkspaces.push(ws),
    });
    const stop2 = q2.follow(account);
    await waitFor(() => q2.state().items.length === 0 && savedWorkspaces.length === 1);
    stop2();

    const sent = server.calls
      .filter((c) => c.path === CAPTURE_PATH)
      .map((c) => c.body as Record<string, unknown>);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.requestId).toBe(queued.requestId);
    expect(sent[1]?.requestId).toBe(queued.requestId);
    expect(sent[1]).toMatchObject({
      title: "Offline thought",
      body: "Remember to pack adapter",
      kind: "note",
    });
    expect(savedWorkspaces).toEqual(["ws-1"]);
    expect(disk.sql("SELECT request_id FROM captures")).toEqual([]);
  });

  it("keeps rows through 401 and resumes only when the same account signs back in", async () => {
    const disk = keptDisk();
    const server = testServer();
    server.on("POST", CAPTURE_PATH, () => ({
      status: 401,
      body: { ok: false, code: "unauthorized" },
    }));
    const acc1 = await signedInAccount(server, { userId: "u-1" });
    const store = disk.launch();
    const queue = createCaptureQueue({ store, retryMs: () => 5 });
    const fake = stubAccount(acc1.state());
    const stop = queue.follow(fake);
    await waitFor(() => queue.state().status === "ready");

    const item = await queue.enqueue({
      workspaceId: "ws-1",
      body: "Held across 401",
      kind: "note",
    });
    await waitFor(() => server.calls.some((c) => c.path === CAPTURE_PATH));
    fake.set({
      status: "signed-out",
      origin: ORIGIN,
      ended: true,
      forgetFailed: false,
      pendingSignOut: null,
    });
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(disk.sql("SELECT request_id FROM captures")).toEqual([{ request_id: item.requestId }]);

    // Another account signing in does NOT send u-1's capture.
    const acc2 = await signedInAccount(server, { userId: "u-2" });
    server.on("POST", CAPTURE_PATH, () => okCapture());
    const callsBeforeU2 = server.calls.length;
    fake.set(acc2.state());
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(server.calls.length).toBe(callsBeforeU2);
    expect(disk.sql("SELECT request_id FROM captures")).toEqual([{ request_id: item.requestId }]);

    // Same account u-1 re-signing in sends it with the exact same requestId and clears it.
    const acc1Again = await signedInAccount(server, { userId: "u-1" });
    fake.set(acc1Again.state());
    await waitFor(() => queue.state().items.length === 0);
    stop();
    const last = server.calls.filter((c) => c.path === CAPTURE_PATH).at(-1)?.body as Record<
      string,
      unknown
    >;
    expect(last?.requestId).toBe(item.requestId);
    expect(disk.sql("SELECT request_id FROM captures")).toEqual([]);
  });

  it("marks terminal 400/refusal rows as refused and removes them on discard", async () => {
    const disk = keptDisk();
    const server = testServer();
    server.on("POST", CAPTURE_PATH, () => ({
      status: 200,
      body: {
        ok: true,
        result: {
          ok: false,
          refusal: "folder-occupied",
          reason: "A file named Inbox already exists.",
        },
        cursor: "0.1.1",
      },
    }));
    const account = await signedInAccount(server);
    const queue = createCaptureQueue({ store: disk.launch(), retryMs: () => 5 });
    const stop = queue.follow(account);
    await waitFor(() => queue.state().status === "ready");

    const item = await queue.enqueue({
      workspaceId: "ws-1",
      body: "Blocked capture",
      kind: "note",
    });
    await waitFor(() => queue.state().items[0]?.stage === "refused");
    expect(queue.state().items[0]?.reason).toBe("A file named Inbox already exists.");
    expect(queue.state().lastEvent).toMatchObject({
      kind: "refused",
      reason: "A file named Inbox already exists.",
    });
    const callsAfterRefusal = server.calls.filter((c) => c.path === CAPTURE_PATH).length;
    queue.wake();
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(server.calls.filter((c) => c.path === CAPTURE_PATH)).toHaveLength(callsAfterRefusal);

    await queue.discard(item.requestId);
    expect(queue.state().items).toEqual([]);
    expect(disk.sql("SELECT request_id FROM captures")).toEqual([]);
    stop();
  });

  it("wipes captures and WAL bytes atomically on Sign out and blocks writes while Sign-out hold stands", async () => {
    const disk = keptDisk();
    const server = testServer();
    serveSessionEnd(server);
    server.on("POST", CAPTURE_PATH, () => ({
      status: 503,
      body: { ok: false, code: "server_busy" },
    }));
    const store = disk.launch();
    const outbox = createOutbox({ store, sends: true, retryMs: () => 60_000 });
    const queue = createCaptureQueue({
      store,
      sends: true,
      held: outbox.holding,
      retryMs: () => 60_000,
    });
    const account: Account = await signedInAccount(server, {
      onSignOut: async (leave, ending) => {
        await queue.holdForSignOut();
        try {
          await outbox.signOut(leave, ending);
        } finally {
          queue.releaseSignOut();
        }
      },
    });
    const stopOutbox = outbox.follow(account);
    const stopQueue = queue.follow(account);
    await waitFor(() => outbox.state().status === "ready" && queue.state().status === "ready");

    const secret = "TOP_SECRET_PHONE_DRAFT_99182";
    await queue.enqueue({ workspaceId: "ws-1", title: "Private", body: secret, kind: "note" });
    await waitFor(() => queue.state().lastEvent?.kind === "queued");
    expect(disk.sql("SELECT request_id FROM captures")).toHaveLength(1);

    // Failed Sign-out commit keeps Sign-out hold active so no new captures can be enqueued.
    disk.failWrites = /DELETE FROM captures/;
    await expect(account.signOut()).rejects.toThrow();
    expect(outbox.holding()).toBe(true);
    await expect(
      queue.enqueue({ workspaceId: "ws-1", body: "Should be held", kind: "note" }),
    ).rejects.toThrow();
    disk.failWrites = null;

    // Succeeding Sign-out deletes captures atomically and checkpoints WAL so zero draft bytes remain.
    await account.signOut();
    expect(disk.sql("SELECT request_id FROM captures")).toEqual([]);
    expect(queue.state().items).toEqual([]);
    const dbBytes = readFileSync(disk.path);
    const walPath = `${disk.path}-wal`;
    const walBytes = existsSync(walPath) ? readFileSync(walPath) : Buffer.alloc(0);
    expect(dbBytes.includes(Buffer.from(secret))).toBe(false);
    expect(walBytes.includes(Buffer.from(secret))).toBe(false);

    stopQueue();
    stopOutbox();
  });

  it("never sends requests when sends is false and reports Sign-out counts honestly", async () => {
    const disk = keptDisk();
    disk.sql(
      "INSERT INTO captures (origin, account_id, workspace_id, request_id, payload, stage, reason) VALUES (?, ?, ?, ?, ?, 'queued', NULL)",
      ORIGIN,
      "u-1",
      "ws-1",
      "req-old",
      JSON.stringify({ body: "From earlier build", kind: "note" }),
    );
    const server = testServer();
    const account = await signedInAccount(server);
    const queue = createCaptureQueue({ store: disk.launch(), sends: false });
    expect(queue.signOutCount()).toBeNull();
    expect(accountWords.signOutBody({ unsent: 0, maySend: 0 }, null)).toContain("Inbox captures");
    const stop = queue.follow(account);
    await waitFor(() => queue.state().status === "ready");
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(server.calls.filter((c) => c.path === CAPTURE_PATH)).toEqual([]);
    expect(queue.state().items).toHaveLength(1);
    expect(queue.signOutCount()).toBe(1);
    expect(accountWords.signOutBody({ unsent: 0, maySend: 0 }, queue.signOutCount())).toContain(
      "1 Inbox capture",
    );
    await expect(
      queue.enqueue({ workspaceId: "ws-1", body: "Blocked", kind: "note" }),
    ).rejects.toThrow();
    await queue.discard("req-old");
    expect(queue.state().items).toEqual([]);
    expect(queue.signOutCount()).toBe(0);
    stop();
  });

  it("B2: parks an unreachable (404) workspace without blocking other workspaces and unparks when reachable", async () => {
    const disk = keptDisk();
    const server = testServer();
    let hiddenVisible = false;
    server.on("POST", "/sync/ws-hidden/ops/captureInboxItem", () =>
      hiddenVisible ? okCapture() : { status: 404, body: { ok: false } },
    );
    server.on("POST", "/sync/ws-visible/ops/captureInboxItem", () => okCapture());
    const account = await signedInAccount(server);
    const queue = createCaptureQueue({ store: disk.launch(), retryMs: () => 5 });
    const stop = queue.follow(account);
    await waitFor(() => queue.state().status === "ready");

    await queue.enqueue({ workspaceId: "ws-hidden", title: "Hidden note", kind: "note" });
    await queue.enqueue({ workspaceId: "ws-visible", title: "Visible note", kind: "note" });
    await waitFor(
      () =>
        queue.state().items.length === 1 &&
        queue.state().items[0]?.workspaceId === "ws-hidden" &&
        queue.state().items[0]?.stage === "queued",
    );
    const hiddenCalls = server.calls.filter((c) => c.path.includes("ws-hidden")).length;
    queue.wake("ws-visible");
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(server.calls.filter((c) => c.path.includes("ws-hidden")).length).toBe(hiddenCalls);

    hiddenVisible = true;
    queue.workspaces(["ws-hidden", "ws-visible"]);
    await waitFor(() => queue.state().items.length === 0);
    expect(disk.sql("SELECT request_id FROM captures")).toEqual([]);
    stop();
  });

  it("Sol B1: uncertain SQLite commit keeps withheld draft counted for Sign out, never sends on relaunch, and replaces in place on edit", async () => {
    const disk = keptDisk();
    const server = testServer();
    server.on("POST", CAPTURE_PATH, () => okCapture());
    const account = await signedInAccount(server);
    const real = disk.launch();
    let failFirstCommit = true;
    const flakyStore: typeof real = {
      read: (s, p) => real.read(s, p),
      checkpoint: () => real.checkpoint(),
      destroy: () => real.destroy(),
      async transaction(body) {
        const res = await real.transaction(body);
        if (failFirstCommit) {
          failFirstCommit = false;
          throw new StoreError("uncertain", "Injected uncertain commit failure");
        }
        return res;
      },
    };
    const q1 = createCaptureQueue({ store: flakyStore, retryMs: () => 5 });
    const stop1 = q1.follow(account);
    await waitFor(() => q1.state().status === "ready");

    const draftRequestId = "draft-req-stable-1";
    await expect(
      q1.enqueue({
        workspaceId: "ws-1",
        title: "Superseded draft",
        body: "Wrong text",
        kind: "note",
        requestId: draftRequestId,
      }),
    ).rejects.toThrow("Injected uncertain commit failure");
    // Sign-out count and recovery UI see the withheld row, and pump never sends it.
    expect(q1.signOutCount()).toBe(1);
    expect(q1.state().items).toHaveLength(1);
    expect(q1.state().items[0]).toMatchObject({
      requestId: draftRequestId,
      stage: "withheld",
      title: "Superseded draft",
    });
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(server.calls.filter((c) => c.path === CAPTURE_PATH)).toHaveLength(0);

    // Relaunch before user retries still never sends the withheld draft, while exposing it for Edit/Discard.
    stop1();
    const qMid = createCaptureQueue({ store: disk.launch(), retryMs: () => 5 });
    const stopMid = qMid.follow(account);
    await waitFor(() => qMid.state().status === "ready");
    await new Promise<void>((r) => setTimeout(r, 25));
    expect(server.calls.filter((c) => c.path === CAPTURE_PATH)).toHaveLength(0);
    expect(qMid.signOutCount()).toBe(1);
    expect(qMid.state().items).toHaveLength(1);
    expect(qMid.state().items[0]).toMatchObject({
      requestId: draftRequestId,
      stage: "withheld",
    });

    // Editing and re-submitting with the same draft requestId replaces the withheld draft in place.
    await qMid.enqueue({
      workspaceId: "ws-1",
      title: "Corrected draft",
      body: "Right text",
      kind: "note",
      requestId: draftRequestId,
    });
    await waitFor(() => qMid.state().items.length === 0 && qMid.signOutCount() === 0);

    // A withheld draft can also be discarded directly through the recovery control.
    disk.sql(
      "INSERT INTO captures (origin, account_id, workspace_id, request_id, payload, stage, reason) VALUES (?, ?, ?, ?, ?, 'withheld', NULL)",
      ORIGIN,
      "u-1",
      "ws-1",
      "withheld-discard-1",
      JSON.stringify({ title: "Discard me", kind: "note" }),
    );
    stopMid();
    const qDiscard = createCaptureQueue({ store: disk.launch(), retryMs: () => 5 });
    const stopDiscard = qDiscard.follow(account);
    await waitFor(() => qDiscard.state().status === "ready");
    expect(qDiscard.state().items).toHaveLength(1);
    expect(qDiscard.state().items[0]).toMatchObject({
      requestId: "withheld-discard-1",
      stage: "withheld",
    });
    await qDiscard.discard("withheld-discard-1");
    expect(qDiscard.state().items).toEqual([]);
    expect(qDiscard.signOutCount()).toBe(0);
    stopDiscard();

    const q2 = createCaptureQueue({ store: disk.launch(), retryMs: () => 5 });
    const stop2 = q2.follow(account);
    await waitFor(() => q2.state().status === "ready");
    await new Promise<void>((r) => setTimeout(r, 25));
    stop2();

    const sent = server.calls
      .filter((c) => c.path === CAPTURE_PATH)
      .map((c) => c.body as Record<string, unknown>);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      requestId: draftRequestId,
      title: "Corrected draft",
      body: "Right text",
    });
    expect(disk.sql("SELECT request_id FROM captures")).toEqual([]);
  });

  it("Neon B2 & B3: backs off if refusal persistence fails, resets sending on abort, and loads persisted rows when enqueue runs after load failure", async () => {
    const disk = keptDisk();
    disk.sql(
      "INSERT INTO captures (origin, account_id, workspace_id, request_id, payload, stage, reason) VALUES (?, ?, ?, ?, ?, 'queued', NULL)",
      ORIGIN,
      "u-1",
      "ws-1",
      "req-preexisting",
      JSON.stringify({ title: "Preexisting", kind: "note" }),
    );
    const server = testServer();
    server.on("POST", CAPTURE_PATH, (req) => {
      const b = req.body as Record<string, unknown>;
      if (b.title === "Refused once")
        return {
          status: 200,
          body: {
            ok: true,
            result: { ok: false, refusal: "folder-occupied", reason: "Occupied." },
            cursor: "0.1.1",
          },
        };
      return okCapture();
    });
    const account = await signedInAccount(server);
    const real = disk.launch();
    let failFirstRead = true;
    let failRefusalWrite = true;
    const flakyStore: typeof real = {
      checkpoint: () => real.checkpoint(),
      destroy: () => real.destroy(),
      async read(s, p) {
        if (failFirstRead) {
          failFirstRead = false;
          throw new StoreError("locked", "Locked before first unlock");
        }
        return real.read(s, p);
      },
      async transaction(body) {
        if (failRefusalWrite) {
          return real.transaction(async (sql) =>
            body({
              all: (q, p) => sql.all(q, p),
              run: async (q, p) => {
                if (q.includes("stage = 'refused'")) {
                  failRefusalWrite = false;
                  throw new StoreError("failed", "Transient refusal DB failure");
                }
                await sql.run(q, p);
              },
            }),
          );
        }
        return real.transaction(body);
      },
    };
    const retryDelays: number[] = [];
    const queue = createCaptureQueue({
      store: flakyStore,
      retryMs: (n) => {
        retryDelays.push(n);
        return 15;
      },
    });
    const stop = queue.follow(account);
    await waitFor(() => queue.state().status === "failed");

    // Enqueue after failed initial load reads preexisting rows, promotes ready, and sends both.
    await queue.enqueue({ workspaceId: "ws-1", title: "Refused once", kind: "note" });
    await waitFor(
      () =>
        queue.state().status === "ready" &&
        queue.state().items.length === 1 &&
        queue.state().items[0]?.stage === "refused",
    );
    expect(retryDelays).toEqual([1]);
    expect(
      server.calls.some(
        (c) => (c.body as Record<string, unknown>)?.requestId === "req-preexisting",
      ),
    ).toBe(true);
    stop();
  });

  it("B4: measures serialized JSON request bytes so quote-heavy notes cannot exceed relay body limit", () => {
    const quotes = '"'.repeat(140_000);
    expect(capturePayloadBytes({ body: quotes, kind: "note" })).toBeGreaterThan(
      CAPTURE_MAX_BODY_BYTES,
    );
    expect(capturePayloadBytes({ body: "Short note", kind: "note" })).toBeLessThan(
      CAPTURE_MAX_BODY_BYTES,
    );
  });

  it("Sol R2 B1: reconciles an uncertain second commit when SQLite actually committed queued", async () => {
    const disk = keptDisk();
    const server = testServer();
    server.on("POST", CAPTURE_PATH, () => okCapture());
    const account = await signedInAccount(server);
    const real = disk.launch();
    let commits = 0;
    const flakyStore: typeof real = {
      read: (s, p) => real.read(s, p),
      checkpoint: () => real.checkpoint(),
      destroy: () => real.destroy(),
      async transaction(body) {
        const res = await real.transaction(body);
        commits += 1;
        if (commits === 2) throw new StoreError("uncertain", "Injected uncertain 2nd commit");
        return res;
      },
    };
    const queue = createCaptureQueue({ store: flakyStore, retryMs: () => 5 });
    const stop = queue.follow(account);
    await waitFor(() => queue.state().status === "ready");

    const kept = await queue.enqueue({
      workspaceId: "ws-1",
      title: "Landed 2nd commit",
      kind: "note",
      requestId: "draft-2nd-commit",
    });
    expect(kept.stage).toBe("queued");
    await waitFor(() => queue.state().items.length === 0 && queue.signOutCount() === 0);
    stop();
    expect(server.calls.filter((c) => c.path === CAPTURE_PATH)).toHaveLength(1);
    expect(disk.sql("SELECT request_id FROM captures")).toEqual([]);
  });
});
