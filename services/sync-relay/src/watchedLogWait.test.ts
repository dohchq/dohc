import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub, ownerLogWaitGroup } from "./discussionActivity";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { ReplicaWatches } from "./replicaWatches";
import { appendLog, claimWorkspace, closeTestStorages, request, resolveTestActor, testHandler, testStorage } from "./testing";

const registries: ReplicaWatches[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) registry.dispose();
  vi.useRealTimers();
  await closeTestStorages();
});

async function fixture() {
  const storage = await testStorage();
  const activity = new DiscussionActivityHub();
  const state = new Set<string>();
  const watches = { watched: vi.fn((workspaceId: string) => state.has(workspaceId)) };
  const setWatched = (workspaceId: string, watched: boolean) => {
    if (watched) state.add(workspaceId); else state.delete(workspaceId);
    activity.wake(ownerLogWaitGroup(workspaceId));
  };
  let revoked = false;
  const h = testHandler(storage, {
    discussionActivity: activity,
    replicaWatches: watches,
    resolveActor: (incoming, workspaceId) => {
      if (revoked) throw new UnauthorizedError();
      return resolveTestActor(incoming, workspaceId);
    },
  });
  await claimWorkspace(h, "owner", "a");
  await claimWorkspace(h, "owner", "b");
  return { h, activity, watches, state, setWatched, revoke: () => { revoked = true; } };
}

describe("owner watched held read", () => {
  it("the real registry wakes a held read at start and at expiry without traffic", async () => {
    const storage = await testStorage();
    const activity = new DiscussionActivityHub();
    const watches = new ReplicaWatches(activity);
    registries.push(watches);
    const h = testHandler(storage, { discussionActivity: activity, replicaWatches: watches });
    await claimWorkspace(h, "owner", "a");
    vi.useFakeTimers();
    let started: Response | undefined;
    const start = h(request("owner", "/sync/a/log?since=0&hold=30000")).then(r => { started = r; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(activity.stats().waiters).toBe(1);
    watches.hold("a", "reader-request", 50);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBeDefined();
    expect(await (await start).json()).toMatchObject({ watched: true });
    let response: Response | undefined;
    const end = h(request("owner", "/sync/a/log?since=0&hold=30000&watched=1")).then(r => { response = r; return r; });
    await vi.advanceTimersByTimeAsync(49);
    expect(response).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(response).toBeDefined();
    expect(await (await end).text()).toBe('{"ok":true,"ops":[],"nextCursor":0,"hasMore":false}');
    expect(watches.stats()).toEqual({ workspaces: 0, holders: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the observation-to-park race for a watch change", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.watches.watched.mockImplementationOnce(() => false).mockImplementation(() => true);
    let response: Response | undefined;
    const held = f.h(request("owner", "/sync/a/log?since=0&hold=30000")).then(r => { response = r; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(response).toBeDefined();
    expect(await (await held).json()).toMatchObject({ watched: true });
    expect(f.activity.stats().waiters).toBe(0);
  });

  it("answers within 100 ms of a watch starting", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let response: Response | undefined;
    const held = f.h(request("owner", "/sync/a/log?since=0&hold=30000")).then(r => { response = r; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.activity.stats().waiters).toBe(1);
    f.setWatched("a", true);
    await vi.advanceTimersByTimeAsync(100);
    expect(response).toBeDefined();
    expect(await (await held).text()).toBe('{"ok":true,"ops":[],"nextCursor":0,"hasMore":false,"watched":true}');
  });

  it("answers when the reported watch expires", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.setWatched("a", true);
    let response: Response | undefined;
    const held = f.h(request("owner", "/sync/a/log?since=0&hold=30000&watched=1")).then(r => { response = r; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.activity.stats().waiters).toBe(1);
    f.setWatched("a", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(response).toBeDefined();
    expect(await (await held).text()).toBe('{"ok":true,"ops":[],"nextCursor":0,"hasMore":false}');
  });

  it("answers immediately when the watch differs before parking", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.setWatched("a", true);
    let response: Response | undefined;
    const held = f.h(request("owner", "/sync/a/log?since=0&hold=30000")).then(r => { response = r; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(response).toBeDefined();
    expect(await (await held).json()).toMatchObject({ watched: true });
    expect(f.activity.stats().waiters).toBe(0);
  });

  it("returns rows available and watched together without serving rows", async () => {
    const f = await fixture();
    await appendLog(f.h, "owner", "a", [{ originSeq: 0, opKind: "workspace.init", payload: {}, recordedAtMs: 1000 }]);
    f.setWatched("a", true);
    const held = await f.h(request("owner", "/sync/a/log?since=0&hold=30000&watched=1"));
    expect(await held.json()).toEqual({ ok: true, ops: [], nextCursor: 0, hasMore: true, watched: true });
    const page = await f.h(request("owner", "/sync/a/log?since=0"));
    expect(await page.json()).not.toHaveProperty("watched");
    expect(f.activity.stats().waiters).toBe(0);
  });

  it("clears an already expired reported watch immediately", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let response: Response | undefined;
    const held = f.h(request("owner", "/sync/a/log?since=0&hold=30000&watched=1")).then(r => { response = r; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(response).toBeDefined();
    expect(await (await held).text()).toBe('{"ok":true,"ops":[],"nextCursor":0,"hasMore":false}');
  });

  it("keeps main's unwatched bytes and full hold, including unrelated watches", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let answered = false;
    const held = f.h(request("owner", "/sync/b/log?since=7&hold=30000")).then(r => { answered = true; return r; });
    await vi.advanceTimersByTimeAsync(0);
    f.setWatched("a", true);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(answered).toBe(false);
    expect(f.activity.stats().waiters).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await held).text()).toBe('{"ok":true,"ops":[],"nextCursor":7,"hasMore":false}');
    const immediate = await f.h(request("owner", "/sync/b/log?since=7&hold=0"));
    expect(await immediate.text()).toBe('{"ok":true,"ops":[],"nextCursor":7,"hasMore":false}');
  });

  it("a non-owner gets 404 without inspecting or creating watch state", async () => {
    const f = await fixture();
    const response = await f.h(request("stranger", "/sync/a/log?since=0&hold=30000&watched=1"));
    expect(response.status).toBe(404);
    expect(f.watches.watched).not.toHaveBeenCalled();
    expect(f.state.size).toBe(0);
    expect(f.activity.stats().waiters).toBe(0);
  });

  it("a watch wake rechecks the session before disclosing its state", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const held = f.h(request("owner", "/sync/a/log?since=0&hold=30000"));
    await vi.advanceTimersByTimeAsync(0);
    f.revoke();
    f.setWatched("a", true);
    await vi.advanceTimersByTimeAsync(0);
    const response = await held;
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("watched");
  });
});
