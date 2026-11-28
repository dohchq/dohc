import { describe, expect, it, vi } from "vitest";
import { appTeardown, createAppRunner } from "../apps/appStore";
import { createAccount } from "../server/account";
import { memoryStore, testServer, type Answer } from "../server/testServer";
import type { ToPage } from "./liveBridge";
import { facts, liveServer, OPEN, pageSide, ready } from "./liveFixtures";
import { createPageHost, pageMountKey } from "./pageHost";
import {
  createPageLive,
  createScopedEnds,
  holdsMount,
  liveMark,
  type ScopedEnds,
  type WorkspaceScope,
} from "./pageLive";

function setup(scope: WorkspaceScope, pages: ScopedEnds, ...answers: Answer[]) {
  const t = liveServer(...answers);
  const injected: { mount: number; message: ToPage }[] = [];
  const host = createPageHost({
    inject: (script) =>
      injected.push({
        mount: host.state().mount,
        message: JSON.parse(script.slice("window.__dohcLive?.(".length, -"); true;".length)),
      }),
  });
  pages.add(scope, host);
  const open = () =>
    host.open((post) =>
      createPageLive({
        client: t.client,
        workspaceId: "ws-1",
        path: "notes/plan.md",
        post,
        sleep: async () => undefined,
      }),
    );
  const painted = () => host.painted(host.state().mount);
  const opens = () => t.server.paths().filter((path) => path === OPEN).length;
  return { ...t, host, injected, open, painted, opens };
}

describe("a page's web view and its session", () => {
  it("opens for the web view that drew, ends with it, and opens again in the next one", async () => {
    const t = setup({ signIn: {}, workspaceId: "ws-1" }, createScopedEnds(), ready());
    t.open();
    expect(t.host.state().live).toBeNull();
    t.painted();
    t.open();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
    t.latest().open();
    expect(t.injected).toEqual([
      { mount: 0, message: expect.objectContaining({ type: "connect" }) },
    ]);

    // The web view fails: its session ends, and none opens while the failure shows.
    t.host.gone();
    expect(t.latest().closed).toBe(true);
    expect(t.host.state()).toMatchObject({ live: null, painted: false });
    t.open();
    expect(t.host.state().live).toBeNull();

    // Try again mounts a new web view; its session opens once it draws, and connects to it alone.
    t.host.gone();
    t.open();
    expect(t.host.state().live).toBeNull();
    t.painted();
    t.open();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(2));
    t.latest().open();
    expect(t.injected.at(-1)).toEqual({
      mount: 2,
      message: expect.objectContaining({ type: "connect", gen: 1, seq: 1 }),
    });
    const live = t.host.state().live!;
    pageSide(live)(1)({ type: "state", facts: facts("live") });
    expect(liveMark(live.state())).toBe("saved");
    expect(t.opens()).toBe(2);
  });

  it("ignores a late painted report from a web view it replaced", () => {
    const t = setup({ signIn: {}, workspaceId: "ws-1" }, createScopedEnds(), ready());
    t.host.gone();
    t.host.painted(0);
    t.open();
    expect(t.host.state()).toMatchObject({ mount: 1, painted: false, live: null });
    expect(t.opens()).toBe(0);
  });
});

describe("teardown", () => {
  it("replaces the page's web view with a read-only one at Sign out, a 401, another workspace and Show on phone off", async () => {
    for (const trigger of ["sign-out", "failed sign-out", "401", "another workspace", "hidden"]) {
      const server = testServer();
      const stored = { origin: server.origin, token: "tok", userId: "u-1", email: "a@example.com" };
      const pages = createScopedEnds();
      const teardown = appTeardown(createAppRunner(), pages);
      let atDelete: object | null = null;
      const account = createAccount({
        store: memoryStore(stored).store,
        fetch: server.fetch,
        onSignOut: teardown.signOut(async (leave) => {
          atDelete = { ...t.host.state() };
          if (trigger === "failed sign-out") throw new Error("The delete failed.");
          await leave();
        }),
      });
      teardown.follow(account);
      await account.restore();
      const signedIn = account.state();
      if (signedIn.status !== "signed-in") throw Error("not signed in");
      const t = setup({ signIn: signedIn.signIn, workspaceId: "ws-1" }, pages, ready());
      t.painted();
      t.open();
      await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
      t.latest().open();
      // Ending another workspace's pages leaves this one open.
      teardown.hide("ws-2");
      expect(t.host.state().live, trigger).not.toBeNull();

      if (trigger === "sign-out" || trigger === "failed sign-out")
        await account.signOut().catch(() => undefined);
      else if (trigger === "401") {
        server.on("GET", "/sync/account/workspaces", { status: 401 });
        await signedIn.signIn.client
          .send("GET", "/sync/account/workspaces", () => null)
          .catch(() => undefined);
      } else if (trigger === "another workspace") teardown.open("ws-2");
      else teardown.hide("ws-1");

      // The editable web view heard the loss, then went: the page shows a new, read-only one.
      expect(t.latest().closed, trigger).toBe(true);
      expect(t.injected.at(-1), trigger).toEqual({
        mount: 0,
        message: expect.objectContaining({ type: "lost" }),
      });
      expect(t.host.state(), trigger).toMatchObject({ mount: 1, live: null, stopped: true });
      if (trigger.includes("sign-out"))
        expect(atDelete, trigger).toMatchObject({ mount: 1, live: null });
      // The new web view draws, and no session opens in it.
      t.painted();
      t.open();
      expect(t.host.state().live, trigger).toBeNull();
      expect(t.opens(), trigger).toBe(1);
    }
  });

  it("reaches a page before its first paint and while its web view recovers, so neither opens afterwards", async () => {
    for (const when of ["before the first paint", "while recovering"]) {
      const pages = createScopedEnds();
      const teardown = appTeardown(createAppRunner(), pages);
      const t = setup({ signIn: {}, workspaceId: "ws-1" }, pages, ready());
      if (when === "while recovering") {
        t.painted();
        t.open();
        await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
        t.host.gone();
      }
      // Show on phone off reaches the page with no session open.
      teardown.hide("ws-1");
      expect(t.host.state(), when).toMatchObject({ live: null, stopped: true });
      t.painted();
      t.open();
      expect(t.host.state().live, when).toBeNull();
      expect(t.opens(), when).toBe(when === "while recovering" ? 1 : 0);
    }
  });
});

describe("pageMountKey + holdsMount", () => {
  it("keeps the active web view mounted across a same-workspace reopen until the web view confirms whether edits remain unsent", async () => {
    const signIn = {};
    const t = setup({ signIn, workspaceId: "ws-1" }, createScopedEnds(), ready());
    const initial = pageMountKey(
      null,
      { signIn, workspaceId: "ws-1", instance: 1, path: "notes/plan.md" },
      false,
    );
    expect(initial.key).toBe("1:notes/plan.md");

    t.painted();
    t.open();
    await vi.waitFor(() => expect(t.sockets).toHaveLength(1));
    t.latest().open();
    const live = t.host.state().live!;
    const fromPage = pageSide(live)(1);
    expect(holdsMount(live.state())).toBe(true);

    // Feed replace reopens the store (instance 1 -> 2) and socket closes BEFORE even the first `live` report arrives.
    t.latest().close();
    expect(live.state()).toMatchObject({
      phase: "lost",
      facts: null,
      unsent: false,
      confirming: true,
    });
    expect(holdsMount(live.state())).toBe(true);
    const duringRace = pageMountKey(
      initial.held,
      { signIn, workspaceId: "ws-1", instance: 2, path: "notes/plan.md" },
      holdsMount(live.state()),
    );
    expect(duringRace.key).toBe("1:notes/plan.md");

    // Queued `live` report arrives while still awaiting disconnect -> stays mounted.
    fromPage({ type: "state", facts: facts("live") });
    expect(holdsMount(live.state())).toBe(true);

    // Queued web view disconnect arrives with unsent: true -> stays mounted to preserve the draft.
    fromPage({
      type: "state",
      facts: {
        status: "disconnected",
        reason: "transport-closed",
        pendingUpdates: 1,
        unsent: true,
      },
    });
    expect(holdsMount(live.state())).toBe(true);
    expect(
      pageMountKey(
        duringRace.held,
        { signIn, workspaceId: "ws-1", instance: 2, path: "notes/plan.md" },
        holdsMount(live.state()),
      ).key,
    ).toBe("1:notes/plan.md");

    // Once the web view confirms no unsent edits remain, the mount advances.
    fromPage({
      type: "state",
      facts: {
        status: "disconnected",
        reason: "transport-closed",
        pendingUpdates: 0,
        unsent: false,
      },
    });
    expect(holdsMount(live.state())).toBe(false);
    expect(
      pageMountKey(
        duringRace.held,
        { signIn, workspaceId: "ws-1", instance: 2, path: "notes/plan.md" },
        holdsMount(live.state()),
      ).key,
    ).toBe("2:notes/plan.md");

    // Switching workspace, sign-in, or path always remounts even while holding.
    expect(
      pageMountKey(
        duringRace.held,
        { signIn, workspaceId: "ws-2", instance: 3, path: "notes/plan.md" },
        true,
      ).key,
    ).toBe("3:notes/plan.md");
    expect(
      pageMountKey(
        duringRace.held,
        { signIn: {}, workspaceId: "ws-1", instance: 4, path: "notes/plan.md" },
        true,
      ).key,
    ).toBe("4:notes/plan.md");
    expect(
      pageMountKey(
        duringRace.held,
        { signIn, workspaceId: "ws-1", instance: 2, path: "notes/other.md" },
        true,
      ).key,
    ).toBe("2:notes/other.md");
  });
});
