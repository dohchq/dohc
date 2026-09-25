import { describe, expect, it } from "vitest";
import { createRelayLogWait } from "./relayLogWait";

const IDENTITY = { replicationEpoch: "epoch-1", streamIdentity: "stream-1" };

function fakeRelay(answers: Array<{ status: number; body: unknown; afterMs?: number }>) {
  const urls: string[] = [];
  let clock = 0;
  const fetch = async (resource: string | URL | Request): Promise<Response> => {
    const url = String(resource);
    urls.push(url);
    if (url.endsWith("/bootstrap")) {
      return Response.json({ ok: true, hasContent: true, ...IDENTITY });
    }
    const answer = answers.shift()!;
    clock += answer.afterMs ?? 0;
    return Response.json(answer.body, { status: answer.status });
  };
  return { relay: { baseUrl: "http://relay.test/", token: "token", fetch }, urls, nowMs: () => clock };
}

describe("held relay log reads", () => {
  it("names the relay's coordinate once and reports whether the log moved past the cursor", async () => {
    const relay = fakeRelay([
      { status: 200, body: { ok: true, ops: [], nextCursor: 4, hasMore: true }, afterMs: 3 },
      { status: 200, body: { ok: true, ops: [], nextCursor: 9, hasMore: false }, afterMs: 25_000 },
    ]);
    const wait = createRelayLogWait({ workspaceId: "work space", ...relay, holdMs: 25_000 });
    const signal = new AbortController().signal;
    await expect(wait(4, signal)).resolves.toBe(true);
    await expect(wait(9, signal)).resolves.toBe(false);
    expect(relay.urls).toEqual([
      "http://relay.test/sync/work%20space/bootstrap",
      "http://relay.test/sync/work%20space/log?since=4&hold=25000&replicationEpoch=epoch-1&streamIdentity=stream-1",
      "http://relay.test/sync/work%20space/log?since=9&hold=25000&replicationEpoch=epoch-1&streamIdentity=stream-1",
    ]);
  });

  it("refuses a relay that answers early with no change, so the caller backs off", async () => {
    const relay = fakeRelay([
      { status: 200, body: { ok: true, ops: [], nextCursor: 4, hasMore: false }, afterMs: 10 },
    ]);
    const wait = createRelayLogWait({ workspaceId: "workspace", ...relay, holdMs: 25_000 });
    await expect(wait(4, new AbortController().signal)).rejects.toThrow(/early/u);
  });

  it("reads the coordinate again after the relay refuses it", async () => {
    const relay = fakeRelay([
      { status: 409, body: { ok: false, code: "epoch_superseded" } },
      { status: 200, body: { ok: true, ops: [], nextCursor: 4, hasMore: true } },
    ]);
    const wait = createRelayLogWait({ workspaceId: "workspace", ...relay, holdMs: 25_000 });
    const signal = new AbortController().signal;
    await expect(wait(4, signal)).rejects.toThrow(/coordinate/u);
    await expect(wait(4, signal)).resolves.toBe(true);
    expect(relay.urls.filter((url) => url.endsWith("/bootstrap"))).toHaveLength(2);
  });
});
