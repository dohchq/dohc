import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscussionActivityCapacityError,
  DiscussionActivityHub,
  linkLogWaitGroup,
} from "./discussionActivity";
import { MAX_DISCUSSION_ACTIVITY_HOLD_MS } from "./wireLimits";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import {
  appendLog,
  claimWorkspace,
  closeTestStorages,
  json,
  request,
  resolveTestActor,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

// Each origin's log starts at originSeq 0.
const firstOp = { originSeq: 0, opKind: "workspace.init", payload: {}, recordedAtMs: 1_000 };

async function ownedLog(activity = new DiscussionActivityHub()) {
  const storage = await testStorage();
  const h = testHandler(storage, { discussionActivity: activity });
  await claimWorkspace(h, "owner", "workspace");
  await appendLog(h, "owner", "workspace", [firstOp]);
  return { h, activity };
}

describe("held device log reads", () => {
  it("answers when another device appends, without serving the op", async () => {
    const { h, activity } = await ownedLog();
    let answered = false;
    const held = h(request("owner", "/sync/workspace/log?since=1&hold=30000")).finally(() => {
      answered = true;
    });
    await vi.waitFor(() => expect(activity.stats()).toEqual({ shares: 1, waiters: 1 }));
    expect(answered).toBe(false);

    await appendLog(h, "owner", "workspace", [firstOp], { originId: "origin-b" });
    const response = await held;
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, ops: [], nextCursor: 1, hasMore: true });
    expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });
  });

  it("parks again after a wake that left nothing past the cursor", async () => {
    const { h, activity } = await ownedLog();
    let answered = false;
    const held = h(request("owner", "/sync/workspace/log?since=1&hold=30000")).finally(() => {
      answered = true;
    });
    await vi.waitFor(() => expect(activity.stats().waiters).toBe(1));
    activity.wakeLog("workspace");
    await vi.waitFor(() => expect(activity.stats().waiters).toBe(1));
    expect(answered).toBe(false);

    await appendLog(h, "owner", "workspace", [firstOp], { originId: "origin-b" });
    expect(await json(await held)).toMatchObject({ hasMore: true });
  });

  it("answers at once when the log already has an op past the cursor", async () => {
    const { h, activity } = await ownedLog();
    const response = await h(request("owner", "/sync/workspace/log?since=0&hold=30000"));
    expect(await json(response)).toEqual({ ok: true, ops: [], nextCursor: 0, hasMore: true });
    expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });
  });

  it("answers with no change once the hold passes", async () => {
    const { h, activity } = await ownedLog();
    vi.useFakeTimers();
    try {
      let answered = false;
      const held = h(request("owner", "/sync/workspace/log?since=1&hold=30000")).finally(() => {
        answered = true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(activity.stats().waiters).toBe(1);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await json(await held)).toEqual({ ok: true, ops: [], nextCursor: 1, hasMore: false });
      expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a session revoked during the hold nothing about the log", async () => {
    const revoked = new Set<string>();
    const storage = await testStorage();
    const activity = new DiscussionActivityHub();
    const h = testHandler(storage, {
      discussionActivity: activity,
      resolveActor: (incoming, workspaceId) => {
        const bearer = incoming.headers.get("authorization") ?? "";
        if (revoked.has(bearer)) throw new UnauthorizedError();
        return resolveTestActor(incoming, workspaceId);
      },
    });
    await claimWorkspace(h, "owner", "workspace");
    await appendLog(h, "owner", "workspace", [firstOp]);
    // The desktop's session, and another device of the same account.
    const desktop = new Request("http://relay.test/sync/workspace/log?since=1&hold=30000", {
      headers: { authorization: "Bearer user:owner", "x-dohc-relay-client-ip": "192.0.2.10" },
    });
    const held = h(desktop);
    await vi.waitFor(() => expect(activity.stats().waiters).toBe(1));
    revoked.add("Bearer user:owner");
    storage.appendLogBatch({
      workspaceId: "workspace",
      originId: "origin-b",
      ops: [{ ...firstOp, payloadJson: "{}" }],
    });
    activity.wakeLog("workspace");
    const response = await held;
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("hasMore");
    expect(activity.stats().waiters).toBe(0);
  });

  it("releases the parked read when the device goes away", async () => {
    const { h, activity } = await ownedLog();
    const device = new AbortController();
    const held = h(request("owner", "/sync/workspace/log?since=1&hold=30000", { signal: device.signal }));
    await vi.waitFor(() => expect(activity.stats().waiters).toBe(1));
    device.abort();
    await held.catch(() => undefined);
    expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });
  });

  it("answers at once, without parking, once the account's parked reads are at capacity", async () => {
    const { h, activity } = await ownedLog(new DiscussionActivityHub({ maxWaitersPerActor: 1 }));
    const parked = h(request("owner", "/sync/workspace/log?since=1&hold=30000"));
    await vi.waitFor(() => expect(activity.stats().waiters).toBe(1));
    const capped = await h(request("owner", "/sync/workspace/log?since=1&hold=30000"));
    expect(await json(capped)).toEqual({ ok: true, ops: [], nextCursor: 1, hasMore: false });
    expect(activity.stats().waiters).toBe(1);

    await appendLog(h, "owner", "workspace", [firstOp], { originId: "origin-b" });
    expect(await json(await parked)).toMatchObject({ hasMore: true });
  });

  it("keeps the owner's capacity when link readers fill theirs", async () => {
    const { h, activity } = await ownedLog(new DiscussionActivityHub({ maxWaitersPerShare: 1 }));
    const reader = new AbortController();
    const linkRead = activity.wait(linkLogWaitGroup("workspace"), "link:reader", {
      holdMs: 30_000,
      signal: reader.signal,
      shouldPark: () => true,
    });
    expect(() =>
      activity.wait(linkLogWaitGroup("workspace"), "link:other", { holdMs: 30_000, shouldPark: () => true }),
    ).toThrow(DiscussionActivityCapacityError);

    const held = h(request("owner", "/sync/workspace/log?since=1&hold=30000"));
    await vi.waitFor(() => expect(activity.stats().waiters).toBe(2));
    await appendLog(h, "owner", "workspace", [firstOp], { originId: "origin-b" });
    expect(await json(await held)).toMatchObject({ hasMore: true });
    // The append wakes the link reader too.
    await linkRead;
    reader.abort();
    expect(activity.stats().waiters).toBe(0);
  });

  it("refuses a hold that is not an integer within the limit", async () => {
    const { h, activity } = await ownedLog();
    for (const hold of ["-1", "1.5", "soon", String(MAX_DISCUSSION_ACTIVITY_HOLD_MS + 1)]) {
      const response = await h(request("owner", `/sync/workspace/log?since=1&hold=${hold}`));
      expect(response.status, hold).toBe(400);
    }
    expect(activity.stats().waiters).toBe(0);
  });

  it("does not park a read from an account that does not own the workspace", async () => {
    const { h, activity } = await ownedLog();
    const response = await h(request("stranger", "/sync/workspace/log?since=1&hold=30000"));
    expect(response.status).toBe(404);
    expect(activity.stats().waiters).toBe(0);
  });
});
