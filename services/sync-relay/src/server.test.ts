import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-api/auth/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BLOB_BYTES,
  MAX_KEY_ENVELOPE_BYTES,
  createSyncRelayHandler,
  type SyncRelayHandler,
} from "./server";
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
      request(null, "/sync/workspace-a/keys", { method: "GET" }),
      request(null, "/sync/workspace-a/keys", { method: "PUT", body: "{}" }),
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
      (ws: string) => request("intruder", `/sync/${ws}/keys`, { method: "GET" }),
      (ws: string) => request("intruder", `/sync/${ws}/keys`, { method: "PUT", body: "{}" }),
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

  // Gate finding: a missing blob in an OWNED workspace must be
  // distinguishable from a missing/foreign workspace so clients can degrade
  // honestly instead of reporting the whole workspace unavailable. The
  // isolation invariant is untouched: non-owners still get the fixed
  // absent-workspace shape.
  it("distinguishes a missing blob from a missing workspace, for owners only", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const missingSha = sha256("nowhere");

    const ownedMiss = await h(request("a", `/sync/workspace-a/blobs/${missingSha}`, { method: "GET" }));
    expect(ownedMiss.status).toBe(404);
    expect(await json(ownedMiss)).toMatchObject({ ok: false, code: "blob_not_found" });

    const absentWorkspace = await h(request("a", `/sync/workspace-absent/blobs/${missingSha}`, { method: "GET" }));
    const intruder = await h(request("intruder", `/sync/workspace-a/blobs/${missingSha}`, { method: "GET" }));
    expect(absentWorkspace.status).toBe(404);
    expect(intruder.status).toBe(404);
    const absentBody = await absentWorkspace.text();
    expect(await intruder.text()).toBe(absentBody);
    expect(absentBody).not.toContain("blob_not_found");
  });

  it("stores one opaque key envelope per owned workspace with size and JSON validation", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const missing = await h(request("a", "/sync/workspace-a/keys", { method: "GET" }));
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ code: "key_envelope_not_found" });

    const envelope = JSON.stringify({
      format: "dohc-key-envelope-v1",
      saltBase64: "AA==",
      scryptN: 131072,
      scryptR: 8,
      scryptP: 1,
      ivBase64: "AA==",
      authTagBase64: "AA==",
      ciphertextBase64: "AA==",
    });
    const put = await h(
      request("a", "/sync/workspace-a/keys", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: envelope,
      }),
    );
    expect(put.status).toBe(200);
    await expect((await h(request("a", "/sync/workspace-a/keys", { method: "GET" }))).text()).resolves.toBe(
      envelope,
    );

    const invalid = await h(request("a", "/sync/workspace-a/keys", { method: "PUT", body: "[]" }));
    expect(invalid.status).toBe(400);
    const oversized = await h(
      request("a", "/sync/workspace-a/keys", {
        method: "PUT",
        body: JSON.stringify({ value: "x".repeat(MAX_KEY_ENVELOPE_BYTES) }),
      }),
    );
    expect(oversized.status).toBe(413);
  });

  // Gate finding: unclassified errors (auth DB hiccup, unexpected SQLite
  // failure) must become a generic 500 — never a crash, never a raw
  // error.message leak.
  it("returns a generic 500 when the auth backend fails, without leaking internals", async () => {
    const storage = await testStorage();
    const resolveActor: ResolveActor = () => {
      throw new Error("connection terminated unexpectedly (pg pool internal detail)");
    };
    const h = createSyncRelayHandler({ storage, resolveActor, nowMs: () => 1234 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" }));
      expect(response.status).toBe(500);
      const body = await json(response);
      expect(body).toEqual({ ok: false, error: "internal error", code: "internal_error" });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns a generic 500 when storage throws, without leaking internals", async () => {
    const throwingStorage = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "workspaceIsOwnedBy") return () => true;
          return () => {
            throw new Error("SQLITE_CORRUPT: index sync_relay_log_secret_detail");
          };
        },
      },
    ) as SyncRelayStorage;
    const h = handler(throwingStorage);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" }));
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("SQLITE_CORRUPT");
      expect(text).not.toContain("secret_detail");
      expect(JSON.parse(text)).toMatchObject({ ok: false, error: "internal error" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects a blob PUT above MAX_BLOB_BYTES with 413 and stores nothing", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const oversized = Buffer.alloc(MAX_BLOB_BYTES + 1, 7);
    const oversizedSha = sha256(oversized);
    const put = await h(
      request("a", `/sync/workspace-a/blobs/${oversizedSha}`, { method: "PUT", body: oversized }),
    );
    expect(put.status).toBe(413);
    const get = await h(request("a", `/sync/workspace-a/blobs/${oversizedSha}`, { method: "GET" }));
    expect(get.status).toBe(404);
  });
});
