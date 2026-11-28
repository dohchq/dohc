import { describe, expect, it, vi } from "vitest";
import { appTeardown, createAppRunner } from "../apps/appStore";
import { createAccount } from "../server/account";
import { memoryStore, testServer, type Answer } from "../server/testServer";
import type { ToPage } from "./liveBridge";
import { facts, liveServer, OPEN, pageSide, ready } from "./liveFixtures";
import { createPageHost, createPageMountHold } from "./pageHost";
import {
  createPageLive,
  createScopedEnds,
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

describe("createPageMountHold", () => {
  it("preserves the mounted page key across a store replace while unsent edits remain, then advances once cleared", () => {
    const signIn = {};
    const hold = createPageMountHold();
    expect(hold.resolve(signIn, "ws-1", 1, "shared/plan.md")).toBe("1:shared/plan.md");
    expect(hold.setUnsent("1:shared/plan.md", true)).toBe(false);

    // A feed replace reopens the workspace store with a new instance while typing is unsent.
    expect(hold.resolve(signIn, "ws-1", 2, "shared/plan.md")).toBe("1:shared/plan.md");

    // Stale keys are ignored; clearing unsent on the active key asks for a catch-up render.
    expect(hold.setUnsent("0:shared/plan.md", false)).toBe(false);
    expect(hold.setUnsent("1:shared/plan.md", false)).toBe(true);
    expect(hold.resolve(signIn, "ws-1", 2, "shared/plan.md")).toBe("2:shared/plan.md");

    // Switching workspace, sign-in, or path always remounts even while unsent is true.
    hold.setUnsent("2:shared/plan.md", true);
    expect(hold.resolve(signIn, "ws-2", 3, "shared/plan.md")).toBe("3:shared/plan.md");
    hold.setUnsent("3:shared/plan.md", true);
    expect(hold.resolve({}, "ws-2", 4, "shared/plan.md")).toBe("4:shared/plan.md");
    hold.setUnsent("4:shared/plan.md", true);
    expect(hold.resolve(signIn, "ws-2", 4, "shared/other.md")).toBe("4:shared/other.md");
  });
});
