import { describe, expect, it, vi } from "vitest";
import { createAccount } from "../server/account";
import {
  A,
  appServer,
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
import { createScopedEnds, type ScopedEnds } from "../pages/pageLive";
import { cacheScope, createReadCache, type ReadCache } from "../server/workspaceData";
import { appTeardown, createAppRunner, createWorkspaceApps, REPLACED_KEPT_MS } from "./appStore";

const app = { ...version(A, true), name: "signup" };
const still = new AbortController().signal;

function setup(
  options: {
    signIn?: ReturnType<typeof signedIn>;
    canOpen?: boolean;
    cache?: ReadCache;
    ends?: ScopedEnds;
  } = {},
) {
  const server = appServer();
  const signIn = options.signIn ?? signedIn(server);
  const runner = createAppRunner();
  const apps = createWorkspaceApps({
    signIn,
    workspaceId: "ws-1",
    runner,
    fetch: server.fetch,
    canOpen: options.canOpen ?? true,
    cache: options.cache ?? createReadCache(),
    ends: options.ends ?? createScopedEnds(),
  });
  return { server, signIn, runner, apps };
}

async function running(opened = app) {
  const context = setup();
  answerLaunch(context.server);
  expect(await context.apps.open(opened, still)).toBe(true);
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

  it("never touches the running app for a review already left, as a late Allow and open is", async () => {
    const { apps, runner } = await running();
    const left = new AbortController();
    left.abort();
    expect(await apps.open({ ...version(B, true), name: "other" }, left.signal)).toBe(false);
    expect(runner.state()).toMatchObject({ publicationId: A });
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
    // The runner's screen leaving keeps it (AppRunner.tsx).
    const kept = runner.stopped();
    runner.end((scope) => scope !== kept);
    expect(runner.stopped()).toBe(kept);
    runner.end();
    expect(runner.stopped()).toBeNull();
  });

  it("names the app it launches until the launch shows, fails or ends", async () => {
    const { server, runner, apps } = setup();
    const changed = vi.fn();
    runner.subscribe(changed);
    const release = holdGrant(server);
    const shown = apps.open(app, still);
    expect(runner.launching()).toMatchObject({ publicationId: A, name: "signup" });
    expect(changed).toHaveBeenCalled();
    release();
    expect(await shown).toBe(true);
    expect(runner.launching()).toBeNull();

    server.on("POST", "/sync/ws-1/ops/appLaunch", { status: 503 });
    const failed = apps.open(app, still);
    expect(runner.launching()).not.toBeNull();
    await expect(failed).rejects.toThrow();
    expect(runner.launching()).toBeNull();

    const answer = holdGrant(server);
    const ended = apps.open(app, still);
    changed.mockClear();
    runner.end();
    expect(runner.launching()).toBeNull();
    expect(changed).toHaveBeenCalled();
    answer();
    expect(await ended).toBe(false);
  });

  it("stops a launch's requests when it ends, at Back or a later open", async () => {
    const { server, runner, apps } = setup();
    server.on("POST", "/sync/ws-1/ops/appLaunch", () => new Promise<Answer>(() => {}));
    const grants = () => server.calls.filter((call) => call.path === "/sync/ws-1/ops/appLaunch");
    const first = apps.open(app, still);
    await vi.waitFor(() => expect(grants()).toHaveLength(1));
    void apps.open(app, still);
    expect(grants()[0]!.signal.aborted).toBe(true);
    expect(await first).toBe(false);
    await vi.waitFor(() => expect(grants()).toHaveLength(2));
    runner.end();
    expect(grants()[1]!.signal.aborted).toBe(true);
  });

  it("returns a failed launch's error, whatever a catalog check read meanwhile", async () => {
    const { server, runner, apps } = setup();
    const grant = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/appLaunch", () => grant.promise);
    server.on("POST", "/sync/ws-1/ops/apps", page([version(B, true)]));
    const launch = apps.open(app, still);
    await apps.check();
    expect(runner.launching()).not.toBeNull();
    grant.resolve({ status: 503 });
    await expect(launch).rejects.toThrow();
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
      const server = appServer();
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
        cache: createReadCache(),
        ends: createScopedEnds(),
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
      ["withdrawn", [page([version(B, true, "trip")])], true],
      ["revoked elsewhere", [page([version(A)])], true],
      [
        "a link version beside a newer one",
        [page([version(B, false, "events/signup", true)])],
        true,
      ],
      ["revoked beside a newer version", [page([version(A), version(B, true)])], true],
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

  it("keeps the owner's app running when a newer version of it replaces it", async () => {
    const owned = { ...version(A, true, "events/signup", true), name: "signup" };
    const cases: [string, Answer[], boolean][] = [
      ["replaced by a newer version", [page([version(B, false, "events/signup", true)])], false],
      ["another app's version", [page([version(B, false, "trip", true)])], true],
      ["withdrawn with no replacement", [page([])], true],
    ];
    for (const [name, answers, ends] of cases) {
      const { server, runner, apps } = await running(owned);
      server.on("POST", "/sync/ws-1/ops/apps", ...answers);
      await apps.refresh();
      expect(runner.state() === null, name).toBe(ends);
    }
  });

  it("closes a replaced owner app once it has run for the launch's lifetime", async () => {
    const owned = { ...version(A, true, "events/signup", true), name: "signup" };
    const { server, runner, apps } = await running(owned);
    const started = runner.state()?.startedAtMs ?? 0;
    const now = vi.spyOn(Date, "now").mockReturnValue(started + REPLACED_KEPT_MS);
    try {
      server.on("POST", "/sync/ws-1/ops/apps", page([version(B, false, "events/signup", true)]));
      await apps.refresh();
      expect(runner.state()).toBeNull();
    } finally {
      now.mockRestore();
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
      cache: createReadCache(),
      ends: createScopedEnds(),
    }).stop();
    expect(runner.state()).not.toBeNull();
  });
});

describe("the catalog", () => {
  it("lands only the latest read, and nothing once its sign-in has ended", async () => {
    const server = appServer();
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

  it("shows the catalog read last at once in the workspace's next store", async () => {
    const cache = createReadCache();
    const { server, apps } = setup({ cache });
    server.on("POST", "/sync/ws-1/ops/apps", page([version(A, true)]));
    await apps.refresh();
    apps.stop();
    expect(setup({ cache, signIn: signedIn(server) }).apps.state().apps).toEqual([
      version(A, true),
    ]);
  });

  it("empties at a 404 for the workspace, and a read on its way neither shows nor saves", async () => {
    const cache = createReadCache();
    const ends = createScopedEnds();
    const { server, signIn, apps } = setup({ cache, ends });
    const late = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/apps", page([version(A)]), () => late.promise);
    await apps.refresh();
    const reading = apps.refresh();
    cache.drop(cacheScope(signIn, "ws-1"));
    appTeardown(ends).hide("ws-1");
    expect(apps.state()).toEqual({ apps: null, problem: null, failures: 0 });
    late.resolve(page([version(B)]));
    await reading;
    expect(apps.state().apps).toBeNull();
    expect(cache.get(cacheScope(signIn, "ws-1"), "apps")).toBeUndefined();
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

  it("deduplicates prefetched reviews, caches them, and clears on catalog change, refusal, mutation, and teardown", async () => {
    const ends = createScopedEnds();
    const { server, apps } = setup({ ends });
    const reviewBody = (revision: number, approved = false) => ({
      status: 200,
      body: {
        ok: true,
        result: {
          ...version(A, approved),
          member: undefined,
          author: null,
          consent: null,
          scopeDigest: null,
          revocable: approved,
          authorityRevision: revision,
          createdAtMs: 1_700_000_000_000,
          publishedByAgent: null,
          capabilities: [],
          sources: [{ path: "events/signup/index.ts", byteLength: 10 }],
          approval: approved ? { approvalId: "f".repeat(32), approvedAtMs: 1 } : null,
        },
      },
    });
    const first = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/appReview", () => first.promise, reviewBody(1, true));
    apps.prefetchReview(A);
    const joined = apps.readReview(A);
    expect(server.paths().filter((path) => path.endsWith("/appReview"))).toHaveLength(1);
    first.resolve(reviewBody(1, false));
    expect((await joined).authorityRevision).toBe(1);
    expect(apps.cachedReview(A)?.authorityRevision).toBe(1);

    // Catalog change invalidates cached review whose approval or revision moved.
    server.on("POST", "/sync/ws-1/ops/apps", page([version(A, true)]));
    await apps.refresh();
    expect(apps.cachedReview(A)).toBeNull();

    // A 404/refusal drops the cached review.
    await apps.readReview(A);
    expect(apps.cachedReview(A)?.approved).toBe(true);
    server.on("POST", "/sync/ws-1/ops/appReview", { status: 404, body: { ok: false } });
    await expect(apps.readReview(A)).rejects.toMatchObject({ problem: "not-found" });
    expect(apps.cachedReview(A)).toBeNull();

    // Teardown clears cached reviews and drops late in-flight results from before teardown.
    const late = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/appReview", () => late.promise);
    const pending = apps.readReview(A);
    appTeardown(ends).hide("ws-1");
    late.resolve(reviewBody(2, true));
    await pending;
    expect(apps.cachedReview(A)).toBeNull();

    // Approve invalidates in-flight reviews so post-mutation reads never join pre-mutation ones.
    const preApprove = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/appReview", () => preApprove.promise, reviewBody(1, true));
    server.on("POST", "/sync/ws-1/ops/appApprove", {
      status: 200,
      body: {
        ok: true,
        result: { approvalId: "f".repeat(32), authorityRevision: 1, approvedAtMs: 1 },
      },
    });
    const staleRead = apps.readReview(A);
    await apps.approve(version(A));
    preApprove.resolve(reviewBody(1, false));
    await staleRead;
    expect(apps.cachedReview(A)).toBeNull();
    expect((await apps.readReview(A)).approved).toBe(true);

    // Catalog removal invalidates pending in-flight review reads so already-joined callers revalidate and never recache stale data.
    const pendingBeforeRemoval = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/appReview", () => pendingBeforeRemoval.promise, {
      status: 404,
      body: { ok: false },
    });
    const joinedBeforeRemoval = apps.readReview(A);
    server.on("POST", "/sync/ws-1/ops/apps", page([]));
    await apps.refresh();
    pendingBeforeRemoval.resolve(reviewBody(1, true));
    await expect(joinedBeforeRemoval).rejects.toMatchObject({ problem: "not-found" });
    expect(apps.cachedReview(A)).toBeNull();
  });

  it("warms the catalog silently once per store when empty, and reports failures if check joins the in-flight warm", async () => {
    const ends = createScopedEnds();
    const { server, apps } = setup({ ends });
    server.on("POST", "/sync/ws-1/ops/apps", { status: 503 });
    await apps.warm();
    expect(server.paths().some((p) => p.endsWith("/apps"))).toBe(true);
    expect(apps.state()).toEqual({ apps: null, problem: null, failures: 0 });

    // A second warm() after failure does not burst the server again.
    await apps.warm();
    expect(server.paths().filter((p) => p.endsWith("/apps"))).toHaveLength(1);

    // After teardown resets the store, warm() runs once again, and check() joining it reports errors.
    appTeardown(ends).hide("ws-1");
    const slowFail = deferred<Answer>();
    server.on("POST", "/sync/ws-1/ops/apps", () => slowFail.promise);
    const warming = apps.warm();
    const checked = apps.check();
    expect(server.paths().filter((p) => p.endsWith("/apps"))).toHaveLength(2);
    slowFail.resolve({ status: 503 });
    await Promise.all([warming, checked]);
    expect(apps.state()).toMatchObject({ problem: "server-busy", failures: 1 });
  });
});
