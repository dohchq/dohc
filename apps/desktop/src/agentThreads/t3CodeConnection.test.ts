import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browser, startFakeT3Code } from "../testing/fakeT3Code";
import { T3CodeError } from "./t3Code";
import { createT3CodeConnection } from "./t3CodeConnection";
import { T3CodeSignInNotKept, createT3CodeSignInStore } from "./t3CodeSignInStore";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const cipher = (available: boolean) => ({
  isAvailable: () => available,
  encrypt: (plain: string) => Buffer.from(`sealed:${plain}`).toString("base64"),
  decrypt: (sealed: string) =>
    Buffer.from(sealed, "base64").toString("utf8").slice("sealed:".length),
});

async function setup(options: { canKeep?: boolean } = {}) {
  const t3 = await startFakeT3Code();
  cleanups.push(t3.close);
  const home = await mkdtemp(join(tmpdir(), "dohc-t3-connection-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const names = async (origin: string) => {
    await mkdir(join(home, "userdata"), { recursive: true });
    await writeFile(join(home, "userdata", "server-runtime.json"), JSON.stringify({ origin }));
  };
  await names(t3.origin);
  const store = createT3CodeSignInStore({ dir: home, cipher: cipher(options.canKeep ?? true) });
  t3.tools.t3_thread_send = () => ({ threadId: "t1", runId: "run-1" });
  const connection = createT3CodeConnection({ home, store });
  const forward = (forwardId: string) =>
    connection.forward({ threadId: "t1", message: "hello", how: "line", forwardId });
  return { t3, home, store, connection, forward, names };
}

const problemOf = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => (error instanceof T3CodeError ? error.problem : error),
  );

describe("dohc's connection to T3 Code", () => {
  it("is not allowed until the person signs in, then keeps the sign-in and forwards", async () => {
    const { t3, connection, forward } = await setup();

    expect(await connection.signedInUntil()).toBeNull();
    expect(await problemOf(forward("f1"))).toBe("not-allowed");

    await connection.signIn({ open: browser });

    expect(await connection.signedInUntil()).toBeGreaterThan(Date.now());
    await forward("f2");
    expect(t3.calls.at(-1)).toEqual({
      tool: "t3_thread_send",
      args: { threadId: "t1", message: "hello", mode: "queue", clientRequestId: "f2" },
    });
  });

  it("uses one session for its calls, and opens another after a call fails", async () => {
    const { t3, connection, forward } = await setup();
    await connection.signIn({ open: browser });

    await Promise.all([forward("f1"), forward("f2")]);
    await forward("f3");
    expect(t3.ended).toBe(0);

    // T3 Code refuses a call, as it does after it restarts: dohc ends that session.
    const send = t3.tools.t3_thread_send!;
    delete t3.tools.t3_thread_send;
    expect(await problemOf(forward("f4"))).toBe("refused");
    await vi.waitFor(() => expect(t3.ended).toBe(1));

    t3.tools.t3_thread_send = send;
    await forward("f5");
    expect(t3.calls.at(-1)?.args.clientRequestId).toBe("f5");
  });

  it("drops a sign-in T3 Code no longer takes", async () => {
    const { t3, store, connection, forward } = await setup();
    await store.save({ origin: t3.origin, token: "revoked", expiresAtMs: Date.now() + 60_000 });

    expect(await problemOf(forward("f1"))).toBe("not-allowed");

    expect(await store.load()).toBeNull();
    expect(await connection.signedInUntil()).toBeNull();
  });

  it("drops the sign-in when T3 Code moved to another address", async () => {
    const { t3, store, forward, names } = await setup();
    await store.save({ origin: t3.origin, token: "token-1", expiresAtMs: Date.now() + 60_000 });
    await names("http://127.0.0.1:1");

    expect(await problemOf(forward("f1"))).toBe("not-allowed");

    expect(await store.load()).toBeNull();
    expect(t3.calls).toEqual([]);
  });

  it("says T3 Code is not running when its file is gone, and keeps the sign-in", async () => {
    const { t3, home, store, forward } = await setup();
    await store.save({ origin: t3.origin, token: "token-1", expiresAtMs: Date.now() + 60_000 });
    await rm(join(home, "userdata"), { recursive: true });

    expect(await problemOf(forward("f1"))).toBe("not-running");

    expect(await store.load()).not.toBeNull();
  });

  it("does not send the person to T3 Code when this computer cannot keep the sign-in", async () => {
    const { t3, connection } = await setup({ canKeep: false });
    let opened = false;

    await expect(
      connection.signIn({
        open: () => {
          opened = true;
        },
      }),
    ).rejects.toBeInstanceOf(T3CodeSignInNotKept);

    expect(opened).toBe(false);
    expect(connection.canKeep()).toBe(false);
    expect(t3.registrations).toEqual([]);
  });

  it("says a thread needs more access than dohc has, and keeps the sign-in", async () => {
    const { t3, store, forward } = await setup();
    await store.save({ origin: t3.origin, token: "token-1", expiresAtMs: Date.now() + 60_000 });
    t3.refusals.t3_thread_send =
      "runtime_mode_escalation_denied: Child runtime mode full-access is broader than parent mode approval-required.";

    const refused = await forward("f1").catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(T3CodeError);
    expect((refused as T3CodeError).problem).toBe("needs-more-access");
    expect((refused as T3CodeError).message).toBe(
      "This thread runs with more access than dohc has in T3 Code. Allow dohc again, and pick the thread's mode on T3 Code's page.",
    );
    expect(await store.load()).not.toBeNull();
  });

  it("keeps a new sign-in when a call made with the old one is refused late", async () => {
    const { t3, home, store } = await setup();
    await store.save({ origin: t3.origin, token: "revoked", expiresAtMs: Date.now() + 60_000 });
    let arrived!: () => void;
    const refusalOnItsWay = new Promise<void>((resolve) => (arrived = resolve));
    let deliver!: () => void;
    const held = new Promise<void>((resolve) => (deliver = resolve));
    const connection = createT3CodeConnection({
      home,
      store,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (new Headers(init?.headers).get("authorization") === "Bearer revoked") {
          arrived();
          await held;
        }
        return response;
      },
    });
    const forward = (forwardId: string) =>
      connection.forward({ threadId: "t1", message: "hello", how: "line", forwardId });

    const late = problemOf(forward("f1"));
    await refusalOnItsWay;
    await connection.signIn({ open: browser });
    deliver();

    expect(await late).toBe("not-allowed");
    expect((await store.load())?.token).toBe("token-1");
    await forward("f2");
  });

  it("gives a call made while a new sign-in is being saved the new sign-in", async () => {
    const { t3, home, store } = await setup();
    await store.save({ origin: t3.origin, token: "revoked", expiresAtMs: Date.now() + 60_000 });
    let saving!: () => void;
    const savingStarted = new Promise<void>((resolve) => (saving = resolve));
    let finishSave!: () => void;
    const held = new Promise<void>((resolve) => (finishSave = resolve));
    const connection = createT3CodeConnection({
      home,
      store: {
        ...store,
        save: async (signIn) => {
          saving();
          await held;
          await store.save(signIn);
        },
      },
    });

    const allowed = connection.signIn({ open: browser });
    await savingStarted;
    const sent = connection.forward({
      threadId: "t1",
      message: "hello",
      how: "line",
      forwardId: "f1",
    });
    finishSave();
    await allowed;

    await sent;
    expect((await store.load())?.token).toBe("token-1");
  });

  it("says a thread is gone from T3 Code, and gives back the work a message started", async () => {
    const { t3, store, connection, forward } = await setup();
    await store.save({ origin: t3.origin, token: "token-1", expiresAtMs: Date.now() + 60_000 });

    expect(await forward("f1")).toEqual({ runId: "run-1" });

    t3.refusals.t3_thread_read = "thread_not_found: Thread t1 is no longer available.";
    const gone = await connection.thread("t1").catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(T3CodeError);
    expect((gone as T3CodeError).problem).toBe("thread-gone");
    expect((gone as T3CodeError).message).toBe("This thread is no longer in T3 Code.");
  });

  it("writes the link that opens a thread in T3 Code, from what T3 Code says of this computer", async () => {
    const { t3, home } = await setup();
    const answers = (environment: unknown) =>
      createT3CodeConnection({
        home,
        store: createT3CodeSignInStore({ dir: home, cipher: cipher(true) }),
        fetch: async (input, init) =>
          String(input) === `${t3.origin}/.well-known/t3/environment`
            ? Response.json(environment)
            : fetch(input, init),
      });

    // No sign-in is needed: the address is one anyone on the computer may read.
    expect(await answers({ environmentId: "env-1", label: "This PC" }).threadLink("t-chief")).toBe(
      "t3code://threads/env-1/t-chief",
    );
    for (const [environmentId, threadId] of [
      ["env-1/../x", "t-chief"],
      ["env 1", "t-chief"],
      ["env-1", "t-chief?prompt=run"],
      ["env-1", "t/chief"],
      ["env-1", "t#chief"],
      ["", "t-chief"],
    ]) {
      const refused = await answers({ environmentId })
        .threadLink(threadId!)
        .catch((error: unknown) => error);
      expect(refused, `${environmentId} ${threadId}`).toBeInstanceOf(T3CodeError);
      expect((refused as T3CodeError).problem).toBe("unexpected");
    }
  });

  it("forgets the sign-in on request", async () => {
    const { connection, forward } = await setup();
    await connection.signIn({ open: browser });
    await forward("f1");

    await connection.forget();

    expect(await connection.signedInUntil()).toBeNull();
    expect(await problemOf(forward("f2"))).toBe("not-allowed");
  });

  it("lists projects and threads and reads a thread through the same session", async () => {
    const { t3, connection } = await setup();
    await connection.signIn({ open: browser });
    t3.tools.t3_project_list = () => ({
      projects: [{ id: "p1", title: "dohc", archivedAt: null, deletedAt: null }],
      nextCursor: null,
    });
    t3.tools.t3_thread_list = () => ({
      threads: [
        {
          threadId: "t1",
          projectId: "p1",
          title: "Chief of Staff",
          status: "completed",
          updatedAt: "2026-11-13T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });

    expect(await connection.projects()).toEqual([{ id: "p1", title: "dohc" }]);
    expect((await connection.threads({ projectId: "p1" })).threads.map(({ id }) => id)).toEqual([
      "t1",
    ]);
  });
});
