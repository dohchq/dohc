import { describe, expect, it } from "vitest";
import { COLLAB_TOKEN_TTL_SECONDS, verifyCollabToken } from "@dohc/hocuspocus/auth";
import { decodeDocName } from "@dohc/hocuspocus/doc-name";
import type pg from "pg";
import { createWorkspaceApiHandler } from "./server";

// The reduced service exposes a single application route: the collab-token
// endpoint. These tests exercise its HTTP routing/authz shape through the
// handler with a stub pool (collab.test.ts proves the token against live pg).

async function json(response: Response) {
  return (await response.json()) as any;
}

// Collab token deps stub: first query is the membership check, second the
// path->atoms.id resolve (mintCollabToken's only two statements).
function stubCollabPool(state: { member: boolean; atomId?: string }): pg.Pool {
  return {
    async query(sql: string) {
      if (/workspace_members/.test(sql)) {
        return { rowCount: state.member ? 1 : 0, rows: [] };
      }
      return {
        rowCount: state.atomId ? 1 : 0,
        rows: state.atomId ? [{ id: state.atomId, kind: "markdown", body: "# Day\n" }] : [],
      };
    },
  } as unknown as pg.Pool;
}

function collabHandler(state: { member: boolean; atomId?: string }, jwtSecret?: string) {
  return createWorkspaceApiHandler({
    resolveActor: async (_request, workspaceId) => ({ userId: "server_user", workspaceId }),
    collab: jwtSecret === undefined ? undefined : { pool: stubCollabPool(state), jwtSecret },
  });
}

function postCollabToken(handler: ReturnType<typeof createWorkspaceApiHandler>, body: unknown) {
  return handler(
    new Request("http://api.test/workspaces/ws_api/collab/token", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("workspace API service (collab surface)", () => {
  it("mints hocuspocus-verifiable collab tokens for the server-resolved actor", async () => {
    const handler = collabHandler({ member: true, atomId: "atom-uuid-1" }, "collab-test-secret");
    const body = await json(await postCollabToken(handler, { atomPath: "notes/day.md" }));

    expect(body.ok).toBe(true);
    expect(decodeDocName(body.documentName)).toEqual({
      workspaceId: "ws_api",
      atomId: "atom-uuid-1",
    });
    const claims = await verifyCollabToken(body.token, "collab-test-secret");
    expect(claims).toMatchObject({
      sub: "server_user",
      ws: "ws_api",
      actorKind: "user",
      authzVersion: 1,
    });
    expect(claims.exp - claims.iat).toBe(COLLAB_TOKEN_TTL_SECONDS);
  });

  it("rejects collab token requests for non-members, missing atoms, and disabled deployments", async () => {
    const cases: Array<{
      handler: ReturnType<typeof createWorkspaceApiHandler>;
      body: unknown;
      status: number;
      code: string;
    }> = [
      { handler: collabHandler({ member: false, atomId: "a" }, "s"), body: { atomPath: "x.md" }, status: 403, code: "forbidden" },
      { handler: collabHandler({ member: true }, "s"), body: { atomPath: "x.md" }, status: 404, code: "not-found" },
      { handler: collabHandler({ member: true, atomId: "a" }, "s"), body: { workspaceId: "other", atomPath: "x.md" }, status: 403, code: "forbidden" },
      { handler: collabHandler({ member: true, atomId: "a" }, "s"), body: {}, status: 400, code: "invalid-path" },
      { handler: collabHandler({ member: true, atomId: "a" }), body: { atomPath: "x.md" }, status: 400, code: "collab-disabled" },
    ];
    for (const testCase of cases) {
      const response = await postCollabToken(testCase.handler, testCase.body);
      expect(response.status).toBe(testCase.status);
      await expect(json(response)).resolves.toMatchObject({ ok: false, code: testCase.code });
    }
  });

  it("404s unknown routes", async () => {
    const handler = collabHandler({ member: true, atomId: "a" }, "s");
    const response = await handler(new Request("http://api.test/workspaces/ws_api/files"));
    expect(response.status).toBe(404);
  });
});
