// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIpcPresenceTransport } from "./ipcPresenceTransport";
import type { PresenceScope } from "./presenceChannel";

// MU-C5 — the IPC-PROXIED presence transport. It must forward the scope, carry
// NO relay token, normalize the snapshot, and abort an in-flight poll over IPC
// (presenceCancel) so a workspace switch can't leak a request or repaint stale.

const SCOPE: PresenceScope = { kind: "workspace", workspaceId: "ws-a" };

const bridgeMock = {
  presencePublish: vi.fn(),
  presencePoll: vi.fn(),
  presenceCancel: vi.fn(),
};

beforeEach(() => {
  bridgeMock.presencePublish.mockReset();
  bridgeMock.presencePoll.mockReset();
  bridgeMock.presenceCancel.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("dohcDesktop", bridgeMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createIpcPresenceTransport", () => {
  it("publish forwards scope/topic/clientId/state and normalizes the snapshot", async () => {
    bridgeMock.presencePublish.mockResolvedValue({
      ok: true,
      // A peer with NO state exercises the optional→null normalization.
      snapshot: { version: 3, peers: [{ userId: "u", clientId: "c", updatedAtMs: 7 }] },
    });
    const transport = createIpcPresenceTransport(SCOPE);
    const snapshot = await transport.publish({
      topic: "chat:channel:1",
      clientId: "me",
      state: { displayName: "Me", typing: true },
    });
    expect(bridgeMock.presencePublish).toHaveBeenCalledWith({
      scope: SCOPE,
      topic: "chat:channel:1",
      clientId: "me",
      state: { displayName: "Me", typing: true },
    });
    expect(snapshot).toEqual({
      version: 3,
      peers: [{ userId: "u", clientId: "c", state: null, updatedAtMs: 7 }],
    });
  });

  it("publish throws when main reports the scope unavailable", async () => {
    bridgeMock.presencePublish.mockResolvedValue({ ok: false, reason: "unavailable" });
    const transport = createIpcPresenceTransport(SCOPE);
    await expect(
      transport.publish({ topic: "t", clientId: "me", state: null }),
    ).rejects.toThrow(/unavailable/);
  });

  it("leave publishes a leave and swallows a rejection (best-effort)", async () => {
    bridgeMock.presencePublish.mockRejectedValue(new Error("relay down"));
    const transport = createIpcPresenceTransport(SCOPE);
    await expect(transport.leave({ topic: "t", clientId: "me" })).resolves.toBeUndefined();
    expect(bridgeMock.presencePublish).toHaveBeenCalledWith({
      scope: SCOPE,
      topic: "t",
      clientId: "me",
      leave: true,
    });
  });

  it("poll returns the normalized snapshot", async () => {
    bridgeMock.presencePoll.mockResolvedValue({
      ok: true,
      snapshot: {
        version: 2,
        peers: [{ userId: "u2", clientId: "c2", state: { displayName: "Bob" }, updatedAtMs: 9 }],
      },
    });
    const transport = createIpcPresenceTransport(SCOPE);
    const controller = new AbortController();
    const snapshot = await transport.poll({ topic: "t", since: 1, signal: controller.signal });
    expect(bridgeMock.presencePoll).toHaveBeenCalledWith(
      expect.objectContaining({ scope: SCOPE, topic: "t", since: 1 }),
    );
    // A poll id is minted per call so main can target the cancel.
    expect(bridgeMock.presencePoll.mock.calls[0][0].pollId).toMatch(/^pp-/);
    expect(snapshot.peers[0].state).toEqual({ displayName: "Bob" });
  });

  it("aborting the poll signal cancels the exact in-flight poll over IPC", async () => {
    let capturedPollId = "";
    bridgeMock.presencePoll.mockImplementation(
      ({ pollId }: { pollId: string }) =>
        new Promise((resolve) => {
          capturedPollId = pollId;
          // Resolve only once the renderer has cancelled — mirrors main
          // returning "aborted" after its relay fetch is aborted.
          bridgeMock.presenceCancel.mockImplementation(async (arg: { pollId: string }) => {
            resolve({ ok: false, reason: "aborted" });
            return undefined;
          });
        }),
    );
    const transport = createIpcPresenceTransport(SCOPE);
    const controller = new AbortController();
    const pending = transport.poll({ topic: "t", since: 0, signal: controller.signal });
    // Let the poll register before aborting.
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(bridgeMock.presenceCancel).toHaveBeenCalledWith({ pollId: capturedPollId });
    expect(capturedPollId).toMatch(/^pp-/);
  });

  it("poll throws immediately if the signal is already aborted", async () => {
    const transport = createIpcPresenceTransport(SCOPE);
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.poll({ topic: "t", since: 0, signal: controller.signal }),
    ).rejects.toThrow();
    expect(bridgeMock.presencePoll).not.toHaveBeenCalled();
  });

  it("carries no relay token: only scope/topic/clientId cross the IPC boundary", async () => {
    bridgeMock.presencePublish.mockResolvedValue({
      ok: true,
      snapshot: { version: 0, peers: [] },
    });
    const transport = createIpcPresenceTransport(SCOPE);
    await transport.publish({ topic: "t", clientId: "me", state: { displayName: "Me" } });
    const arg = JSON.stringify(bridgeMock.presencePublish.mock.calls[0][0]);
    expect(arg).not.toMatch(/token|bearer|authorization/i);
  });
});
