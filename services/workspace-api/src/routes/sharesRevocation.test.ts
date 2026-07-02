import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { SharedAtomDeps } from "./shared";
import {
  getShareRevocationDisconnectBacklogStats,
  retryPendingShareRevocationDisconnects,
  revokeShare,
} from "./shares";

describe("revokeShare admin disconnect", () => {
  it("soft-deletes the share and disconnects the revoked recipient workspace session", async () => {
    const events: string[] = [];
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        queries.push({ text, params });
        if (normalized.includes("from shares s")) {
          expect(params).toEqual(["share-1", "sharer-1"]);
          return {
            rows: [
              {
                created_by: "sharer-1",
                is_owner: false,
                is_member: true,
                recipient_user_id: "recipient-1",
                workspace_id: "workspace-1",
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        queries.push({ text, params });
        return { rows: [], rowCount: normalized.startsWith("update") ? 1 : 0 };
      },
    } as unknown as pg.Pool;
    const disconnects: Array<{ workspaceId: string; userId: string }> = [];
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async (input) => {
          events.push("disconnect");
          disconnects.push({ workspaceId: input.workspaceId, userId: input.userId });
        },
      },
    };

    await expect(revokeShare(deps, "sharer-1", "share-1")).resolves.toEqual({
      ok: true,
      revoked: true,
    });

    const updateQuery = queries.find(({ text }) =>
      text.trim().toLowerCase().includes("update shares set deleted_at"),
    );
    expect(updateQuery?.params).toEqual(["share-1"]);
    expect(disconnects).toEqual([{ workspaceId: "workspace-1", userId: "recipient-1" }]);
    expect(events).toEqual([
      "connect",
      "begin",
      "select",
      "update",
      "insert",
      "commit",
      "release",
      "update",
      "disconnect",
      "update",
    ]);
  });

  it("requeues the pending disconnect event when the admin disconnect fails", async () => {
    const events: string[] = [];
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        queries.push({ text, params });
        if (normalized.includes("from shares s")) {
          expect(params).toEqual(["share-1", "sharer-1"]);
          return {
            rows: [
              {
                created_by: "sharer-1",
                is_owner: false,
                is_member: true,
                recipient_user_id: "recipient-1",
                workspace_id: "workspace-1",
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        queries.push({ text, params });
        if (normalized.startsWith("update")) {
          expect(text).toContain("claimId");
          if (normalized.includes("set kind = 'share.revocation.disconnect_pending'")) {
            expect(text).toContain("payload->>'claimId'");
            expect(text).toContain("retryAfter");
          }
        }
        return { rows: [], rowCount: normalized.startsWith("update") ? 1 : 0 };
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async () => {
          events.push("disconnect");
          throw new Error("admin unavailable");
        },
      },
    };

    await expect(revokeShare(deps, "sharer-1", "share-1")).resolves.toEqual({
      ok: true,
      revoked: true,
      disconnectDeferred: true,
    });

    expect(events).toEqual([
      "connect",
      "begin",
      "select",
      "update",
      "insert",
      "commit",
      "release",
      "update",
      "disconnect",
      "update",
    ]);
    expect(
      queries.some(({ text }) =>
        text.trim().toLowerCase().includes("share.revocation.disconnect_pending"),
      ),
    ).toBe(true);
  });

  it("persists revocation and pending disconnect when admin disconnect is not configured", async () => {
    const events: string[] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.includes("from shares s")) {
          expect(params).toEqual(["share-1", "sharer-1"]);
          return {
            rows: [
              {
                created_by: "sharer-1",
                is_owner: false,
                is_member: true,
                recipient_user_id: "recipient-1",
                workspace_id: "workspace-1",
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = { pool };

    await expect(revokeShare(deps, "sharer-1", "share-1")).resolves.toEqual({
      ok: true,
      revoked: true,
      disconnectDeferred: true,
    });

    expect(events).toEqual(["connect", "begin", "select", "update", "insert", "commit", "release"]);
  });

  it("exposes revocation disconnect backlog stats for monitoring", async () => {
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const pool = {
      query: async (text: string, params?: unknown[]) => {
        queries.push({ text, params });
        return {
          rows: [
            {
              pending_count: "2",
              claimed_count: "1",
              oldest_pending_age_seconds: "120.5",
              oldest_claimed_age_seconds: "360",
            },
          ],
        };
      },
    } as unknown as pg.Pool;

    await expect(getShareRevocationDisconnectBacklogStats({ pool })).resolves.toEqual({
      pendingCount: 2,
      claimedCount: 1,
      oldestPendingAgeSeconds: 120.5,
      oldestClaimedAgeSeconds: 360,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("share.revocation.disconnect_pending");
    expect(queries[0]?.text).toContain("share.revocation.disconnect_claimed");
    expect(queries[0]?.text).toContain("oldest_pending_age_seconds");
    expect(queries[0]?.text).toContain("oldest_claimed_age_seconds");
    expect(queries[0]?.text).toContain("payload->>'claimedAt' ~");
    expect(queries[0]?.text).toContain("(payload->>'claimedAt')::timestamptz");
    expect(queries[0]?.text).toContain(
      "when kind = 'share.revocation.disconnect_claimed' then created_at",
    );
  });

  it("does not let a former workspace member revoke a share they created", async () => {
    const events: string[] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.includes("from shares s")) {
          expect(params).toEqual(["share-1", "sharer-1"]);
          return {
            rows: [
              {
                created_by: "sharer-1",
                is_owner: false,
                is_member: false,
                recipient_user_id: "recipient-1",
                workspace_id: "workspace-1",
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async () => {
          throw new Error("should not disconnect after membership loss");
        },
      },
    };

    await expect(revokeShare(deps, "sharer-1", "share-1")).rejects.toThrow(
      "share not found",
    );

    expect(events).toEqual(["connect", "begin", "select", "rollback", "release"]);
  });

  it("destroys the transaction client when rollback fails", async () => {
    const events: string[] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        const event = normalized.split(/\s+/u)[0] ?? "query";
        events.push(event);
        if (event === "select") {
          expect(params).toEqual(["share-1", "sharer-1"]);
          throw new Error("select failed");
        }
        if (event === "rollback") throw new Error("rollback failed");
        return { rows: [] };
      },
      release: (destroy?: boolean) => {
        events.push(destroy ? "release:destroy" : "release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async () => {
          throw new Error("should not disconnect");
        },
      },
    };

    await expect(revokeShare(deps, "sharer-1", "share-1")).rejects.toThrow("select failed");

    expect(events).toEqual(["connect", "begin", "select", "rollback", "release:destroy"]);
  });

  it("cleans up terminal disconnect events before failing when admin is missing", async () => {
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const pool = {
      query: async (text: string, params?: unknown[]) => {
        queries.push({ text, params });
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = { pool };

    await expect(retryPendingShareRevocationDisconnects(deps)).rejects.toMatchObject({
      code: "failed-precondition",
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("delete from workspace_events");
    expect(queries[0]?.text).toContain("where id in");
    expect(queries[0]?.text).toContain("select id");
    expect(queries[0]?.text).toContain("limit $2");
    expect(queries[0]?.text).toContain("~ $3");
    expect(queries[0]?.text).toContain("$4");
    expect(queries[0]?.text).toContain("share.revocation.disconnect_completed");
    expect(queries[0]?.text).not.toContain("share.revocation.disconnect_pending");
    expect(queries[0]?.text).not.toContain("share.revocation.disconnect_claimed");
    expect(queries[0]?.params).toEqual([
      7 * 24 * 60 * 60,
      100,
      expect.any(String),
      expect.any(String),
    ]);
  });

  it("still reports failed precondition when missing-admin cleanup fails", async () => {
    let cleanupAttempted = false;
    const pool = {
      query: async () => {
        cleanupAttempted = true;
        throw new Error("cleanup failed");
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = { pool };

    await expect(retryPendingShareRevocationDisconnects(deps)).rejects.toMatchObject({
      code: "failed-precondition",
    });
    expect(cleanupAttempted).toBe(true);
  });

  it("retries pending revocation disconnect events", async () => {
    const events: string[] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select") && normalized.includes("from workspace_events")) {
          expect(params).toEqual([100, 300, expect.any(String)]);
          return {
            rows: [
              {
                id: "event-1",
                workspace_id: "workspace-1",
                target_id: "share-1",
                payload: { recipientUserId: "recipient-1" },
              },
            ],
          };
        }
        if (normalized.includes("from shares")) {
          expect(params).toEqual(["workspace-1", "share-1"]);
          return { rows: [{ recipient_user_id: "recipient-1" }] };
        }
        if (normalized.startsWith("delete")) {
          expect(params).toEqual(["event-1"]);
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("update")) {
          expect(params?.[0]).toBe("event-1");
          expect(typeof params?.[1]).toBe("string");
          expect(params?.[2]).toBeUndefined();
        } else {
          expect(params?.[0]).toBe("event-1");
          expect(typeof params?.[1]).toBe("string");
        }
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const disconnects: Array<{ workspaceId: string; userId: string }> = [];
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async (input) => {
          events.push("disconnect");
          disconnects.push({ workspaceId: input.workspaceId, userId: input.userId });
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 1,
      disconnected: 1,
      failed: 0,
    });

    expect(disconnects).toEqual([{ workspaceId: "workspace-1", userId: "recipient-1" }]);
    expect(events).toEqual([
      "delete",
      "connect",
      "begin",
      "select",
      "select",
      "update",
      "commit",
      "release",
      "disconnect",
      "update",
      "delete",
    ]);
  });

  it("skips pending revocation disconnect events until retryAfter has elapsed", async () => {
    const events: string[] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select")) {
          expect(text).toContain("retryAfter");
          expect(text).toContain("as due_revocation_disconnects");
          expect(text).toContain("payload->>'retryAfter' is null");
          expect(text).toContain("payload->>'retryAfter' !~ $3");
          expect(text).toContain("due_revocation_disconnects.sort_at");
          expect(text).toContain("clock_timestamp()");
          expect(text).toContain("order by");
          expect(params).toHaveLength(3);
          expect(params?.slice(0, 2)).toEqual([100, 300]);
          expect(params?.[2]).toEqual(expect.stringContaining("T"));
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async () => {
          throw new Error("should not disconnect before retryAfter");
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 0,
      disconnected: 0,
      failed: 0,
    });

    expect(events).toEqual(["connect", "begin", "select", "commit", "release"]);
  });

  it("clamps retry worker batches to the lease-safe maximum", async () => {
    const events: string[] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select")) {
          expect(params).toHaveLength(3);
          expect(params?.slice(0, 2)).toEqual([100, 300]);
          expect(text).toContain("limit $1");
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async () => {
          throw new Error("should not disconnect when no rows are claimed");
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps, 500)).resolves.toEqual({
      ok: true,
      attempted: 0,
      disconnected: 0,
      failed: 0,
    });

    expect(events).toEqual(["connect", "begin", "select", "commit", "release"]);
  });

  it("recovers JSON scalar recipient payloads from the revoked share row", async () => {
    const events: string[] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select") && normalized.includes("from workspace_events")) {
          expect(params).toEqual([100, 300, expect.any(String)]);
          return {
            rows: [
              {
                id: "event-1",
                workspace_id: "workspace-1",
                target_id: "share-1",
                payload: "123",
              },
            ],
          };
        }
        if (normalized.includes("from shares")) {
          expect(params).toEqual(["workspace-1", "share-1"]);
          return { rows: [{ recipient_user_id: "recipient-from-share" }] };
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        expect(params?.[0]).toBe("event-1");
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const disconnects: Array<{ workspaceId: string; userId: string }> = [];
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async (input) => {
          events.push("disconnect");
          disconnects.push({ workspaceId: input.workspaceId, userId: input.userId });
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 1,
      disconnected: 1,
      failed: 0,
    });

    expect(events).toEqual([
      "delete",
      "connect",
      "begin",
      "select",
      "select",
      "update",
      "commit",
      "release",
      "disconnect",
      "update",
      "delete",
    ]);
    expect(disconnects).toEqual([{ workspaceId: "workspace-1", userId: "recipient-from-share" }]);
  });

  it("uses the revoked share recipient when the event payload recipient mismatches", async () => {
    const events: string[] = [];
    const claimUpdates: unknown[][] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select") && normalized.includes("from workspace_events")) {
          expect(params).toEqual([100, 300, expect.any(String)]);
          return {
            rows: [
              {
                id: "event-1",
                workspace_id: "workspace-1",
                target_id: "share-1",
                payload: { recipientUserId: "stale-recipient" },
              },
            ],
          };
        }
        if (normalized.includes("from shares")) {
          expect(params).toEqual(["workspace-1", "share-1"]);
          return { rows: [{ recipient_user_id: "recipient-from-share" }] };
        }
        if (normalized.startsWith("update")) {
          claimUpdates.push(params ?? []);
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        expect(params?.[0]).toBe("event-1");
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const disconnects: Array<{ workspaceId: string; userId: string }> = [];
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async (input) => {
          events.push("disconnect");
          disconnects.push({ workspaceId: input.workspaceId, userId: input.userId });
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 1,
      disconnected: 1,
      failed: 0,
    });

    expect(disconnects).toEqual([{ workspaceId: "workspace-1", userId: "recipient-from-share" }]);
    expect(claimUpdates).toHaveLength(1);
    expect(claimUpdates[0]?.[0]).toBe("event-1");
    expect(typeof claimUpdates[0]?.[1]).toBe("string");
    expect(claimUpdates[0]?.[2]).toBe("recipient-from-share");
    expect(claimUpdates[0]?.[3]).toBe(300);
    expect(events).toEqual([
      "delete",
      "connect",
      "begin",
      "select",
      "select",
      "update",
      "commit",
      "release",
      "disconnect",
      "update",
      "delete",
    ]);
  });

  it("reclaims stale claimed revocation disconnect events exactly once", async () => {
    const events: string[] = [];
    const claimUpdates: unknown[][] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select") && normalized.includes("from workspace_events")) {
          expect(params).toHaveLength(3);
          expect(params?.slice(0, 2)).toEqual([100, 300]);
          expect(params?.[2]).toEqual(expect.stringContaining("Z$"));
          expect(text).toContain("share.revocation.disconnect_claimed");
          expect(text).toContain("claimExpiresAt");
          expect(text).toContain("as due_revocation_disconnects");
          expect(text).toContain("payload->>'claimExpiresAt' is not null");
          expect(text).toContain("payload->>'claimExpiresAt' is null");
          expect(text).toContain("payload->>'claimExpiresAt' !~ $3");
          expect(text).toContain("payload->>'claimedAt' !~ $3");
          expect(text).toContain("due_revocation_disconnects.sort_at");
          expect(text).toContain("clock_timestamp()");
          expect(text).toContain("order by");
          return {
            rows: [
              {
                id: "claimed-event",
                workspace_id: "workspace-1",
                target_id: "share-claimed",
                payload: {
                  recipientUserId: "recipient-1",
                  claimedAt: "2000-01-01T00:00:00.000Z",
                  claimExpiresAt: "2000-01-01T00:05:00.000Z",
                },
              },
            ],
          };
        }
        if (normalized.includes("from shares")) {
          expect(params).toEqual(["workspace-1", "share-claimed"]);
          return { rows: [{ recipient_user_id: "recipient-1" }] };
        }
        if (normalized.startsWith("update")) {
          claimUpdates.push(params ?? []);
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        expect(params?.[0]).toBe("claimed-event");
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const disconnects: Array<{ workspaceId: string; userId: string }> = [];
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async (input) => {
          events.push("disconnect");
          disconnects.push({ workspaceId: input.workspaceId, userId: input.userId });
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 1,
      disconnected: 1,
      failed: 0,
    });

    expect(disconnects).toEqual([{ workspaceId: "workspace-1", userId: "recipient-1" }]);
    expect(claimUpdates).toHaveLength(1);
    expect(claimUpdates[0]?.[0]).toBe("claimed-event");
    expect(typeof claimUpdates[0]?.[1]).toBe("string");
    expect(claimUpdates[0]?.[2]).toBe("recipient-1");
    expect(claimUpdates[0]?.[3]).toBe(300);
    expect(events.filter((event) => event === "disconnect")).toHaveLength(1);
    expect(events).toEqual([
      "delete",
      "connect",
      "begin",
      "select",
      "select",
      "update",
      "commit",
      "release",
      "disconnect",
      "update",
      "delete",
    ]);
  });

  it("does not reclaim legacy claimed events until claimedAt is stale", async () => {
    const events: string[] = [];
    const claimUpdates: unknown[][] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select")) {
          expect(params).toHaveLength(3);
          expect(params?.slice(0, 2)).toEqual([100, 300]);
          expect(text).toContain("payload->>'claimExpiresAt' is null");
          expect(text).toContain("payload->>'claimedAt' is null");
          expect(text).toContain("payload->>'claimedAt' !~ $3");
          expect(text).toContain("clock_timestamp() - $2::integer * interval '1 second'");
          return { rows: [] };
        }
        if (normalized.startsWith("update")) {
          claimUpdates.push(params ?? []);
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async () => {
          throw new Error("should not disconnect a recent legacy claim");
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 0,
      disconnected: 0,
      failed: 0,
    });

    expect(claimUpdates).toEqual([]);
    expect(events).toEqual(["connect", "begin", "select", "commit", "release"]);
  });

  it("does not requeue a stale claim after a newer worker claims the event", async () => {
    const events: string[] = [];
    let storedKind = "share.revocation.disconnect_pending";
    let storedClaimId = "";
    let storedClaimedAt = "";
    const requeueAttempts: unknown[][] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select") && normalized.includes("from workspace_events")) {
          return {
            rows: [
              {
                id: "event-1",
                workspace_id: "workspace-1",
                target_id: "share-1",
                payload: { recipientUserId: "recipient-1" },
              },
            ],
          };
        }
        if (normalized.includes("from shares")) {
          expect(params).toEqual(["workspace-1", "share-1"]);
          return { rows: [{ recipient_user_id: "recipient-1" }] };
        }
        if (normalized.startsWith("update")) {
          storedKind = "share.revocation.disconnect_claimed";
          storedClaimedAt = "db-clock";
          storedClaimId = params?.[1] as string;
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("update")) {
          expect(text).toContain("payload->>'claimId' = $2");
          expect(text).toContain("retryAfter");
          requeueAttempts.push(params ?? []);
          if (params?.[1] === storedClaimId) {
            storedKind = "share.revocation.disconnect_pending";
          }
        }
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async () => {
          events.push("disconnect");
          storedKind = "share.revocation.disconnect_claimed";
          storedClaimedAt = new Date().toISOString();
          storedClaimId = "newer-claim";
          throw new Error("admin unavailable");
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 1,
      disconnected: 0,
      failed: 1,
    });

    expect(requeueAttempts).toHaveLength(1);
    expect(requeueAttempts[0]?.[0]).toBe("event-1");
    expect(requeueAttempts[0]?.[1]).not.toBe("newer-claim");
    expect(requeueAttempts[0]?.[2]).toBe(30);
    expect(storedKind).toBe("share.revocation.disconnect_claimed");
    expect(storedClaimId).toBe("newer-claim");
    expect(Date.parse(storedClaimedAt)).toBeGreaterThan(0);
    expect(events).toEqual([
      "delete",
      "connect",
      "begin",
      "select",
      "select",
      "update",
      "commit",
      "release",
      "disconnect",
      "update",
      "delete",
    ]);
  });

  it("recovers malformed pending revocation events from the revoked share row", async () => {
    const events: string[] = [];
    const deleted: unknown[][] = [];
    const claimUpdates: unknown[][] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select") && normalized.includes("from workspace_events")) {
          expect(params).toEqual([100, 300, expect.any(String)]);
          return {
            rows: [
              {
                id: "bad-event",
                workspace_id: "workspace-1",
                target_id: "share-bad",
                payload: { recipientUserId: "" },
              },
              {
                id: "event-1",
                workspace_id: "workspace-1",
                target_id: "share-good",
                payload: { recipientUserId: "recipient-1" },
              },
            ],
          };
        }
        if (normalized.includes("from shares")) {
          if (params?.[1] === "share-bad") {
            expect(params).toEqual(["workspace-1", "share-bad"]);
            return { rows: [{ recipient_user_id: "recipient-from-share" }] };
          }
          expect(params).toEqual(["workspace-1", "share-good"]);
          return { rows: [{ recipient_user_id: "recipient-1" }] };
        }
        if (normalized.startsWith("delete")) {
          deleted.push(params ?? []);
        }
        if (normalized.startsWith("update")) {
          claimUpdates.push(params ?? []);
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("delete")) {
          deleted.push(params ?? []);
        }
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const disconnects: Array<{ workspaceId: string; userId: string }> = [];
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async (input) => {
          events.push("disconnect");
          disconnects.push({ workspaceId: input.workspaceId, userId: input.userId });
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps, Number.NaN)).resolves.toEqual({
      ok: true,
      attempted: 2,
      disconnected: 2,
      failed: 0,
    });

    expect(disconnects).toEqual([
      { workspaceId: "workspace-1", userId: "recipient-from-share" },
      { workspaceId: "workspace-1", userId: "recipient-1" },
    ]);
    expect(claimUpdates[0]?.[0]).toBe("bad-event");
    expect(claimUpdates[0]?.[2]).toBe("recipient-from-share");
    expect(claimUpdates[0]?.[3]).toBe(300);
    expect(deleted.map((params) => params[0]).filter((param) => typeof param === "string"))
      .toEqual([]);
    expect(events).toEqual([
      "delete",
      "connect",
      "begin",
      "select",
      "select",
      "update",
      "select",
      "update",
      "commit",
      "release",
      "disconnect",
      "update",
      "disconnect",
      "update",
      "delete",
    ]);
  });

  it("does not recover malformed revocation events across workspace boundaries", async () => {
    const events: string[] = [];
    const shareLookups: unknown[][] = [];
    const deleted: unknown[][] = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select") && normalized.includes("from workspace_events")) {
          return {
            rows: [
              {
                id: "event-foreign",
                workspace_id: "workspace-2",
                target_id: "share-bad",
                payload: { recipientUserId: "" },
              },
            ],
          };
        }
        if (normalized.includes("from shares")) {
          shareLookups.push(params ?? []);
          return { rows: [] };
        }
        if (normalized.startsWith("delete")) {
          deleted.push(params ?? []);
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async () => {
          throw new Error("should not disconnect a foreign-workspace share");
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 1,
      disconnected: 0,
      failed: 1,
    });

    expect(shareLookups).toEqual([["workspace-2", "share-bad"]]);
    expect(deleted).toEqual([["event-foreign"]]);
    expect(events).toEqual([
      "connect",
      "begin",
      "select",
      "select",
      "delete",
      "commit",
      "release",
    ]);
  });

  it("counts disconnect success when terminal event cleanup delete fails and cleans it on retry", async () => {
    const events: string[] = [];
    const completedUpdates: unknown[][] = [];
    const cleanupDeletes: unknown[][] = [];
    let storedKind = "share.revocation.disconnect_pending";
    let failTerminalCleanupDeletes = 1;
    let disconnectCount = 0;
    const client = {
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("select") && normalized.includes("from workspace_events")) {
          expect(params).toEqual([100, 300, expect.any(String)]);
          if (storedKind === "share.revocation.disconnect_completed") {
            return {
              rows: [
                {
                  id: "event-1",
                  kind: "share.revocation.disconnect_completed",
                  workspace_id: "workspace-1",
                  target_id: "share-1",
                  payload: { completedAt: "2026-07-01T00:00:00.000Z" },
                },
              ],
            };
          }
          if (storedKind !== "share.revocation.disconnect_pending") {
            return { rows: [] };
          }
          return {
            rows: [
              {
                id: "event-1",
                kind: "share.revocation.disconnect_pending",
                workspace_id: "workspace-1",
                target_id: "share-1",
                payload: { recipientUserId: "recipient-1" },
              },
            ],
          };
        }
        if (normalized.includes("from shares")) {
          expect(params).toEqual(["workspace-1", "share-1"]);
          return { rows: [{ recipient_user_id: "recipient-1" }] };
        }
        if (normalized.startsWith("update")) {
          storedKind = "share.revocation.disconnect_claimed";
        }
        if (normalized.startsWith("delete")) {
          expect(params).toEqual(["event-1"]);
          cleanupDeletes.push(params ?? []);
          storedKind = "deleted";
        }
        return { rows: [] };
      },
      release: () => {
        events.push("release");
      },
    };
    const pool = {
      connect: async () => {
        events.push("connect");
        return client;
      },
      query: async (text: string, params?: unknown[]) => {
        const normalized = text.trim().toLowerCase();
        events.push(normalized.split(/\s+/u)[0] ?? "query");
        if (normalized.startsWith("update")) {
          completedUpdates.push(params ?? []);
          storedKind = "share.revocation.disconnect_completed";
          return { rows: [] };
        }
        expect(params).toEqual(["event-1", completedUpdates[0]?.[1]]);
        if (failTerminalCleanupDeletes > 0) {
          failTerminalCleanupDeletes -= 1;
          throw new Error("cleanup failed");
        }
        storedKind = "deleted";
        cleanupDeletes.push(params ?? []);
        return { rows: [] };
      },
    } as unknown as pg.Pool;
    const deps: SharedAtomDeps = {
      pool,
      hocuspocusAdmin: {
        disconnectWorkspaceUser: async () => {
          events.push("disconnect");
          disconnectCount += 1;
        },
      },
    };

    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 1,
      disconnected: 1,
      failed: 0,
    });

    expect(events).toEqual([
      "delete",
      "connect",
      "begin",
      "select",
      "select",
      "update",
      "commit",
      "release",
      "disconnect",
      "update",
      "delete",
    ]);
    expect(completedUpdates).toHaveLength(1);
    expect(completedUpdates[0]?.[0]).toBe("event-1");
    expect(typeof completedUpdates[0]?.[1]).toBe("string");
    expect(storedKind).toBe("share.revocation.disconnect_completed");

    events.length = 0;
    await expect(retryPendingShareRevocationDisconnects(deps)).resolves.toEqual({
      ok: true,
      attempted: 0,
      disconnected: 0,
      failed: 0,
    });

    expect(disconnectCount).toBe(1);
    expect(cleanupDeletes).toEqual([["event-1"]]);
    expect(storedKind).toBe("deleted");
    expect(events).toEqual([
      "delete",
      "connect",
      "begin",
      "select",
      "delete",
      "commit",
      "release",
      "delete",
    ]);
  });
});
