import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import { describe, expect, it, vi } from "vitest";
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
    await expect(wait(4, signal)).resolves.toEqual({hasMore: true, watched: false});
    await expect(wait(9, signal)).resolves.toEqual({hasMore: false, watched: false});
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
    await expect(wait(4, signal)).resolves.toEqual({hasMore: true, watched: false});
    expect(relay.urls.filter((url) => url.endsWith("/bootstrap"))).toHaveLength(2);
  });

  it("bounds the coordinate read and the held read with one deadline the caller can abort", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetch = async (resource: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return String(resource).endsWith("/bootstrap")
        ? Response.json({ ok: true, hasContent: true, ...IDENTITY })
        : Response.json({ ok: true, hasMore: true });
    };
    const wait = createRelayLogWait({
      workspaceId: "workspace",
      relay: { baseUrl: "http://relay.test", token: "token", fetch },
      holdMs: 25_000,
    });
    const caller = new AbortController();
    await expect(wait(4, caller.signal)).resolves.toEqual({hasMore: true, watched: false});
    expect(timeout.mock.calls).toEqual([[40_000]]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    caller.abort();
    expect(signals[0]?.aborted).toBe(true);
    timeout.mockRestore();
  });

  it("releases a refused read's body before it rejects, and still reports the refusal if that fails", async () => {
    let release!: () => void;
    let cancelled = 0;
    const refused = (status: number, cancel: () => Promise<void>) =>
      new Response(new ReadableStream({ cancel: () => { cancelled += 1; return cancel(); } }), { status });
    const answers = [
      () => refused(401, () => new Promise<void>((resolve) => { release = resolve; })),
      () => refused(401, () => Promise.reject(new Error("socket gone"))),
    ];
    const fetch = async (resource: string | URL | Request) =>
      String(resource).endsWith("/bootstrap")
        ? Response.json({ ok: true, hasContent: true, ...IDENTITY })
        : answers.shift()!();
    const wait = createRelayLogWait({
      workspaceId: "workspace",
      relay: { baseUrl: "http://relay.test", token: "token", fetch },
    });
    let settled = false;
    const first = wait(4, new AbortController().signal).finally(() => { settled = true; });
    await vi.waitFor(() => expect(cancelled).toBe(1));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(first).rejects.toBeInstanceOf(RelayUnauthorizedError);
    await expect(wait(4, new AbortController().signal)).rejects.toBeInstanceOf(RelayUnauthorizedError);
    expect(cancelled).toBe(2);
  });
});
