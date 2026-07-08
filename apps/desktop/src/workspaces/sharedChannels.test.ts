import { describe, expect, it, vi } from "vitest";
import {
  ShareUnavailableError,
  SharedChannelReadOnlyError,
} from "@dohc/workspace-engine";
import { syncJoinedSharedChannels } from "./sharedChannels";
import type { JoinedSharedChannel } from "./registryStore";

// MU-C4: the desktop's best-effort refresh pass over joined shared channels.
// The engine client is injected; these tests pin the pass's CONTAINMENT
// contract — one bad share never blocks the others, revocation reports ended,
// a read-only downgrade keeps reads flowing.

const RELAY = { baseUrl: "http://relay.test", token: "token" };

function joined(overrides: Partial<JoinedSharedChannel> = {}): JoinedSharedChannel {
  return {
    shareId: "share-1",
    channelWireId: "wire-1",
    access: "read-write",
    granterEmail: "owner@example.com",
    relayUrl: "http://relay.test",
    ...overrides,
  };
}

function pullResult(applied = 0) {
  return { fetched: applied, applied, skipped: 0, nextCursor: applied };
}

describe("syncJoinedSharedChannels", () => {
  it("pushes then pulls read-write channels and only pulls read-only ones", async () => {
    const calls: string[] = [];
    const push = vi.fn(async (input: { shareId: string }) => {
      calls.push(`push:${input.shareId}`);
      return { pushed: 1 };
    });
    const pull = vi.fn(async (input: { shareId: string }) => {
      calls.push(`pull:${input.shareId}`);
      return pullResult(1);
    });
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined(), joined({ shareId: "share-ro", access: "read-only" })],
      pull,
      push,
    });
    // Push precedes pull per share (local sends land before echoes replay),
    // and the read-only share never attempts an append.
    expect(calls).toEqual(["push:share-1", "pull:share-1", "pull:share-ro"]);
    expect(result).toEqual({ endedShareIds: [], readOnlyShareIds: [], changed: true });
  });

  it("reports a revoked share as ended and keeps syncing the others", async () => {
    const push = vi.fn(async () => ({ pushed: 0 }));
    const pull = vi.fn(async (input: { shareId: string }) => {
      if (input.shareId === "share-revoked") throw new ShareUnavailableError();
      return pullResult(2);
    });
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined({ shareId: "share-revoked" }), joined({ shareId: "share-live" })],
      pull,
      push,
    });
    expect(result.endedShareIds).toEqual(["share-revoked"]);
    expect(result.changed).toBe(true);
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it("treats a read-only refusal on push as a downgrade, not a failure — the pull still runs", async () => {
    const push = vi.fn(async () => {
      throw new SharedChannelReadOnlyError();
    });
    const pull = vi.fn(async () => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined()],
      pull,
      push,
    });
    expect(result.readOnlyShareIds).toEqual(["share-1"]);
    expect(result.endedShareIds).toEqual([]);
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it("logs transient failures and never throws (a flaky share can't block the pass)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const push = vi.fn(async (input: { shareId: string }) => {
      if (input.shareId === "share-flaky") throw new Error("ECONNREFUSED");
      return { pushed: 0 };
    });
    const pull = vi.fn(async () => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined({ shareId: "share-flaky" }), joined({ shareId: "share-ok" })],
      pull,
      push,
    });
    expect(result).toEqual({ endedShareIds: [], readOnlyShareIds: [], changed: false });
    // Only the healthy share pulled; the flaky one logged and moved on.
    expect(pull).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("skips shares already marked ended", async () => {
    const push = vi.fn(async () => ({ pushed: 0 }));
    const pull = vi.fn(async () => pullResult(0));
    const result = await syncJoinedSharedChannels({
      rootDir: "/tmp/ws",
      workspaceId: "ws-1",
      relay: RELAY,
      channels: [joined({ ended: true })],
      pull,
      push,
    });
    expect(push).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
  });
});
