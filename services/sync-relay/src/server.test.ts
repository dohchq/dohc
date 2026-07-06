import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-api/auth/session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dohc-sync-relay-${label}-`));
  roots.push(root);
  return root;
}

async function testStorage(): Promise<SyncRelayStorage> {
  const root = await tempRoot("db");
  return openSyncRelayStorage(join(root, "relay.sqlite"));
}

function handler(storage: SyncRelayStorage): SyncRelayHandler {
  const resolveActor: ResolveActor = (request, workspaceId) => {
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer user:")) throw new UnauthorizedError();
    return { userId: auth.slice("Bearer user:".length), workspaceId };
  };
  return createSyncRelayHandler({ storage, resolveActor, nowMs: () => 1234 });
}

function request(
  userId: string | null,
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (userId) headers.set("authorization", `Bearer user:${userId}`);
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createWorkspace(h: SyncRelayHandler, userId = "a", workspaceId = "workspace-a") {
  const response = await h(request(userId, "/sync/workspaces", jsonBody({ workspaceId })));
  expect(response.status).toBe(200);
}

function op(originSeq: number, payload: Record<string, unknown> = { n: originSeq }) {
  return { originSeq, opKind: "opaque.test", payload, recordedAtMs: 1000 + originSeq };
}

describe("sync relay handler", () => {
  it("requires auth before storage access on every route, including blob GET", async () => {
    const throwingStorage = new Proxy(
      {},
      {
        get() {
          throw new Error("storage should not be accessed");
        },
      },
    ) as SyncRelayStorage;
    const h = handler(throwingStorage);
    const blobSha = sha256("blob");
    const cases: Request[] = [
      request(null, "/sync/workspaces", jsonBody({ workspaceId: "workspace-a" })),
      request(null, `/sync/workspace-a/blobs/${blobSha}`, { method: "PUT", body: "blob" }),
      request(null, `/sync/workspace-a/blobs/${blobSha}`, { method: "GET" }),
      request(null, "/sync/workspace-a/blobs/have", jsonBody({ sha256s: [blobSha] })),
      request(null, "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [op(0)] })),
      request(null, "/sync/workspace-a/log?since=0", { method: "GET" }),
    ];
    for (const req of cases) {
      const response = await h(req);
      expect(response.status).toBe(401);
    }
  });

  it("rejects cross-user workspace access on every workspace-scoped route without distinguishing absent buckets", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    const workspaceId = "workspace-owned";
    await createWorkspace(h, "owner", workspaceId);
    const bytes = Buffer.from("owned blob");
    const blobSha = sha256(bytes);
    expect(
      (await h(request("owner", `/sync/${workspaceId}/blobs/${blobSha}`, { method: "PUT", body: bytes }))).status,
    ).toBe(200);
    expect(
      (await h(request("owner", `/sync/${workspaceId}/log`, jsonBody({ originId: "origin-a", ops: [op(0)] })))).status,
    ).toBe(200);

    const absentWorkspace = "workspace-absent";
    const cases = [
      (ws: string) => request("intruder", `/sync/${ws}/blobs/${blobSha}`, { method: "PUT", body: bytes }),
      (ws: string) => request("intruder", `/sync/${ws}/blobs/${blobSha}`, { method: "GET" }),
      (ws: string) => request("intruder", `/sync/${ws}/blobs/have`, jsonBody({ sha256s: [blobSha] })),
      (ws: string) => request("intruder", `/sync/${ws}/log`, jsonBody({ originId: "origin-b", ops: [op(0)] })),
      (ws: string) => request("intruder", `/sync/${ws}/log?since=0`, { method: "GET" }),
    ];

    for (const makeRequest of cases) {
      const forbidden = await h(makeRequest(workspaceId));
      const absent = await h(makeRequest(absentWorkspace));
      expect(forbidden.status).toBe(404);
      expect(await forbidden.text()).toBe(await absent.text());
    }

    const claim = await h(request("intruder", "/sync/workspaces", jsonBody({ workspaceId })));
    expect(claim.status).toBe(404);
  });

  it("rejects an origin_seq gap atomically", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const gap = await h(
      request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [op(0), op(2)] })),
    );
    expect(gap.status).toBe(409);
    const fetched = await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })));
    expect(fetched.ops).toEqual([]);
  });

  it("rejects an origin_seq regression with mismatched content", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    expect(
      (await h(request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [op(0)] })))).status,
    ).toBe(200);
    const mismatch = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({ originId: "origin-a", ops: [op(0, { different: true })] }),
      ),
    );
    expect(mismatch.status).toBe(409);
  });

  it("treats identical replay and overlapping replay as idempotent without duplicate rows", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const first = [op(0), op(1)];
    expect(
      (await h(request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: first })))).status,
    ).toBe(200);
    const overlapResponse = await h(
      request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [first[1], op(2)] })),
    );
    expect(overlapResponse.status).toBe(200);
    expect(await json(overlapResponse)).toMatchObject({ inserted: 1, skipped: 1 });
    const fetched = await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })));
    expect((fetched.ops as unknown[])).toHaveLength(3);
  });

  it("rejects blob PUT when the body does not match the URL sha and stores nothing", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const pathSha = sha256("correct");
    const put = await h(request("a", `/sync/workspace-a/blobs/${pathSha}`, { method: "PUT", body: "wrong" }));
    expect(put.status).toBe(400);
    const get = await h(request("a", `/sync/workspace-a/blobs/${pathSha}`, { method: "GET" }));
    expect(get.status).toBe(404);
  });

  it("reports blob have missing hashes", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const haveBytes = Buffer.from("have");
    const haveSha = sha256(haveBytes);
    const missingSha = sha256("missing");
    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${haveSha}`, { method: "PUT", body: haveBytes }))).status,
    ).toBe(200);
    const response = await json(
      await h(request("a", "/sync/workspace-a/blobs/have", jsonBody({ sha256s: [haveSha, missingSha] }))),
    );
    expect(response.missing).toEqual([missingSha]);
  });

  it("paginates log fetches by relay_seq across multiple origins", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    expect(
      (await h(request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [op(0)] })))).status,
    ).toBe(200);
    expect(
      (await h(request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-b", ops: [op(0, { b: 0 })] })))).status,
    ).toBe(200);
    expect(
      (await h(request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [op(1)] })))).status,
    ).toBe(200);

    const firstPage = await json(await h(request("a", "/sync/workspace-a/log?since=0&limit=2", { method: "GET" })));
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBe(2);
    expect((firstPage.ops as Array<{ originId: string; originSeq: number }>).map((row) => [row.originId, row.originSeq])).toEqual([
      ["origin-a", 0],
      ["origin-b", 0],
    ]);
    const secondPage = await json(
      await h(request("a", `/sync/workspace-a/log?since=${firstPage.nextCursor}&limit=2`, { method: "GET" })),
    );
    expect(secondPage.hasMore).toBe(false);
    expect((secondPage.ops as Array<{ originId: string; originSeq: number }>).map((row) => [row.originId, row.originSeq])).toEqual([
      ["origin-a", 1],
    ]);
  });

  it("accepts and returns unknown opaque op payloads without op-kind semantics", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const payload = { z: ["opaque", 1], nested: { unknown: true } };
    const pushed = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({ originId: "origin-a", ops: [{ originSeq: 0, opKind: "future.opaque", payload, recordedAtMs: 42 }] }),
      ),
    );
    expect(pushed.status).toBe(200);
    const fetched = await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })));
    expect(fetched.ops).toEqual([
      {
        relaySeq: 1,
        workspaceId: "workspace-a",
        originId: "origin-a",
        originSeq: 0,
        opKind: "future.opaque",
        payload,
        recordedAtMs: 42,
      },
    ]);
  });
});
