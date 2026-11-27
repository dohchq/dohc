import { describe, expect, it, vi } from "vitest";
import type { AccountWorkspace } from "./api";
import { createServerClient } from "./client";
import { createOpenWorkspace } from "./openWorkspace";
import { deferred, testServer, type Answer } from "./testServer";
import { cacheScope, createReadCache, views } from "./workspaceData";
import { createWorkspaceList, workspaceGap } from "./workspaceList";
import { FEED_HOLD_MS } from "./workspaceReads";

const A: AccountWorkspace = {
  workspaceId: "ws-a",
  name: "Trip",
  canOpen: true,
  showOnPhone: true,
  role: "owner",
};
const B: AccountWorkspace = {
  workspaceId: "ws-b",
  name: "Budget",
  canOpen: true,
  showOnPhone: true,
  role: "owner",
};
const listed = (...workspaces: AccountWorkspace[]): Answer => ({
  status: 200,
  body: { ok: true, workspaces },
});
const files = {
  ok: true,
  files: [{ path: "a.md", objectId: "object-a", contentKind: "text", byteLength: 1 }],
  folders: [],
};
const feedPath = (workspaceId: string) =>
  `/sync/${workspaceId}/ops/changes?since=0.5.2&hold=${FEED_HOLD_MS}`;
const held = () => new Promise<Answer>(() => {});
const NOT_FOUND: Answer = {
  status: 404,
  body: { ok: false, error: "not found", code: "not_found" },
};

function setup(...lists: Answer[]) {
  const server = testServer();
  server.on("GET", "/sync/account/workspaces", ...lists);
  for (const workspaceId of ["ws-a", "ws-b"]) {
    server.on("POST", `/sync/${workspaceId}/ops/listFiles`, {
      status: 200,
      body: { ok: true, result: files, cursor: "0.5.2" },
    });
  }
  const signIn = {
    client: createServerClient({
      origin: server.origin,
      token: "tok",
      fetch: server.fetch,
      signal: new AbortController().signal,
    }),
    isCurrent: () => true,
    origin: server.origin,
    userId: "u-1",
  };
  const list = createWorkspaceList(signIn);
  const cache = createReadCache();
  const switched: ((workspaceId: string | null) => void)[] = [];
  const listReads = () => server.paths().filter((path) => path === "GET /sync/account/workspaces");
  const gone: [string, number][] = [];
  const open = createOpenWorkspace({
    signIn,
    list,
    cache,
    beforeSwitch: (workspaceId) => switched.forEach((hear) => hear(workspaceId)),
    onGone: (workspaceId) => gone.push([workspaceId, listReads().length]),
  });
  open.subscribe(() => {});
  open.resume();
  list.reload();
  /** Why no workspace is open, as every screen, Home and Chats and a page or chat alike, shows it. */
  const gap = () => workspaceGap(list.state(), open.state());
  return {
    server,
    cache,
    open,
    gap,
    switched,
    gone,
    list,
    scope: (workspaceId: string, role?: AccountWorkspace["role"]) =>
      cacheScope(signIn, workspaceId, role),
  };
}

async function readA({ server, cache, open, scope }: ReturnType<typeof setup>) {
  await vi.waitFor(() => expect(open.state().currentWorkspaceId).toBe("ws-a"));
  const a = open.state().data!;
  a.subscribe(views.files, () => {});
  await vi.waitFor(() => expect(cache.entries(scope("ws-a"))).toHaveLength(1));
  await vi.waitFor(() =>
    expect(server.calls.filter((call) => call.path === feedPath("ws-a"))).toHaveLength(1),
  );
  return a;
}

/** Lets every answer already given reach the list: no timer, only the macrotask after the answers' callbacks. */
const settledList = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a workspace hidden from the phone elsewhere", () => {
  it("clears at the feed's 404, and the phone opens the next workspace it shows", async () => {
    const answer = deferred<Answer>();
    const context = setup(listed(A, B), listed({ ...A, showOnPhone: false }, B));
    context.server.on("GET", feedPath("ws-a"), () => answer.promise);
    context.server.on("GET", feedPath("ws-b"), held);
    const a = await readA(context);

    answer.resolve(NOT_FOUND);
    await vi.waitFor(() => expect(context.open.state().currentWorkspaceId).toBe("ws-b"));
    expect(context.gap()).toBeNull();
    expect(a.state(views.files).value).toBeNull();
    expect(context.cache.entries(context.scope("ws-a"))).toEqual([]);
    expect(
      context.server.paths().filter((path) => path === "GET /sync/account/workspaces"),
    ).toHaveLength(2);
  });

  it("leaves the phone with no workspace open when it showed no other", async () => {
    const answer = deferred<Answer>();
    const context = setup(listed(A), listed({ ...A, showOnPhone: false }));
    context.server.on("GET", feedPath("ws-a"), () => answer.promise);
    const a = await readA(context);

    answer.resolve(NOT_FOUND);
    await vi.waitFor(() =>
      expect(
        context.server.paths().filter((path) => path === "GET /sync/account/workspaces"),
      ).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(context.open.state()).toEqual({
        currentWorkspaceId: null,
        data: null,
        choosing: false,
      }),
    );
    // A page or chat open over the tabs shows why, as Home and Chats do, instead of waiting on a store that's gone.
    expect(context.gap()).toEqual({ kind: "none-shown" });
    expect(a.state(views.files).value).toBeNull();
    expect(context.cache.entries(context.scope("ws-a"))).toEqual([]);
  });
});

describe("a 404 for a workspace the list still shows", () => {
  it("keeps it open, empty, as a failed read, until Try again opens it in a new store", async () => {
    const answer = deferred<Answer>();
    const context = setup(listed(A, B), listed(A, B));
    context.server.on("GET", feedPath("ws-a"), () => answer.promise, held);
    const a = await readA(context);

    answer.resolve(NOT_FOUND);
    await vi.waitFor(() =>
      expect(
        context.server.paths().filter((path) => path === "GET /sync/account/workspaces"),
      ).toHaveLength(2),
    );
    await vi.waitFor(() => expect(context.open.state().data).toBe(a));
    expect(context.gone).toEqual([["ws-a", 1]]);
    expect(context.open.state().currentWorkspaceId).toBe("ws-a");
    expect(a.state(views.files)).toMatchObject({ value: null, problem: "refused" });
    expect(context.cache.entries(context.scope("ws-a"))).toEqual([]);
    expect(
      context.server.calls.filter((call) => call.path === "/sync/ws-a/ops/listFiles"),
    ).toHaveLength(1);

    a.retry(views.files);
    const again = context.open.state().data!;
    expect(again).not.toBe(a);
    expect(again.workspaceId).toBe("ws-a");
    again.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(again.state(views.files).value).toHaveLength(1));
  });
});

describe("a workspace the server can't open yet", () => {
  it("is never opened, by itself or when chosen", async () => {
    const unsynced: AccountWorkspace = { ...A, canOpen: false };
    const context = setup(listed(unsynced, B));
    context.server.on("GET", feedPath("ws-b"), held);
    await vi.waitFor(() => expect(context.open.state().currentWorkspaceId).toBe("ws-b"));
    context.open.choose("ws-a");
    expect(context.open.state().currentWorkspaceId).toBe("ws-b");

    const alone = setup(listed(unsynced));
    await vi.waitFor(() => expect(alone.server.paths()).toContain("GET /sync/account/workspaces"));
    await settledList();
    expect(alone.open.state()).toEqual({ currentWorkspaceId: null, data: null, choosing: false });
    expect(alone.gap()).toEqual({ kind: "none-synced" });
    expect(alone.server.paths().some((path) => path.startsWith("POST /sync/ws-a/"))).toBe(false);
  });
});

describe("a switch of the open workspace", () => {
  it("tells the account before the open store stops, so its live pages end first", async () => {
    const context = setup(listed(A, B), listed(B));
    context.server.on("GET", feedPath("ws-a"), held);
    context.server.on("GET", feedPath("ws-b"), held);
    const a = await readA(context);
    const stop = vi.spyOn(a, "stop");
    const heard: [string | null, number][] = [];
    context.switched.push((workspaceId) => heard.push([workspaceId, stop.mock.calls.length]));
    // Learned from the list, as when another device hid the open workspace.
    context.list.reload();
    await vi.waitFor(() => expect(context.open.state().currentWorkspaceId).toBe("ws-b"));
    expect(heard).toEqual([["ws-b", 0]]);
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("hiding a workspace on this phone", () => {
  it("drops what the phone read of it, and opens the next", async () => {
    const context = setup(listed(A, B));
    context.server.on("GET", feedPath("ws-a"), held);
    context.server.on("GET", feedPath("ws-b"), held);
    context.server.on(
      "PATCH",
      "/sync/account/workspaces/ws-a",
      () => new Promise<Answer>(() => {}),
    );
    await readA(context);

    context.open.setShowOnPhone("ws-a", false);
    expect(context.open.state().currentWorkspaceId).toBe("ws-b");
    expect(context.cache.entries(context.scope("ws-a"))).toEqual([]);
  });
});

describe("a workspace the account joined", () => {
  async function readJoined(context: ReturnType<typeof setup>) {
    await vi.waitFor(() => expect(context.open.state().currentWorkspaceId).toBe("ws-a"));
    const data = context.open.state().data!;
    data.subscribe(views.files, () => {});
    await vi.waitFor(() => expect(data.state(views.files).value).toHaveLength(1));
    return data;
  }

  it("opens after the account's own, read-only, and afresh without its saved reads when the role changes", async () => {
    const context = setup(listed(B, { ...A, role: "member" }), listed({ ...A, role: "owner" }));
    context.server.on("GET", feedPath("ws-a"), held);
    context.server.on("GET", feedPath("ws-b"), held);
    await vi.waitFor(() => expect(context.open.state().currentWorkspaceId).toBe("ws-b"));
    expect(context.open.state().data!.joined).toBe(false);
    context.open.choose("ws-a");
    const a = await readJoined(context);
    expect(a.joined).toBe(true);

    context.list.reload();
    await vi.waitFor(() => expect(context.open.state().data).not.toBe(a));
    const now = context.open.state().data!;
    expect(now).toMatchObject({ workspaceId: "ws-a", joined: false });
    expect(now.state(views.files).value).toBeNull();
  });

  it("shows none of an Admin's saved reads once they are a Member", async () => {
    const context = setup(listed({ ...A, role: "admin" }), listed({ ...A, role: "member" }));
    context.server.on("GET", feedPath("ws-a"), held);
    const a = await readJoined(context);
    context.list.reload();
    await vi.waitFor(() => expect(context.open.state().data).not.toBe(a));
    const now = context.open.state().data!;
    expect(now).toMatchObject({ role: "member", joined: true });
    expect(now.state(views.files).value).toBeNull();
    expect(context.cache.entries(context.scope("ws-a", "member"))).toEqual([]);
  });
});
