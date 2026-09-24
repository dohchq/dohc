import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import { MAX_DISCUSSION_ACTIVITY_HOLD_MS } from "./wireLimits";
import {
  appendLog,
  claimWorkspace,
  closeTestStorages,
  json,
  request,
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

  it("answers at once when the log already has an op past the cursor", async () => {
    const { h, activity } = await ownedLog();
    const response = await h(request("owner", "/sync/workspace/log?since=0&hold=30000"));
    expect(await json(response)).toEqual({ ok: true, ops: [], nextCursor: 0, hasMore: true });
    expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });
  });

  it("answers with no change once the hold passes", async () => {
    const { h, activity } = await ownedLog();
    const response = await h(request("owner", "/sync/workspace/log?since=1&hold=20"));
    expect(await json(response)).toEqual({ ok: true, ops: [], nextCursor: 1, hasMore: false });
    expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });
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
