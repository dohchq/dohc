import { randomBytes } from "node:crypto";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNamedLiveBrowserSessions } from "./namedLiveBrowserSessions";
import type { SyncRelayShareGrantRow, SyncRelayShareRow } from "./storage";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomBytes: vi.fn(original.randomBytes) };
});

const alice = {
  kind: "named" as const,
  userId: "alice",
  workspaceId: "workspace",
  shareId: "share-alice",
  grantId: "grant-alice",
};
const bob = {
  kind: "named" as const,
  userId: "bob",
  workspaceId: "workspace",
  shareId: "share-bob",
  grantId: "grant-bob",
};

function fixture(
  overrides: {
    maxSessions?: number;
    retentionMs?: number;
    idleMs?: number;
    now?: () => number;
  } = {},
) {
  let time = 100,
    elapsed: number | undefined;
  const shares = new Map<string, SyncRelayShareRow>();
  const grants = new Map<string, SyncRelayShareGrantRow>();
  for (const context of [alice, bob]) {
    shares.set(context.shareId, {
      shareId: context.shareId,
      workspaceId: context.workspaceId,
      granterUserId: "owner",
      selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
      createdAtMs: 1,
    });
    grants.set(context.grantId, {
      grantId: context.grantId,
      shareId: context.shareId,
      principalKind: "user",
      principalUserId: context.userId,
      principalEmail: null,
      access: "edit",
      generation: 1,
      status: "active",
      createdAtMs: 1,
      revokedAtMs: null,
      parentGrantId: null,
    });
  }
  const storage = {
    getShare: (id: string) => shares.get(id) ?? null,
    getShareGrant: vi.fn((id: string) => grants.get(id) ?? null),
    workspaceIsOwnedBy: () => true,
    findChannelCreateKind: () => null,
  };
  const resolveActor = vi.fn<ResolveActor>(async (request, workspaceId) => {
    const cookie = request.headers.get("cookie");
    const userId = cookie === "session=alice" ? "alice" : cookie === "session=bob" ? "bob" : null;
    if (!userId) throw new UnauthorizedError();
    return { userId, workspaceId };
  });
  const options = {
    storage,
    resolveActor,
    maxSessions: 3,
    retentionMs: 1000,
    maxSessionsPerAccount: 16,
    now: () => time,
    elapsedNow: () => elapsed ?? time,
    ...overrides,
  };
  return {
    sessions: createNamedLiveBrowserSessions(options),
    options,
    storage,
    resolveActor,
    grants,
    shares,
    setTime(value: number) {
      time = value;
    },
    /** Lets elapsed time part from the wall clock, which otherwise stands for both. */
    setElapsed(value: number) {
      elapsed = value;
    },
  };
}

function request(user = "alice", signal?: AbortSignal) {
  return new Request("https://share.example.test/api/live?session=ignored", {
    method: "POST",
    signal,
    headers: {
      cookie: `session=${user}`,
      authorization: "Bearer bob",
      "x-user-id": "bob",
      "content-type": "application/json",
    },
    body: JSON.stringify({ userId: "bob", grantId: bob.grantId, workspaceId: "forged" }),
  });
}

afterEach(() => vi.resetAllMocks());

describe("private named browser route sessions", () => {
  it("issues distinct opaque mappings and resolves only the recorded account through its cookie", async () => {
    const state = fixture();
    const first = state.sessions.create(alice)!;
    const second = state.sessions.create(bob)!;
    const third = state.sessions.create(alice)!;
    expect(first).toEqual({
      discriminator: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/u),
      expiresAtMs: 1100,
    });
    expect(new Set([first.discriminator, second.discriminator, third.discriminator]).size).toBe(3);
    const incoming = request();
    expect(await state.sessions.resolve(incoming, first.discriminator)).toEqual(alice);
    expect(incoming.bodyUsed).toBe(false);
    const authenticated = state.resolveActor.mock.calls[0]![0];
    expect([...authenticated.headers]).toEqual([["cookie", "session=alice"]]);
    expect(await state.sessions.resolve(request("bob"), first.discriminator)).toBeNull();
    expect(await state.sessions.resolve(request(), second.discriminator)).toBeNull();
    expect(await state.sessions.resolve(request("bob"), second.discriminator)).toEqual(bob);
    expect(await state.sessions.resolve(request(), third.discriminator)).toEqual(alice);
    expect(await state.sessions.resolve(request(), first.discriminator)).toEqual(alice);
  });

  it("copies context and does not expose the retained association through returned values", async () => {
    const state = fixture();
    const mutable = { ...alice };
    const issued = state.sessions.create(mutable)!;
    Object.assign(mutable, bob);
    const context = (await state.sessions.resolve(request(), issued.discriminator))!;
    expect(context).toEqual(alice);
    Object.assign(context, bob);
    expect(await state.sessions.resolve(request(), issued.discriminator)).toEqual(alice);
  });

  it("refuses a newly authorized different account even when the exact grant now names that account", async () => {
    const state = fixture();
    const issued = state.sessions.create(alice)!;
    state.grants.get(alice.grantId)!.principalUserId = "bob";
    expect(await state.sessions.resolve(request("bob"), issued.discriminator)).toBeNull();
  });

  it.each([
    ["before", "alice"],
    ["during", "alice"],
    ["before", "nobody"],
    ["during", "nobody"],
  ])(
    "invalidates the old grant generation %s authentication by %s without disturbing other mappings",
    async (timing, caller) => {
      const state = fixture();
      const old = state.sessions.create(alice)!;
      const other = state.sessions.create(bob)!;
      const advanceGeneration = () => {
        state.grants.get(alice.grantId)!.generation += 1;
      };
      if (timing === "before") advanceGeneration();
      else
        state.resolveActor.mockImplementationOnce(async (_request, workspaceId) => {
          advanceGeneration();
          if (caller === "nobody") throw new UnauthorizedError();
          return { userId: "alice", workspaceId };
        });
      expect(await state.sessions.resolve(request(caller), old.discriminator)).toBeNull();
      expect(state.sessions.remove(old.discriminator)).toBe(false);
      expect(await state.sessions.resolve(request("bob"), other.discriminator)).toEqual(bob);
      const fresh = state.sessions.create(alice)!;
      expect(await state.sessions.resolve(request(), fresh.discriminator)).toEqual(alice);
      expect(await state.sessions.resolve(request(), old.discriminator)).toBeNull();
    },
  );

  it("rejects invalid or inconsistent stored grant snapshots at creation", () => {
    for (const generation of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const state = fixture();
      state.grants.get(alice.grantId)!.generation = generation;
      expect(() => state.sessions.create(alice)).toThrow("Invalid named session grant");
    }
    for (const change of [
      (state: ReturnType<typeof fixture>) => state.grants.delete(alice.grantId),
      (state: ReturnType<typeof fixture>) => {
        state.grants.get(alice.grantId)!.grantId = "other";
      },
      (state: ReturnType<typeof fixture>) => {
        state.grants.get(alice.grantId)!.principalUserId = "bob";
      },
      (state: ReturnType<typeof fixture>) => {
        state.grants.get(alice.grantId)!.shareId = bob.shareId;
      },
      (state: ReturnType<typeof fixture>) => {
        state.grants.get(alice.grantId)!.access = "comment";
      },
      (state: ReturnType<typeof fixture>) => {
        state.grants.get(alice.grantId)!.status = "revoked";
      },
      (state: ReturnType<typeof fixture>) => {
        state.shares.get(alice.shareId)!.workspaceId = "other";
      },
    ]) {
      const state = fixture();
      change(state);
      expect(() => state.sessions.create(alice)).toThrow("Invalid named session grant");
    }
    const state = fixture();
    const failure = new Error("grant storage unavailable");
    state.storage.getShareGrant.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => state.sessions.create(alice)).toThrow(failure);
  });

  it("does not resolve absent, removed, or restarted mappings or disturb another mapping", async () => {
    const state = fixture();
    const first = state.sessions.create(alice)!;
    const second = state.sessions.create(bob)!;
    expect(await state.sessions.resolve(request(), "unknown")).toBeNull();
    expect(state.sessions.remove(first.discriminator)).toBe(true);
    expect(state.sessions.remove(first.discriminator)).toBe(false);
    expect(await state.sessions.resolve(request(), first.discriminator)).toBeNull();
    expect(
      await createNamedLiveBrowserSessions(state.options).resolve(
        request("bob"),
        second.discriminator,
      ),
    ).toBeNull();
    expect(state.resolveActor).not.toHaveBeenCalled();
    expect(await state.sessions.resolve(request("bob"), second.discriminator)).toEqual(bob);
  });

  it("refuses creation at capacity, preserves valid entries, and reclaims expired capacity", async () => {
    const state = fixture({ maxSessions: 2 });
    const first = state.sessions.create(alice)!;
    state.setTime(200);
    const second = state.sessions.create(bob)!;
    expect(state.sessions.create(alice)).toBeNull();
    state.setTime(1099);
    expect(await state.sessions.resolve(request(), first.discriminator)).toEqual(alice);
    state.setTime(1100);
    expect(state.sessions.create(alice)).not.toBeNull();
    expect(await state.sessions.resolve(request(), first.discriminator)).toBeNull();
    expect(await state.sessions.resolve(request("bob"), second.discriminator)).toEqual(bob);
    expect(state.sessions.create(bob)).toBeNull();
  });

  it("keeps each account's most recently used sessions and leaves other accounts' sessions alone", async () => {
    // The store is full once the account holds sixteen, and its next session still opens.
    const state = fixture({ maxSessions: 17 });
    const other = state.sessions.create(bob)!;
    const issued = Array.from({ length: 16 }, () => state.sessions.create(alice)!);
    expect(await state.sessions.resolve(request(), issued[0]!.discriminator)).toEqual(alice);
    const newest = state.sessions.create(alice)!;
    expect(newest).not.toBeNull();
    expect(await state.sessions.resolve(request(), issued[1]!.discriminator)).toBeNull();
    for (const kept of [issued[0]!, ...issued.slice(2), newest])
      expect(await state.sessions.resolve(request(), kept.discriminator)).toEqual(alice);
    expect(state.sessions.create(bob)).toBeNull();
    expect(await state.sessions.resolve(request("bob"), other.discriminator)).toEqual(bob);
  });

  it("clears an account's expired sessions before it replaces one still in use", async () => {
    const state = fixture({ maxSessions: 64 });
    const expiring = state.sessions.create(alice)!;
    state.setTime(200);
    const issued = Array.from({ length: 15 }, () => state.sessions.create(alice)!);
    state.setTime(1099);
    expect(await state.sessions.resolve(request(), expiring.discriminator)).toEqual(alice);
    state.setTime(1100);
    const newest = state.sessions.create(alice)!;
    expect(state.sessions.remove(expiring.discriminator)).toBe(false);
    for (const kept of [...issued, newest])
      expect(await state.sessions.resolve(request(), kept.discriminator)).toEqual(alice);
  });

  it("does not count a refused lookup as use", async () => {
    const state = fixture({ maxSessions: 64 });
    const issued = Array.from({ length: 16 }, () => state.sessions.create(alice)!);
    expect(await state.sessions.resolve(request("bob"), issued[0]!.discriminator)).toBeNull();
    state.sessions.create(alice);
    expect(await state.sessions.resolve(request(), issued[0]!.discriminator)).toBeNull();
    expect(await state.sessions.resolve(request(), issued[1]!.discriminator)).toEqual(alice);
  });

  it("keeps the account's sessions when a new one cannot be stored", async () => {
    const state = fixture({ maxSessions: 64 });
    vi.mocked(randomBytes).mockReturnValueOnce(Buffer.alloc(9) as never);
    const issued = Array.from({ length: 16 }, () => state.sessions.create(alice)!);
    vi.mocked(randomBytes).mockReturnValueOnce(Buffer.alloc(9) as never);
    expect(() => state.sessions.create(alice)).toThrow("Named session discriminator collision");
    for (const kept of issued)
      expect(await state.sessions.resolve(request(), kept.discriminator)).toEqual(alice);
  });

  it("refuses an account when the store is full of other accounts' sessions, and drops none of them", async () => {
    const state = fixture({ maxSessions: 2 });
    const first = state.sessions.create(alice)!;
    const second = state.sessions.create(alice)!;
    expect(state.sessions.create(bob)).toBeNull();
    expect(await state.sessions.resolve(request(), first.discriminator)).toEqual(alice);
    expect(await state.sessions.resolve(request(), second.discriminator)).toEqual(alice);
  });

  it("uses fixed expiry without renewal and releases capacity on removal", async () => {
    const state = fixture({ maxSessions: 1 });
    const first = state.sessions.create(alice)!;
    state.setTime(1099);
    expect(await state.sessions.resolve(request(), first.discriminator)).toEqual(alice);
    state.setTime(1100);
    expect(await state.sessions.resolve(request(), first.discriminator)).toBeNull();
    const replacement = state.sessions.create(bob)!;
    expect(state.sessions.remove(replacement.discriminator)).toBe(true);
    expect(state.sessions.create(alice)).not.toBeNull();
  });

  it.each(["remove", "replace", "expire", "abort"])(
    "refuses when %s occurs during authentication",
    async (action) => {
      const state = fixture({ maxSessions: 17 });
      const issued = state.sessions.create(alice)!;
      const controller = new AbortController();
      state.resolveActor.mockImplementationOnce(async (_request, workspaceId) => {
        if (action === "remove") state.sessions.remove(issued.discriminator);
        if (action === "replace") for (let i = 0; i < 16; i++) state.sessions.create(alice);
        if (action === "expire") state.setTime(issued.expiresAtMs);
        if (action === "abort") controller.abort();
        return { userId: "alice", workspaceId };
      });
      expect(
        await state.sessions.resolve(request("alice", controller.signal), issued.discriminator),
      ).toBeNull();
    },
  );

  it("does not authenticate an already cancelled request", async () => {
    const state = fixture();
    const issued = state.sessions.create(alice)!;
    expect(
      await state.sessions.resolve(request("alice", AbortSignal.abort()), issued.discriminator),
    ).toBeNull();
    expect(state.resolveActor).not.toHaveBeenCalled();
  });

  it("refuses an in-flight result after removal and replacement at the same discriminator", async () => {
    const state = fixture();
    vi.mocked(randomBytes)
      .mockReturnValueOnce(Buffer.alloc(9) as never)
      .mockReturnValueOnce(Buffer.alloc(9) as never);
    const first = state.sessions.create(alice)!;
    state.resolveActor.mockImplementationOnce(async (_request, workspaceId) => {
      state.sessions.remove(first.discriminator);
      expect(state.sessions.create(bob)!.discriminator).toBe(first.discriminator);
      return { userId: "alice", workspaceId };
    });
    expect(await state.sessions.resolve(request(), first.discriminator)).toBeNull();
    expect(await state.sessions.resolve(request("bob"), first.discriminator)).toEqual(bob);
  });

  it.each(["revoke", "downgrade", "move-workspace"])(
    "rereads exact authority after %s during authentication",
    async (action) => {
      const state = fixture();
      const issued = state.sessions.create(alice)!;
      state.resolveActor.mockImplementationOnce(async (_request, workspaceId) => {
        if (action === "revoke") state.grants.get(alice.grantId)!.status = "revoked";
        if (action === "downgrade") state.grants.get(alice.grantId)!.access = "comment";
        if (action === "move-workspace") state.shares.get(alice.shareId)!.workspaceId = "other";
        return { userId: "alice", workspaceId };
      });
      expect(await state.sessions.resolve(request(), issued.discriminator)).toBeNull();
      expect(() => state.sessions.create(alice)).toThrow("Invalid named session grant");
    },
  );

  it("refuses missing and link sessions without consuming the named mapping", async () => {
    const state = fixture();
    const issued = state.sessions.create(alice)!;
    for (const cookie of [null, "dohc_share_link=secret; dohc_profile=secret"]) {
      const incoming = request();
      if (cookie === null) incoming.headers.delete("cookie");
      else incoming.headers.set("cookie", cookie);
      expect(await state.sessions.resolve(incoming, issued.discriminator)).toBeNull();
    }
    expect(await state.sessions.resolve(request(), issued.discriminator)).toEqual(alice);
  });

  it("preserves authentication and storage infrastructure errors and the mapping", async () => {
    const state = fixture();
    const issued = state.sessions.create(alice)!;
    const authFailure = new Error("auth database unavailable");
    state.resolveActor.mockRejectedValueOnce(authFailure);
    await expect(state.sessions.resolve(request(), issued.discriminator)).rejects.toBe(authFailure);
    const storageFailure = new Error("corrupt stored grant");
    state.storage.getShareGrant.mockImplementationOnce(() => {
      throw storageFailure;
    });
    await expect(state.sessions.resolve(request(), issued.discriminator)).rejects.toBe(
      storageFailure,
    );
    expect(await state.sessions.resolve(request(), issued.discriminator)).toEqual(alice);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid explicit policies %s",
    (value) => {
      expect(() => fixture({ maxSessions: value })).toThrow("Invalid named session maxSessions");
      expect(() => fixture({ retentionMs: value })).toThrow("Invalid named session retentionMs");
    },
  );

  it("requires explicit policy and captures it at construction", () => {
    const state = fixture();
    expect(() =>
      createNamedLiveBrowserSessions({ ...state.options, maxSessions: undefined! }),
    ).toThrow();
    expect(() =>
      createNamedLiveBrowserSessions({ ...state.options, retentionMs: undefined! }),
    ).toThrow();
    state.options.maxSessions = 0;
    state.options.retentionMs = 1;
    expect(state.sessions.create(alice)!.expiresAtMs).toBe(1100);
  });

  it("rejects invalid context, invalid clocks, and expiry overflow before retaining an entry", () => {
    const state = fixture({ maxSessions: 1 });
    for (const key of Object.keys(alice)) {
      expect(() => state.sessions.create({ ...alice, [key]: "" })).toThrow(
        "Invalid named session context",
      );
    }
    for (const invalid of [-1, NaN, Infinity, 0.5]) {
      state.setTime(invalid);
      expect(() => state.sessions.create(alice)).toThrow("Invalid named session time");
    }
    state.setTime(Number.MAX_SAFE_INTEGER);
    expect(() => state.sessions.create(alice)).toThrow("Invalid named session expiry");
    state.setTime(100);
    expect(state.sessions.create(alice)).not.toBeNull();
  });

  it("never overwrites an existing mapping on a random discriminator collision", async () => {
    const state = fixture();
    vi.mocked(randomBytes)
      .mockReturnValueOnce(Buffer.alloc(9) as never)
      .mockReturnValueOnce(Buffer.alloc(9) as never);
    const first = state.sessions.create(alice)!;
    expect(() => state.sessions.create(bob)).toThrow("Named session discriminator collision");
    expect(await state.sessions.resolve(request(), first.discriminator)).toEqual(alice);
    expect(await state.sessions.resolve(request("bob"), first.discriminator)).toBeNull();
  });
});

describe("a session nobody uses", () => {
  const hour = 60 * 60 * 1000;
  const policy = { retentionMs: 12 * hour, idleMs: 15 * 60 * 1000 };

  it("is removed once its first window passes without a use", async () => {
    const state = fixture(policy);
    const { discriminator } = state.sessions.create(alice)!;
    state.setTime(100 + policy.idleMs - 1);
    expect(await state.sessions.resolve(request(), discriminator)).toEqual(alice);
    state.setTime(100 + policy.idleMs - 1 + policy.idleMs);
    expect(await state.sessions.resolve(request(), discriminator)).toBeNull();
    expect(state.sessions.remove(discriminator)).toBe(false);
  });

  it("keeps the window its last check set through the relay's own uses", async () => {
    const state = fixture(policy);
    const { discriminator } = state.sessions.create(alice)!;
    const window = 3 * 60 * 1000;
    state.setTime(1_000);
    expect(await state.sessions.check(request(), discriminator, window)).toEqual(alice);
    state.setTime(1_000 + window - 1);
    expect(await state.sessions.resolve(request(), discriminator)).toEqual(alice);
    state.setTime(1_000 + 2 * window - 2);
    expect(await state.sessions.resolve(request(), discriminator)).toEqual(alice);
    state.setTime(1_000 + 3 * window - 2);
    expect(await state.sessions.resolve(request(), discriminator)).toBeNull();
  });

  it("lasts its whole retention once a check announced no interval", async () => {
    const state = fixture(policy);
    const { discriminator } = state.sessions.create(alice)!;
    expect(await state.sessions.check(request(), discriminator, Infinity)).toEqual(alice);
    state.setTime(100 + policy.retentionMs - 1);
    expect(await state.sessions.resolve(request(), discriminator)).toEqual(alice);
    state.setTime(100 + policy.retentionMs);
    expect(await state.sessions.resolve(request(), discriminator)).toBeNull();
  });

  it("follows the time that passed, not a corrected wall clock", async () => {
    const state = fixture(policy);
    const { discriminator } = state.sessions.create(alice)!;
    const window = 3 * 60 * 1000;
    state.setElapsed(100);
    expect(await state.sessions.check(request(), discriminator, window)).toEqual(alice);
    // The wall clock jumps forward past the window while one interval passes.
    state.setTime(100 + 4 * 60 * 1000);
    state.setElapsed(100 + 60 * 1000);
    expect(await state.sessions.check(request(), discriminator, window)).toEqual(alice);
    // It jumps back, and the window still ends when its time has passed.
    state.setTime(100);
    state.setElapsed(100 + 60 * 1000 + window);
    expect(await state.sessions.check(request(), discriminator, window)).toBeNull();
  });

  it("is not kept by a use that fails its checks", async () => {
    const state = fixture(policy);
    const { discriminator } = state.sessions.create(alice)!;
    state.setTime(100 + policy.idleMs - 1);
    expect(await state.sessions.check(request("bob"), discriminator, Infinity)).toBeNull();
    state.setTime(100 + policy.idleMs);
    expect(await state.sessions.resolve(request(), discriminator)).toBeNull();
  });
});
