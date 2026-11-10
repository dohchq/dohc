import { describe, expect, it, vi } from "vitest";
import type { AccountWorkspace } from "./api";
import { createServerClient } from "./client";
import { deferred, testServer, type Answer } from "./testServer";
import { createWorkspaceList } from "./workspaceList";

const listed = (...workspaces: AccountWorkspace[]): Answer => ({ status: 200, body: { ok: true, workspaces } });
const A: AccountWorkspace = { workspaceId: "ws-a", name: "Trip", showOnPhone: true };
const B: AccountWorkspace = { workspaceId: "ws-b", name: "Budget", showOnPhone: true };
const changed = (workspaceId: string, showOnPhone: boolean): Answer => ({ status: 200, body: { ok: true, workspaceId, showOnPhone } });

/** Lets every answer already given reach the list: no timer, only the macrotask after the answers' callbacks. */
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

async function ready(server: ReturnType<typeof testServer>) {
  const list = createWorkspaceList({
    client: createServerClient({ origin: server.origin, token: "tok", fetch: server.fetch, signal: new AbortController().signal }),
    isCurrent: () => true,
  });
  list.reload();
  await vi.waitFor(() => expect(list.state().status).toBe("ready"));
  return list;
}

function shown(list: ReturnType<typeof createWorkspaceList>) {
  const state = list.state();
  if (state.status !== "ready") throw new Error(`expected ready, got ${state.status}`);
  return { values: Object.fromEntries(state.workspaces.map(entry => [entry.workspaceId, entry.showOnPhone])), pending: [...state.pending], problem: state.problem };
}

describe("Show on phone", () => {
  it("takes one change per workspace at a time, and keeps each answer when they arrive in reverse order", async () => {
    const server = testServer();
    server.on("GET", "/sync/account/workspaces", listed(A, B));
    const list = await ready(server);
    const answerA = deferred<Answer>();
    const answerB = deferred<Answer>();
    server.on("PATCH", "/sync/account/workspaces/ws-a", () => answerA.promise);
    server.on("PATCH", "/sync/account/workspaces/ws-b", () => answerB.promise);
    list.setShowOnPhone("ws-a", false);
    list.setShowOnPhone("ws-a", true);
    list.setShowOnPhone("ws-b", false);
    expect(shown(list)).toEqual({ values: { "ws-a": false, "ws-b": false }, pending: ["ws-a", "ws-b"], problem: null });
    expect(server.paths().filter(path => path.startsWith("PATCH"))).toHaveLength(2);

    server.on("GET", "/sync/account/workspaces", listed({ ...A, showOnPhone: false }, { ...B, showOnPhone: false }));
    answerB.resolve(changed("ws-b", false));
    await vi.waitFor(() => expect(shown(list).pending).toEqual(["ws-a"]));
    answerA.resolve(changed("ws-a", false));
    await vi.waitFor(() => expect(shown(list).pending).toEqual([]));
    // Once nothing waits, the list is read again.
    await vi.waitFor(() => expect(server.paths().filter(path => path === "GET /sync/account/workspaces")).toHaveLength(2));
    expect(shown(list).values).toEqual({ "ws-a": false, "ws-b": false });
  });

  it("goes back to the value the server last confirmed when a change fails", async () => {
    const server = testServer();
    server.on("GET", "/sync/account/workspaces", listed(A));
    const list = await ready(server);
    server.on("PATCH", "/sync/account/workspaces/ws-a", "offline");
    list.setShowOnPhone("ws-a", false);
    await vi.waitFor(() => expect(shown(list)).toEqual({ values: { "ws-a": true }, pending: [], problem: "offline" }));
    // The read after the change keeps its failure in view.
    await vi.waitFor(() => expect(server.paths().filter(path => path === "GET /sync/account/workspaces")).toHaveLength(2));
    expect(shown(list).problem).toBe("offline");
  });

  it("drops a list read that started before a change, and reads again after it", async () => {
    const server = testServer();
    server.on("GET", "/sync/account/workspaces", listed(A));
    const list = await ready(server);
    const staleRead = deferred<Answer>();
    server.on("GET", "/sync/account/workspaces", () => staleRead.promise);
    list.reload();
    await vi.waitFor(() => expect(server.paths().filter(path => path === "GET /sync/account/workspaces")).toHaveLength(2));
    const answer = deferred<Answer>();
    server.on("PATCH", "/sync/account/workspaces/ws-a", () => answer.promise);
    list.setShowOnPhone("ws-a", false);
    // The read from before the change answers with the old value: it must not land.
    staleRead.resolve(listed(A));
    await settled();
    expect(shown(list).values).toEqual({ "ws-a": false });
    server.on("GET", "/sync/account/workspaces", listed({ ...A, showOnPhone: false }));
    answer.resolve(changed("ws-a", false));
    await vi.waitFor(() => expect(server.paths().filter(path => path === "GET /sync/account/workspaces")).toHaveLength(3));
    await vi.waitFor(() => expect(shown(list)).toEqual({ values: { "ws-a": false }, pending: [], problem: null }));
  });
});
