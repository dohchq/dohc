import { describe, expect, it, vi } from "vitest";
import { ListChatChannelSharesResult, MAX_CHAT_CHANNEL_SHARE_ROWS } from "./ipc/bridgeContract";
import {
  chatShareSessionKey,
  handleRelayUnauthorized,
  readRelayChatShareLanes,
  RelaySessionError,
  awaitCredentialGeneration,
} from "./mainChatIpcHandlers";
import { createLastKnownDmRequestLanesCache } from "./workspaces/dmRequests";

describe("runtime main chat IPC boundaries", () => {
  it("rejects an identity resolved across a credential-generation change", async () => {
    let resolveIdentity!: (value: { authorUserId: string }) => void;
    const pendingIdentity = new Promise<{ authorUserId: string }>((resolve) => {
      resolveIdentity = resolve;
    });
    let generation = 1;
    const resolving = awaitCredentialGeneration({
      capturedGeneration: generation,
      currentGeneration: () => generation,
      run: () => pendingIdentity,
    });

    generation += 1;
    resolveIdentity({ authorUserId: "old-user-id" });

    await expect(resolving).rejects.toThrow("Your server session changed. Try again.");
  });
});

describe("readRelayChatShareLanes", () => {
  it("reports a session failure as signed-out, not as a transport outage", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.reject(
          new RelaySessionError("Your server session expired. Sign in again, then retry."),
        ),
      workspaceId: "workspace-1",
    });
    expect(lanes).toEqual({ state: "signed-out" });
  });

  it("maps chat rows and scopes grants to this workspace coordinate", async () => {
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              shareId: "share-mine",
              workspaceId: "workspace-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: {
                kind: "chat",
                channelWireId: "wire-1",
              },
              access: "read-only",
              grantId: "grant-mine",
              generation: 1,
            },
            {
              shareId: "share-elsewhere",
              workspaceId: "remote-2",
              recipientEmail: "bo@example.com",
              revokedAtMs: null,
              selector: { kind: "chat", channelWireId: "wire-2" },
              access: "read-write",
            },
            { shareId: "share-doc", workspaceId: "workspace-1", selector: { kind: "document" } },
          ],
          received: [
            {
              shareId: "share-in",
              granterEmail: "owner@example.com",
              selector: { kind: "chat", channelWireId: "wire-in" },
              access: "read-write",
            },
            // A group is an invitation to its channel; the folder follows.
            {
              shareId: "share-group",
              granterEmail: "owner@example.com",
              selector: {
                kind: "group",
                channelWireId: "wire-group",
                paths: ["team"],
                versionId: null,
              },
              access: "read-only",
            },
            { shareId: "share-other", selector: { kind: "document" } },
          ],
        }),
      workspaceId: "workspace-1",
    });
    expect(lanes).toEqual({
      state: "answered",
      granted: [
        {
          shareId: "share-mine",
          channelWireId: "wire-1",
          access: "read-only",
          recipientEmail: "ana@example.com",
          revokedAtMs: null,
        },
      ],
      received: [
        {
          shareId: "share-in",
          channelWireId: "wire-in",
          access: "read-write",
          granterEmail: "owner@example.com",
        },
        {
          shareId: "share-group",
          channelWireId: "wire-group",
          access: "read-only",
          granterEmail: "owner@example.com",
        },
      ],
      removed: [],
    });
  });

  it("carries the relay's removed share ids, and treats a malformed removed lane as unreachable", async () => {
    const removed = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () =>
        Promise.resolve({
          removed: [
            {
              shareId: "share-gone",
              grantId: "grant",
              message: "The owner removed your access.",
              removedAtMs: 5,
            },
            { shareId: 7 },
          ],
        }),
      workspaceId: "workspace-1",
    });
    expect(removed).toEqual({
      state: "answered",
      granted: [],
      received: [],
      removed: ["share-gone"],
    });
    const malformed = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.resolve({ removed: "share-gone" as unknown as unknown[] }),
      workspaceId: "workspace-1",
    });
    expect(malformed).toEqual({ state: "unreachable" });
  });

  // The row cap is the one door row-level validation does not cover. Every row
  // below is structurally valid. A guard that answered "answered" would hand
  // the contract parse a lane it cannot represent: the parse throws, the
  // IPC call rejects, the renderer's .catch(() => null) commits a null
  // listing, and every cached invitation and grant disappears.
  function relayRowsOverCap(lane: "granted" | "received") {
    const over = MAX_CHAT_CHANNEL_SHARE_ROWS + 1;
    const rows = Array.from({ length: over }, (_, index) => ({
      shareId: `share-${index}`,
      workspaceId: "workspace-1",
      recipientEmail: "ana@example.com",
      granterEmail: "owner@example.com",
      revokedAtMs: null,
      selector: { kind: "chat", channelWireId: `wire-${index}` },
      access: "read-write",
    }));
    return { [lane]: rows };
  }

  for (const lane of ["received"] as const) {
    it("reports a chat row with unreadable access as unreachable", async () => {
      const lanes = await readRelayChatShareLanes({
        shareIdsClaimedElsewhere: new Set<string>(),
        fetchListing: () =>
          Promise.resolve({
            granted: [
              {
                shareId: "share-corrupt",
                workspaceId: "workspace-1",
                recipientEmail: "ana@example.com",
                revokedAtMs: null,
                selector: { kind: "chat", channelWireId: "wire-corrupt" },
                access: "edit",
              },
            ],
          }),
        workspaceId: "workspace-1",
      });

      expect(lanes).toEqual({ state: "unreachable" });
    });

    it(`reports an over-cap ${lane} lane as over-limit, so cached rows survive and the surface can name it`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const lanes = await readRelayChatShareLanes({
          shareIdsClaimedElsewhere: new Set<string>(),
          fetchListing: () => Promise.resolve(relayRowsOverCap(lane)),
          workspaceId: "workspace-1",
        });
        // Not "unreachable": that word means dohc could not read the answer,
        // and it earns a Try again. This answer arrived and will arrive again
        // identically, so it carries what it observed and the limit instead,
        // and the surface names the constraint rather than posing as an
        // outage.
        expect(lanes).toEqual({
          state: "over-limit",
          lanes: [{ lane, rows: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 }],
          limit: MAX_CHAT_CHANNEL_SHARE_ROWS,
        });
        // The log refusal still names the constraint, the limit, the unit, and
        // what it observed, because nobody reads this path except through it.
        expect(warn).toHaveBeenCalledWith(
          `[desktop] relay share listing "${lane}" holds ${
            MAX_CHAT_CHANNEL_SHARE_ROWS + 1
          } rows; the cap is ${MAX_CHAT_CHANNEL_SHARE_ROWS} rows per lane. Reporting the listing over-limit, so cached rows survive and the surface can name the constraint.`,
        );
        // The guard's answer must survive the contract parse the IPC handler
        // runs immediately after it.
        expect(() =>
          ListChatChannelSharesResult.parse({
            joined: [],
            sessionKey: "https://relay.example|user-1",
            relay: lanes,
          }),
        ).not.toThrow();
      } finally {
        warn.mockRestore();
      }
    });
  }

  it("drops revoked grants, so revoking one gets an account back under the cap", async () => {
    const grantRows = (revokedFrom: number) =>
      Array.from({ length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 }, (_, index) => ({
        shareId: `share-${index}`,
        workspaceId: "workspace-1",
        recipientEmail: "ana@example.com",
        revokedAtMs: index >= revokedFrom ? 1_700_000_000_000 : null,
        selector: { kind: "chat", channelWireId: `wire-${index}` },
        access: "read-write",
      }));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const allLive = await readRelayChatShareLanes({
        shareIdsClaimedElsewhere: new Set<string>(),
        fetchListing: () =>
          Promise.resolve({ granted: grantRows(MAX_CHAT_CHANNEL_SHARE_ROWS + 1) }),
        workspaceId: "workspace-1",
      });
      expect(allLive.state).toBe("over-limit");
    } finally {
      warn.mockRestore();
    }

    // Revoke ONE. The relay still returns it, but it no longer counts, so the
    // account is back under the cap and can list again.
    const afterOneRevoke = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set<string>(),
      fetchListing: () => Promise.resolve({ granted: grantRows(MAX_CHAT_CHANNEL_SHARE_ROWS) }),
      workspaceId: "workspace-1",
    });
    expect(afterOneRevoke.state).toBe("answered");
    expect(afterOneRevoke.state === "answered" && afterOneRevoke.granted).toHaveLength(
      MAX_CHAT_CHANNEL_SHARE_ROWS,
    );
    // And no revoked row is listed at all — nothing renders them, and carrying
    // them would leave the payload unbounded while merely uncounting them.
    expect(
      afterOneRevoke.state === "answered" &&
        afterOneRevoke.granted.every((row) => row.revokedAtMs === null),
    ).toBe(true);
  });

  // Another workspace's received lane being
  // unreadable must not blank a workspace that has shares of its own. The
  // scoping runs before the cap, so the rows homed elsewhere never count
  // against this workspace's lane.
  it("still answers this workspace's shares when the rows claimed elsewhere would blow the cap", async () => {
    const claimedElsewhere = Array.from(
      { length: MAX_CHAT_CHANNEL_SHARE_ROWS + 1 },
      (_, index) => ({
        shareId: `share-other-${index}`,
        granterEmail: "owner@example.com",
        selector: { kind: "chat", channelWireId: `wire-other-${index}` },
        access: "read-write",
      }),
    );
    const lanes = await readRelayChatShareLanes({
      shareIdsClaimedElsewhere: new Set(claimedElsewhere.map((row) => row.shareId)),
      fetchListing: () =>
        Promise.resolve({
          granted: [
            {
              shareId: "share-mine",
              workspaceId: "workspace-1",
              recipientEmail: "ana@example.com",
              revokedAtMs: null,
              selector: { kind: "chat", channelWireId: "wire-mine" },
              access: "read-write",
            },
          ],
          received: [
            ...claimedElsewhere,
            {
              shareId: "share-here",
              granterEmail: "owner@example.com",
              selector: { kind: "chat", channelWireId: "wire-here" },
              access: "read-write",
            },
          ],
        }),
      workspaceId: "workspace-1",
    });
    expect(lanes.state).toBe("answered");
    expect(lanes.state === "answered" && lanes.granted).toHaveLength(1);
    expect(lanes.state === "answered" && lanes.received.map((row) => row.shareId)).toEqual([
      "share-here",
    ]);
  });
});

describe("chatShareSessionKey", () => {
  it("answers null without a session", () => {
    expect(chatShareSessionKey(null)).toBeNull();
  });

  it("differs across users, servers, and relays", () => {
    const key = chatShareSessionKey({
      serverUrl: "https://cloud.dohc.test",
      relayUrl: "https://relay.dohc.test",
      userId: "user-1",
    });
    expect(
      chatShareSessionKey({
        serverUrl: "https://cloud.dohc.test",
        relayUrl: "https://relay.dohc.test",
        userId: "user-2",
      }),
    ).not.toBe(key);
    expect(
      chatShareSessionKey({
        serverUrl: "https://other.dohc.test",
        relayUrl: "https://relay.dohc.test",
        userId: "user-1",
      }),
    ).not.toBe(key);
    // The same account on another relay has different rows: its cache must
    // not carry over — including from a session with no relay configured.
    expect(
      chatShareSessionKey({
        serverUrl: "https://cloud.dohc.test",
        relayUrl: "https://relay-b.dohc.test",
        userId: "user-1",
      }),
    ).not.toBe(key);
    expect(
      chatShareSessionKey({ serverUrl: "https://cloud.dohc.test", userId: "user-1" }),
    ).not.toBe(key);
  });
});

// A relay 401 acts if and only if it belongs to the current credentials, and
// then it acts completely: memory, broadcast, persistent store — in that
// order, so views re-scope immediately and a restart cannot read the dead
// token back into a false connected state.
describe("handleRelayUnauthorized", () => {
  const sessionA = {
    serverUrl: "https://cloud.dohc.test",
    userId: "user-1",
    token: "token-a",
  };
  it("does not act on a rotated token of the same account", async () => {
    const steps: string[] = [];
    const acted = await handleRelayUnauthorized({
      requestCredentials: sessionA,
      currentCredentials: { ...sessionA, token: "token-a-rotated" },
      clearCachedCredentials: () => steps.push("clear"),
      notifySessionChanging: () => steps.push("notify changing"),
      notifyCloudSessionChanged: () => steps.push("notify ready"),
      invalidatePersistedSessionIf: async () => {
        steps.push("invalidate store");
      },
    });
    expect(acted).toBe(false);
    expect(steps).toEqual([]);
  });

  // Security: a current-session 401 is an account-session
  // end — main.ts's clearCachedCredentials() (called here as
  // clearCachedCredentials, exactly as main.ts wires it) also clears the DM
  // request-lanes cache, so a new account's first failed poll can never be
  // served the previous account's cached request rows. Driven through the
  // real createLastKnownDmRequestLanesCache, not a string log, so this
  // proves the cache itself ends up empty, not just that some callback fired.
  it("clears a real DM request-lanes cache when the current-session 401 path runs", async () => {
    const cache = createLastKnownDmRequestLanesCache();
    cache.set("workspace-a", {
      pending: [{ shareId: "share-a", granterEmail: "a@x.com" }],
      declined: [],
    });
    const acted = await handleRelayUnauthorized({
      requestCredentials: sessionA,
      currentCredentials: sessionA,
      clearCachedCredentials: () => cache.clear(),
      notifySessionChanging: () => undefined,
      notifyCloudSessionChanged: () => undefined,
      invalidatePersistedSessionIf: async () => undefined,
    });
    expect(acted).toBe(true);
    expect(cache.get("workspace-a")).toBeUndefined();
  });
});
