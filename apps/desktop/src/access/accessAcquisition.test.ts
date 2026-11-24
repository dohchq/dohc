import { afterEach, expect, it, vi } from "vitest";
import {
  accessCliQueries,
  createAccessAcquisition,
  createAccessOwner,
  refreshAccessObservations,
} from "./accessOwner";
import { createShareRosters } from "../automations/shareRoster";
import {
  createReceivedShareAcquisition,
  type ReceivedInventory,
  type ReceivedScope,
} from "../workspaces/receivedShareStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { RosterAnswer } from "@dohc/automation-executor/roster-listing";
import { deferred } from "../testing/deferred";

afterEach(() => vi.useRealTimers());
const grant = {
  shareId: "share",
  grantId: "grant",
  granterUserId: "owner",
  granterEmail: null,
  recipientUserId: "recipient",
  recipientEmail: null,
  subjectName: null,
  sharerName: null,
  generation: 1,
  status: "active" as const,
  selector: { paths: ["Notes"], versionId: null },
  access: "view" as const,
};
const listing = { grants: [grant], links: [], formerGrants: [], endedGrants: [] };
const inventory = {
  received: [{ ...grant, createdAtMs: 1, genericChatWritable: false }],
  removed: [],
};
function harness(accountState: "ready" | "signed-out" | "no-relay" = "ready") {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  let context = {};
  const workspace = {
    workspaceId: "w",
    rootPath: "/w",
    remote: { ownerUserId: "owner", serverUrl: "relay" },
  } as RegistryEntry;
  const next =
    accountState === "signed-out"
      ? "Sign in to your server first."
      : "Reconnect your sharing server, then try again.";
  const listRoster = vi.fn(async (): Promise<RosterAnswer> =>
    accountState === "ready"
      ? { kind: "answered", listing }
      : { kind: "unanswered", next, partial: false },
  );
  const rosters = createShareRosters({
    findWorkspace: () => workspace,
    saveRoster: (_id, listing, _pulled, listedAtMs) => {
      workspace.shareRoster = { ...listing, version: 1, listedAtMs };
    },
    markRosterPulled: () => undefined,
    listRoster,
    localUserId: async () => "owner",
    localPersonId: async () => null,
    syncHistory: async () => "synced",
    logError: vi.fn(),
    nowMs: Date.now,
    wallNowMs: Date.now,
    context: () => context,
  });
  let saved: { inventory: ReceivedInventory; listedAtMs: number } | null = null;
  let scope: ReceivedScope = { userId: "recipient", relayUrl: "relay", generation: 1 };
  const store = {
    read: () => saved,
    save: (_scope: ReceivedScope, inventory: ReceivedInventory, listedAtMs: number) => {
      saved = { inventory, listedAtMs };
    },
    remove: () => {
      saved = null;
    },
    file: () => "/unused",
  };
  const listReceived = vi.fn(async (): Promise<unknown> => inventory),
    onLive = vi.fn(async () => undefined);
  const received = createReceivedShareAcquisition({
    store,
    scope: () => (accountState === "ready" ? scope : null),
    list: listReceived,
    onLive,
    logError: vi.fn(),
    nowMs: Date.now,
    wallNowMs: Date.now,
  });
  const acquisition = createAccessAcquisition({
    roster: (id, options) => rosters.requestRefresh(id, options),
    received: () => received.refresh(),
  });
  const warmCredentials = vi.fn(async () => undefined);
  const owner = createAccessOwner({
    resolve: async (_w: string, ref) => ({ ref, visibility: "visible" }),
    roster: () => rosters.observation("w"),
    received: () => received.observation(),
    account: () =>
      accountState === "signed-out"
        ? null
        : {
            userId: scope.userId,
            email: "recipient@test.dev",
            relayUrl: accountState === "no-relay" ? undefined : scope.relayUrl,
            generation: scope.generation,
          },
    scope: () => scope.userId,
    assertCurrent: () => undefined,
    permissions: async () => {
      throw Error("unused");
    },
    refresh: (workspaceId, options) =>
      refreshAccessObservations(
        { workspace: { workspaceId }, assertCurrent: () => undefined },
        warmCredentials,
        acquisition,
        options,
      ),
  });
  return {
    owner,
    rosters,
    received,
    acquisition,
    listRoster,
    listReceived,
    onLive,
    store,
    next,
    warmCredentials,
    switchAccount() {
      scope = { ...scope, userId: "other", generation: 2 };
      context = {};
      received.credentialsChanged(scope);
    },
  };
}
it("feeds both observations once, preserves cached reads, and paces repeated surface requests", async () => {
  const h = harness();
  try {
    expect(await Promise.all([h.owner.refresh("w"), h.owner.refresh("w")])).toEqual([
      { status: "requested" },
      { status: "joined" },
    ]);
    for (const lane of ["granted", "received"] as const)
      expect(h.owner.sharing("w", { lane })).toMatchObject({
        freshness: "fresh",
        checkedAtMs: 100_000,
      });
    expect(await h.owner.refresh("w")).toEqual({ status: "paced" });
    expect(h.listRoster).toHaveBeenCalledOnce();
    expect(h.listReceived).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.owner.refresh("w");
    expect(h.listRoster).toHaveBeenCalledTimes(2);
    expect(h.listReceived).toHaveBeenCalledTimes(2);
  } finally {
    h.rosters.close("w");
  }
});
it("labels failed and partial refreshes historical and keeps restart observations stale", async () => {
  const h = harness();
  try {
    await h.owner.refresh("w");
    h.listRoster.mockResolvedValue({ kind: "unanswered", partial: true, next: "offline" });
    h.listReceived.mockRejectedValue(Error("page cursor failed"));
    vi.setSystemTime(160_000);
    await h.owner.refresh("w");
    for (const lane of ["granted", "received"] as const)
      expect(h.owner.sharing("w", { lane })).toMatchObject({
        freshness: "stale",
        checkedAtMs: 100_000,
        rows: [{ shareId: "share" }],
      });
    expect(h.onLive).toHaveBeenCalledOnce();
    h.received.retire();
    expect(h.owner.sharing("w", { lane: "received" }).freshness).toBe("stale");
  } finally {
    h.rosters.close("w");
  }
});
it("rejects account-superseded publication and keeps local mutations stale during acquisition", async () => {
  const h = harness(),
    waiting = deferred<unknown>();
  try {
    await h.owner.refresh("w");
    vi.setSystemTime(160_000);
    h.listReceived.mockReturnValue(waiting.promise);
    const refresh = h.owner.refresh("w");
    await vi.waitFor(() => expect(h.listReceived).toHaveBeenCalledTimes(2));
    h.received.invalidate();
    waiting.resolve(inventory);
    await refresh;
    expect(h.owner.sharing("w", { lane: "received" }).freshness).toBe("stale");
    expect(h.onLive).toHaveBeenCalledOnce();
    h.switchAccount();
    expect(h.owner.sharing("w", { lane: "received" })).toMatchObject({
      rows: [],
      freshness: "unknown",
    });
  } finally {
    h.rosters.close("w");
  }
});

it.each(["signed-out", "no-relay"] as const)(
  "keeps IPC roster acquisition and its next step when %s",
  async (accountState) => {
    const h = harness(accountState);
    try {
      if (accountState === "signed-out")
        h.warmCredentials.mockRejectedValue(new Error("credential store unavailable"));
      expect(await h.owner.refresh("w")).toEqual({
        status: "unavailable",
        reason: accountState === "signed-out" ? "signed-out" : "unreadable",
      });
      expect(h.warmCredentials).toHaveBeenCalledOnce();
      expect(h.listRoster).toHaveBeenCalledOnce();
      expect(h.listReceived).not.toHaveBeenCalled();
      expect(await h.rosters.cached("w")).toMatchObject({
        kind: "unknown",
        problem: { next: h.next },
      });
    } finally {
      h.rosters.close("w");
    }
  },
);

it("waits for both in-flight attempts before answering joined", async () => {
  const h = harness(),
    roster = deferred<RosterAnswer>(),
    received = deferred<unknown>();
  h.listRoster.mockReturnValue(roster.promise);
  h.listReceived.mockReturnValue(received.promise);
  let firstSettled = false,
    joinedSettled = false;
  try {
    const first = h.owner.refresh("w").then((result) => {
      firstSettled = true;
      return result;
    });
    const joined = h.owner.refresh("w").then((result) => {
      joinedSettled = true;
      return result;
    });
    await vi.waitFor(() => {
      expect(h.listRoster).toHaveBeenCalledOnce();
      expect(h.listReceived).toHaveBeenCalledOnce();
    });
    expect(firstSettled).toBe(false);
    expect(joinedSettled).toBe(false);
    roster.resolve({ kind: "answered", listing });
    await h.rosters.requestRefresh("w");
    expect(firstSettled).toBe(false);
    expect(joinedSettled).toBe(false);
    received.resolve(inventory);
    expect(await first).toEqual({ status: "requested" });
    expect(await joined).toEqual({ status: "joined" });
    for (const lane of ["granted", "received"] as const)
      expect(h.owner.sharing("w", { lane }).freshness).toBe("fresh");
  } finally {
    roster.resolve({ kind: "answered", listing });
    received.resolve(inventory);
    h.rosters.close("w");
  }
});

// A member joins less than a minute after the last listing. The CLI's refresh
// waits for the paced retry, so its next read lists them; the window's own
// refresh still answers paced at once.
it("makes the CLI's refresh wait for a paced retry, so its next read lists a member who joined in the window", async () => {
  const h = harness();
  try {
    await h.owner.refresh("w");
    vi.setSystemTime(110_000);
    const sam = {
      ...grant,
      grantId: "sam",
      recipientUserId: "sam",
      selector: { kind: "workspace" as const },
      access: "comment" as const,
      memberReach: { role: "member" as const, level: "comment" as const, rules: [], groups: [] },
    };
    h.listRoster.mockResolvedValue({
      kind: "answered",
      listing: { ...listing, grants: [grant, sam] } as never,
    });
    const cli = accessCliQueries(h.owner, (work) => Promise.resolve(work("w")));
    expect(await h.owner.refresh("w")).toEqual({ status: "paced" });
    let settled = false;
    const refreshed = cli.refresh().then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(49_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await refreshed).toEqual({ status: "joined" });
    expect(h.listRoster).toHaveBeenCalledTimes(2);
    const read = await cli.object({
      ref: { kind: "path", path: "notes/plan.md", versionId: null },
    });
    expect(read.rows.map((row) => (row.kind === "share" ? row.grantId : null))).toEqual(["sam"]);
  } finally {
    h.rosters.close("w");
  }
});

// Closing the workspace retires its operations, so a refresh waiting on the
// next check ends then instead of holding the operation for up to a minute.
it("ends a waiting refresh when the workspace operation retires", async () => {
  const h = harness();
  try {
    await h.owner.refresh("w");
    vi.setSystemTime(110_000);
    const retirement = new AbortController();
    const waiting = refreshAccessObservations(
      {
        workspace: { workspaceId: "w" },
        signal: retirement.signal,
        assertCurrent: () => undefined,
      },
      h.warmCredentials,
      h.acquisition,
      { wait: true },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    retirement.abort(new Error("The workspace closed."));
    await expect(waiting).rejects.toThrow("The workspace closed.");
    expect(h.listRoster).toHaveBeenCalledOnce();
  } finally {
    h.rosters.close("w");
  }
});
