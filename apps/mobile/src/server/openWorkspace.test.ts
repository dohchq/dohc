import { describe, expect, it, vi } from "vitest";
import type { AccountWorkspace } from "./api";
import { createServerClient } from "./client";
import { createOpenWorkspace } from "./openWorkspace";
import { deferred, testServer, type Answer } from "./testServer";
import { cacheScope, createReadCache, views } from "./workspaceData";
import { createWorkspaceList } from "./workspaceList";
import { FEED_HOLD_MS } from "./workspaceReads";

const A: AccountWorkspace = { workspaceId: "ws-a", name: "Trip", showOnPhone: true };
const B: AccountWorkspace = { workspaceId: "ws-b", name: "Budget", showOnPhone: true };
const listed = (...workspaces: AccountWorkspace[]): Answer => ({ status: 200, body: { ok: true, workspaces } });
const files = { ok: true, files: [{ path: "a.md", objectId: "object-a", contentKind: "text", byteLength: 1 }], folders: [] };
const feedPath = (workspaceId: string) => `/sync/${workspaceId}/ops/changes?since=0.5.2&hold=${FEED_HOLD_MS}`;
const held = () => new Promise<Answer>(() => {});
const NOT_FOUND: Answer = { status: 404, body: { ok: false, error: "not found", code: "not_found" } };

function setup(...lists: Answer[]) {
  const server = testServer();
  server.on("GET", "/sync/account/workspaces", ...lists);
  for (const workspaceId of ["ws-a", "ws-b"]) {
    server.on("POST", `/sync/${workspaceId}/ops/listFiles`, { status: 200, body: { ok: true, result: files, cursor: "0.5.2" } });
  }
  const signIn = {
    client: createServerClient({ origin: server.origin, token: "tok", fetch: server.fetch, signal: new AbortController().signal }),
    isCurrent: () => true, origin: server.origin, userId: "u-1",
  };
  const list = createWorkspaceList(signIn);
  const cache = createReadCache();
  const open = createOpenWorkspace({ signIn, list, cache });
  open.subscribe(() => {});
  open.resume();
  list.reload();
  return { server, cache, open, scope: (workspaceId: string) => cacheScope(signIn, workspaceId) };
}

/** Opens A's files, so A's store has read something and its feed is running. */
async function readA({ server, cache, open, scope }: ReturnType<typeof setup>) {
  await vi.waitFor(() => expect(open.state().currentWorkspaceId).toBe("ws-a"));
  const a = open.state().data!;
  a.subscribe(views.files, () => {});
  await vi.waitFor(() => expect(cache.entries(scope("ws-a"))).toHaveLength(1));
  await vi.waitFor(() => expect(server.calls.filter(call => call.path === feedPath("ws-a"))).toHaveLength(1));
  return a;
}

describe("a workspace hidden from the phone elsewhere", () => {
  it("clears at the feed's 404, and the phone opens the next workspace it shows", async () => {
    const answer = deferred<Answer>();
    const context = setup(listed(A, B), listed({ ...A, showOnPhone: false }, B));
    context.server.on("GET", feedPath("ws-a"), () => answer.promise);
    context.server.on("GET", feedPath("ws-b"), held);
    const a = await readA(context);

    answer.resolve(NOT_FOUND);
    await vi.waitFor(() => expect(context.open.state().currentWorkspaceId).toBe("ws-b"));
    expect(a.state(views.files).value).toBeNull();
    expect(context.cache.entries(context.scope("ws-a"))).toEqual([]);
    expect(context.server.paths().filter(path => path === "GET /sync/account/workspaces")).toHaveLength(2);
  });

  it("leaves the phone with no workspace open when it showed no other", async () => {
    const answer = deferred<Answer>();
    const context = setup(listed(A), listed({ ...A, showOnPhone: false }));
    context.server.on("GET", feedPath("ws-a"), () => answer.promise);
    const a = await readA(context);

    answer.resolve(NOT_FOUND);
    await vi.waitFor(() => expect(context.server.paths().filter(path => path === "GET /sync/account/workspaces")).toHaveLength(2));
    await vi.waitFor(() => expect(context.open.state()).toEqual({ currentWorkspaceId: null, data: null }));
    expect(a.state(views.files).value).toBeNull();
    expect(context.cache.entries(context.scope("ws-a"))).toEqual([]);
  });
});

describe("hiding a workspace on this phone", () => {
  it("drops what the phone read of it, and opens the next", async () => {
    const context = setup(listed(A, B));
    context.server.on("GET", feedPath("ws-a"), held);
    context.server.on("GET", feedPath("ws-b"), held);
    context.server.on("PATCH", "/sync/account/workspaces/ws-a", () => new Promise<Answer>(() => {}));
    await readA(context);

    context.open.setShowOnPhone("ws-a", false);
    expect(context.open.state().currentWorkspaceId).toBe("ws-b");
    expect(context.cache.entries(context.scope("ws-a"))).toEqual([]);
  });
});

