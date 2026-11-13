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

/** A T3 Code folder whose file names the stand-in, and a connection that keeps its sign-in beside it. */
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
    const { t3, store, connection, forward } = await setup();
    await store.save({ origin: t3.origin, token: "revoked", expiresAtMs: Date.now() + 60_000 });
    // The call with the old sign-in is on its way when the person allows dohc again.
    const late = problemOf(forward("f1"));
    await connection.signIn({ open: browser });

    expect(await late).toBe("not-allowed");

    expect((await store.load())?.token).toBe("token-1");
    await forward("f2");
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
