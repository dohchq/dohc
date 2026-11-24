import { describe, expect, it } from "vitest";
import { createAccount } from "../server/account";
import {
  A,
  ACTION,
  answerLaunch,
  B,
  grantAnswer,
  HANDOFF,
  page,
  signedIn,
  version,
} from "../server/testApps";
import {
  deferred,
  memoryStore,
  serveSessionEnd,
  testServer,
  type Answer,
} from "../server/testServer";
import { appTeardown, createAppRunner, createWorkspaceApps } from "./appStore";

const app = { ...version(A, true), name: "signup" };
const still = new AbortController().signal;

function setup(options: { signIn?: ReturnType<typeof signedIn>; canOpen?: boolean } = {}) {
  const server = testServer();
  const signIn = options.signIn ?? signedIn(server);
  const runner = createAppRunner();
  const apps = createWorkspaceApps({
    signIn,
    workspaceId: "ws-1",
    runner,
    fetch: server.fetch,
    canOpen: options.canOpen ?? true,
  });
  return { server, signIn, runner, apps };
}

async function running() {
  const context = setup();
  answerLaunch(context.server);
  expect(await context.apps.open(app, still)).toBe(true);
  expect(context.runner.state()).toMatchObject({
    publicationId: A,
    action: ACTION,
    handoff: HANDOFF,
  });
  return context;
}

/** Holds the grant until the test answers it. */
function holdGrant(server: ReturnType<typeof testServer>) {
  const held = deferred<Answer>();
  server.on("POST", "/sync/ws-1/ops/appLaunch", () => held.promise, grantAnswer);
  server.on("POST", "/api/apps/phone-launch", {
    status: 200,
    body: { action: ACTION, handoff: HANDOFF },
  });
  return () => held.resolve(grantAnswer);
}

describe("a launch", () => {
  it("remounts for each launch, and a superseded launch never shows", async () => {
    const { server, runner, apps } = setup();
    const release = holdGrant(server);
    const first = apps.open(app, still);
    expect(await apps.open(app, still)).toBe(true);
    const key = runner.state()!.key;
    release();
    expect(await first).toBe(false);
    expect(runner.state()!.key).toBe(key);
    expect(await apps.open(app, still)).toBe(true);
    expect(runner.state()!.key).not.toBe(key);
  });

  it("never shows once the review is left, the store stops, the phone signs out or the workspace changes", async () => {
    for (const end of ["review left", "store stopped", "sign-out", "workspace changed"] as const) {
      const { server, runner, apps } = setup();
      const release = holdGrant(server);
      const leaving = new AbortController();
      const launch = apps.open(app, leaving.signal);
      if (end === "review left") leaving.abort();
      else if (end === "store stopped") apps.stop();
      else if (end === "sign-out") runner.end();
      else appTeardown(runner).open("ws-2");
      release();
      expect(await launch.catch(() => false), end).toBe(false);
      expect(runner.state(), end).toBeNull();
    }
  });

  it("ends a launch that arrived as the review was left", async () => {
    const { server, runner, apps } = setup();
    answerLaunch(server);
    const leaving = new AbortController();
    // Left as the runner shows it, before the review would move to it.
    runner.subscribe(() => runner.state() && leaving.abort());
    expect(await apps.open(app, leaving.signal)).toBe(false);
    expect(runner.state()).toBeNull();
  });

  it("remembers an app whose web process died until the next launch", async () => {
    const { server, runner, apps } = await running();
    runner.stop();
    expect(runner.state()).toBeNull();
    expect(runner.stopped()).toMatchObject({ publicationId: A, workspaceId: "ws-1" });
    answerLaunch(server);
    expect(await apps.open(app, still)).toBe(true);
    expect(runner.stopped()).toBeNull();
    runner.stop();
    runner.end((scope) => scope.workspaceId !== "ws-1");
    expect(runner.stopped()).not.toBeNull();
    runner.end();
    expect(runner.stopped()).toBeNull();
  });

  it("opens nothing in a build that can't run apps", async () => {
    const { server, runner, apps } = setup({ canOpen: false });
    answerLaunch(server);
    expect(await apps.open(app, still)).toBe(false);
    expect(server.calls).toEqual([]);
    expect(runner.state()).toBeNull();
  });
});

describe("teardown", () => {
  it("ends the app before Sign out's delete, and at a 401", async () => {
    for (const end of ["sign-out", "401"] as const) {
      const server = testServer();
      serveSessionEnd(server);
      const stored = { origin: server.origin, token: "tok", userId: "u-1", email: "a@example.com" };
      const runner = createAppRunner();
      const teardown = appTeardown(runner);
      let atDelete: unknown = "not run";
      const account = createAccount({
        store: memoryStore(stored).store,
        fetch: server.fetch,
        onSignOut: teardown.signOut(async (leave) => {
          atDelete = runner.state();
          await leave();
        }),
      });
      teardown.follow(account);
      await account.restore();
      const state = account.state();
      if (state.status !== "signed-in") throw Error("not signed in");
      const apps = createWorkspaceApps({
        signIn: state.signIn,
        workspaceId: "ws-1",
        runner,
        fetch: server.fetch,
        canOpen: true,
      });
      answerLaunch(server);
      expect(await apps.open(app, still)).toBe(true);
      if (end === "sign-out") {
        await account.signOut();
        expect(atDelete).toBeNull();
      } else {
        server.on("POST", "/sync/ws-1/ops/apps", { status: 401 });
        await apps.refresh();
      }
      expect(account.state().status, end).toBe("signed-out");
      expect(runner.state(), end).toBeNull();
    }
  });

  it("ends only the changed workspace's app", async () => {
    const cases = [
      ["another workspace opens", (t: ReturnType<typeof appTeardown>) => t.open("ws-2"), true],
      ["no workspace is open", (t: ReturnType<typeof appTeardown>) => t.open(null), true],
      ["the same workspace", (t: ReturnType<typeof appTeardown>) => t.open("ws-1"), false],
      ["hidden", (t: ReturnType<typeof appTeardown>) => t.hide("ws-1"), true],
      ["another hidden", (t: ReturnType<typeof appTeardown>) => t.hide("ws-2"), false],
    ] as const;
    for (const [name, change, ends] of cases) {
      const { runner } = await running();
      change(appTeardown(runner));
      expect(runner.state() === null, name).toBe(ends);
    }
  });

  it("ends the app before Revoke is sent", async () => {
    const { server, runner, apps } = await running();
    let atRevoke: unknown = "unsent";
    server.on("POST", "/sync/ws-1/ops/appRevoke", () => {
      atRevoke = runner.state();
      return { status: 200, body: { ok: true, result: { revoked: true } } };
    });
    server.on("POST", "/sync/ws-1/ops/apps", page([version(A)]));
    await apps.revoke(A);
    expect(atRevoke).toBeNull();
    expect(apps.state().apps).toEqual([version(A)]);
  });

  it("ends the app only when a complete catalog no longer lists it approved", async () => {
    const cases: [string, Answer[], boolean][] = [
      ["withdrawn", [page([version(B, true)])], true],
      ["revoked elsewhere", [page([version(A)])], true],
      ["still approved", [page([version(A, true)])], false],
      ["a failed read", [{ status: 503 }], false],
      ["an incomplete read", [page([version(B)], B)], false],
    ];
    for (const [name, answers, ends] of cases) {
      const { server, runner, apps } = await running();
      server.on("POST", "/sync/ws-1/ops/apps", ...answers);
      await apps.refresh();
      expect(runner.state() === null, name).toBe(ends);
    }
  });

  it("keeps another workspace's app when this workspace's store stops", async () => {
    const { runner, signIn, server } = await running();
    createWorkspaceApps({
      signIn,
      workspaceId: "ws-2",
      runner,
      fetch: server.fetch,
      canOpen: true,
    }).stop();
    expect(runner.state()).not.toBeNull();
  });
});

describe("the catalog", () => {
  it("lands only the latest read, and nothing once its sign-in has ended", async () => {
    const server = testServer();
    let current = true;
    const { apps } = setup({ signIn: signedIn(server, () => current) });
    const held = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/apps", () => held.promise, page([version(B)]));
    const first = apps.refresh();
    await apps.refresh();
    held.resolve(page([version(A, true)]));
    await first;
    expect(apps.state().apps).toEqual([version(B)]);
    current = false;
    server.on("POST", "/sync/ws-1/ops/apps", page([version(A, true)]));
    await apps.refresh();
    expect(apps.state().apps).toEqual([version(B)]);
  });

  it("lets a slow read finish: a periodic check joins it instead of replacing it", async () => {
    const { server, apps } = setup();
    const held = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/apps", () => held.promise, page([version(B)]));
    const first = apps.check();
    const second = apps.check();
    expect(server.paths().filter((entry) => entry === "POST /sync/ws-1/ops/apps")).toHaveLength(1);
    held.resolve(page([version(A, true)]));
    await Promise.all([first, second]);
    expect(apps.state().apps).toEqual([version(A, true)]);
    // Once it has finished, the next check reads again.
    await apps.check();
    expect(apps.state().apps).toEqual([version(B)]);
  });

  it("counts failures and keeps what it showed", async () => {
    const { server, apps } = setup();
    server.on("POST", "/sync/ws-1/ops/apps", page([version(A)]), { status: 503 });
    await apps.refresh();
    await apps.refresh();
    expect(apps.state()).toMatchObject({ problem: "server-busy", failures: 1 });
    expect(apps.state().apps).toHaveLength(1);
  });

  it("approves an app and shows it approved, and a changed one refuses", async () => {
    const { server, apps } = setup();
    server.on("POST", "/sync/ws-1/ops/appApprove", {
      status: 200,
      body: {
        ok: true,
        result: { approvalId: "f".repeat(32), authorityRevision: 1, approvedAtMs: 1 },
      },
    });
    server.on("POST", "/sync/ws-1/ops/apps", page([version(A, true)]));
    await apps.approve(version(A));
    expect(apps.state().apps?.[0]?.approved).toBe(true);
    expect(server.calls.find((call) => call.path.endsWith("appApprove"))?.body).toEqual({
      publicationId: A,
      authorityRevision: 1,
    });
    server.on("POST", "/sync/ws-1/ops/appApprove", {
      status: 409,
      body: { ok: false, error: "This app changed. Review it again.", code: "conflict" },
    });
    await expect(apps.approve({ publicationId: A, authorityRevision: 2 })).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
