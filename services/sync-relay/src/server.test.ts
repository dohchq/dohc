import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BLOB_BYTES,
  MAX_KEY_ENVELOPE_BYTES,
  createSyncRelayHandler,
  type SyncRelayHandler,
} from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

let roots: string[] = [];
let storages: SyncRelayStorage[] = [];

beforeEach(() => {
  roots = [];
  storages = [];
});

afterEach(async () => {
  // Close sqlite handles before removing temp dirs: Windows cannot unlink
  // files that still have open handles (EBUSY).
  for (const storage of storages) storage.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dohc-sync-relay-${label}-`));
  roots.push(root);
  return root;
}

async function testStorage(
  options?: Parameters<typeof openSyncRelayStorage>[1],
): Promise<SyncRelayStorage> {
  const root = await tempRoot("db");
  const storage = openSyncRelayStorage(join(root, "relay.sqlite"), options);
  storages.push(storage);
  return storage;
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

function keyEnvelopeJson(saltBase64: string): string {
  return JSON.stringify({
    format: "dohc-key-envelope-v1",
    saltBase64,
    scryptN: 131072,
    scryptR: 8,
    scryptP: 1,
    ivBase64: "AA==",
    authTagBase64: "AA==",
    ciphertextBase64: "AA==",
  });
}

function putKeys(body: string, ifMatch?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ifMatch !== undefined) headers["if-match"] = `"${ifMatch}"`;
  return request("a", "/sync/workspace-a/keys", { method: "PUT", headers, body });
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

    const envelope = keyEnvelopeJson("AA==");
    const put = await h(
      request("a", "/sync/workspace-a/keys", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: envelope,
      }),
    );
    expect(put.status).toBe(200);
    const get = await h(request("a", "/sync/workspace-a/keys", { method: "GET" }));
    await expect(get.text()).resolves.toBe(envelope);
    // The GET exposes the current fingerprint + write time so clients can
    // detect a replaced envelope.
    expect(get.headers.get("etag")).toBe(`"${sha256(envelope)}"`);
    expect(get.headers.get("x-key-envelope-updated-at-ms")).toBe("1234");

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

  // Gate finding (0P-D): the envelope is the only recovery path for the
  // wrapped workspace key, so PUT /keys is create-only on first write and
  // compare-and-swap (If-Match: sha256) thereafter, and every replaced
  // envelope is retained in an audit history.
  it("makes PUT /keys create-only, then CAS: stale writes 409, one enroll winner, history retained", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const first = keyEnvelopeJson("Zmlyc3Q=");
    const second = keyEnvelopeJson("c2Vjb25k");
    const third = keyEnvelopeJson("dGhpcmQ=");

    const create = await h(putKeys(first));
    expect(create.status).toBe(200);
    expect(await json(create)).toMatchObject({ ok: true, sha256: sha256(first) });

    // Concurrent-enroll race: a second unconditional PUT with DIFFERENT
    // content loses — exactly one winner, nothing clobbered.
    const racingCreate = await h(putKeys(second));
    expect(racingCreate.status).toBe(409);
    await expect(
      (await h(request("a", "/sync/workspace-a/keys", { method: "GET" }))).text(),
    ).resolves.toBe(first);

    // A byte-identical re-PUT is an idempotent retry, not a replacement.
    const retry = await h(putKeys(first));
    expect(retry.status).toBe(200);
    expect(storage.getKeyEnvelopeHistory("workspace-a")).toEqual([]);

    // Stale CAS: If-Match naming anything but the current envelope is a 409.
    const stale = await h(putKeys(second, sha256(third)));
    expect(stale.status).toBe(409);
    const malformedIfMatch = await h(putKeys(second, "not-a-sha"));
    expect(malformedIfMatch.status).toBe(400);

    // Correct CAS replaces, and the GET fingerprint moves with it.
    const replace = await h(putKeys(second, sha256(first)));
    expect(replace.status).toBe(200);
    const afterReplace = await h(request("a", "/sync/workspace-a/keys", { method: "GET" }));
    await expect(afterReplace.text()).resolves.toBe(second);
    expect(afterReplace.headers.get("etag")).toBe(`"${sha256(second)}"`);

    // A now-stale writer (still holding first's fingerprint) is rejected.
    const lostRace = await h(putKeys(third, sha256(first)));
    expect(lostRace.status).toBe(409);

    // Lockout stays recoverable server-side: the replaced envelope is
    // retained byte-for-byte with an audit trail of when and by what.
    expect(storage.getKeyEnvelopeHistory("workspace-a")).toEqual([
      {
        envelopeJson: first,
        sha256: sha256(first),
        replacedAtMs: 1234,
        replacedBySha256: sha256(second),
      },
    ]);
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

  it("rejects a new over-quota blob PUT without rejecting idempotent re-PUTs", async () => {
    const storage = await testStorage({ workspaceQuotaBytes: 5 });
    const h = handler(storage);
    await createWorkspace(h);
    const first = Buffer.from("abc");
    const firstSha = sha256(first);
    const second = Buffer.from("de");
    const secondSha = sha256(second);
    const rejected = Buffer.from("f");
    const rejectedSha = sha256(rejected);

    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${firstSha}`, { method: "PUT", body: first }))).status,
    ).toBe(200);
    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${secondSha}`, { method: "PUT", body: second }))).status,
    ).toBe(200);

    const retry = await json(
      await h(request("a", `/sync/workspace-a/blobs/${firstSha}`, { method: "PUT", body: first })),
    );
    expect(retry).toMatchObject({ ok: true, alreadyHad: true, byteLength: first.byteLength });

    const put = await h(request("a", `/sync/workspace-a/blobs/${rejectedSha}`, { method: "PUT", body: rejected }));
    expect(put.status).toBe(413);
    expect(await json(put)).toMatchObject({ ok: false, code: "quota_exceeded" });
    expect((await h(request("a", `/sync/workspace-a/blobs/${rejectedSha}`, { method: "GET" }))).status).toBe(
      404,
    );
  });

  it("rejects an over-quota log append atomically", async () => {
    const storage = await testStorage({ workspaceQuotaBytes: 40 });
    const h = handler(storage);
    await createWorkspace(h);
    expect(
      (await h(request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [op(0)] })))).status,
    ).toBe(200);

    const rejected = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({
          originId: "origin-a",
          ops: [op(1, { big: "x".repeat(20) }), op(2, { big: "y".repeat(20) })],
        }),
      ),
    );
    expect(rejected.status).toBe(413);
    expect(await json(rejected)).toMatchObject({ ok: false, code: "quota_exceeded" });

    const fetched = await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })));
    expect((fetched.ops as Array<{ originSeq: number }>).map((row) => row.originSeq)).toEqual([0]);
  });

  it("garbage-collects only unreferenced blobs without pruning log or key history", async () => {
    // blobGraceMs: 0 isolates the reference-detection logic under this fixed
    // test clock; the retention grace window is exercised in its own test.
    const storage = await testStorage({ blobGraceMs: 0 });
    const h = handler(storage);
    await createWorkspace(h);
    const referenced = Buffer.from("referenced");
    const referencedSha = sha256(referenced);
    const unreferenced = Buffer.from("unreferenced");
    const unreferencedSha = sha256(unreferenced);

    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${referencedSha}`, { method: "PUT", body: referenced })))
        .status,
    ).toBe(200);
    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${unreferencedSha}`, { method: "PUT", body: unreferenced })))
        .status,
    ).toBe(200);
    expect(
      (
        await h(
          request(
            "a",
            "/sync/workspace-a/log",
            jsonBody({ originId: "origin-a", ops: [op(0, { payloadAfterBlobSha256: referencedSha })] }),
          ),
        )
      ).status,
    ).toBe(200);

    const firstKey = keyEnvelopeJson("Zmlyc3Q=");
    const secondKey = keyEnvelopeJson("c2Vjb25k");
    expect((await h(putKeys(firstKey))).status).toBe(200);
    expect((await h(putKeys(secondKey, sha256(firstKey)))).status).toBe(200);
    const logBefore = await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })));
    const historyBefore = storage.getKeyEnvelopeHistory("workspace-a");

    const gc = await json(
      await h(request("a", "/sync/workspace-a/maintenance/gc", { method: "POST" })),
    );
    expect(gc).toEqual({ ok: true, removed: 1, removedSha256s: [unreferencedSha] });
    expect((await h(request("a", `/sync/workspace-a/blobs/${unreferencedSha}`, { method: "GET" }))).status).toBe(
      404,
    );
    await expect(
      (await h(request("a", `/sync/workspace-a/blobs/${referencedSha}`, { method: "GET" }))).text(),
    ).resolves.toBe("referenced");

    const logAfter = await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })));
    expect(logAfter).toEqual(logBefore);
    expect(storage.getKeyEnvelopeHistory("workspace-a")).toEqual(historyBefore);
  });

  it("allows only the workspace owner to run GC", async () => {
    const storage = await testStorage({ blobGraceMs: 0 });
    const h = handler(storage);
    await createWorkspace(h);
    const orphan = Buffer.from("orphan");
    const orphanSha = sha256(orphan);
    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${orphanSha}`, { method: "PUT", body: orphan }))).status,
    ).toBe(200);

    const nonOwner = await h(request("intruder", "/sync/workspace-a/maintenance/gc", { method: "POST" }));
    expect(nonOwner.status).toBe(404);
    expect((await h(request("a", `/sync/workspace-a/blobs/${orphanSha}`, { method: "GET" }))).status).toBe(
      200,
    );

    const owner = await json(
      await h(request("a", "/sync/workspace-a/maintenance/gc", { method: "POST" })),
    );
    expect(owner).toEqual({ ok: true, removed: 1, removedSha256s: [orphanSha] });
  });

  // 0P sync-hardening item 4 GATE FIX (GC deletes a live blob mid-upload).
  // Blob upload is two-phase: PUT /blobs/:sha, then POST /log referencing it.
  // A GC that ran between the two used to reclaim the blob (no log row referred
  // to it yet), orphaning the content the pending log op depends on. The
  // retention grace window makes a freshly-uploaded blob untouchable, so the
  // append lands on durable content.
  it("does not GC a freshly uploaded blob before its referencing log op is appended (item 4)", async () => {
    const clock = { now: 1_000_000 };
    const storage = await testStorage({ blobGraceMs: 10 * 60 * 1000 });
    const h = createSyncRelayHandler({
      storage,
      resolveActor: (request, workspaceId) => {
        const auth = request.headers.get("authorization") ?? "";
        if (!auth.startsWith("Bearer user:")) throw new UnauthorizedError();
        return { userId: auth.slice("Bearer user:".length), workspaceId };
      },
      nowMs: () => clock.now,
    });
    await createWorkspace(h);
    const content = Buffer.from("blob-in-flight");
    const contentSha = sha256(content);

    // Phase 1: the blob is uploaded.
    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${contentSha}`, { method: "PUT", body: content })))
        .status,
    ).toBe(200);

    // GC runs in the gap BEFORE the log append. The blob is younger than the
    // grace window, so it is NOT reclaimed.
    const gc = await json(await h(request("a", "/sync/workspace-a/maintenance/gc", { method: "POST" })));
    expect(gc).toEqual({ ok: true, removed: 0, removedSha256s: [] });
    expect((await h(request("a", `/sync/workspace-a/blobs/${contentSha}`, { method: "GET" }))).status).toBe(200);

    // Phase 2: the referencing log op is appended against durable content.
    expect(
      (
        await h(
          request(
            "a",
            "/sync/workspace-a/log",
            jsonBody({
              originId: "origin-a",
              ops: [
                {
                  originSeq: 0,
                  opKind: "moment.append",
                  payload: { operation: "write", payloadAfterBlobSha256: contentSha },
                  recordedAtMs: 1000,
                },
              ],
            }),
          ),
        )
      ).status,
    ).toBe(200);

    // Once the blob has aged past the grace window AND is referenced by the log,
    // it stays (referenced). An unreferenced aged blob is still collectible.
    clock.now += 10 * 60 * 1000 + 1;
    const gcLater = await json(await h(request("a", "/sync/workspace-a/maintenance/gc", { method: "POST" })));
    expect(gcLater).toEqual({ ok: true, removed: 0, removedSha256s: [] });
    expect((await h(request("a", `/sync/workspace-a/blobs/${contentSha}`, { method: "GET" }))).status).toBe(200);
  });

  // CodeRabbit Security: openSyncRelayStorage is exported and reused, so it must
  // reject a NaN/Infinity/negative quota itself -- otherwise the quota check
  // (currentUsage + added > NaN) never trips and writes exceed the cap.
  it("refuses to open storage with a non-positive or non-finite quota", async () => {
    const root = await tempRoot("bad-quota");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(() =>
        openSyncRelayStorage(join(root, `relay-${String(bad)}.sqlite`), {
          workspaceQuotaBytes: bad,
        }),
      ).toThrow(/workspaceQuotaBytes/u);
    }
  });

  // CodeRabbit Stability: the key envelope + its append-only history count
  // toward the quota, so a workspace cannot bypass the cap by rotating the
  // envelope over and over.
  it("counts key-envelope storage (including rotation history) against the quota", async () => {
    const first = keyEnvelopeJson("Zmlyc3Q=");
    const storage = await testStorage({ workspaceQuotaBytes: first.length + 10 });
    const h = handler(storage);
    await createWorkspace(h);

    // The create fits under the cap.
    expect((await h(putKeys(first))).status).toBe(200);
    // A rotation moves the prior envelope into history and adds the new one, so
    // usage would roughly double -- over the cap, rejected as quota_exceeded.
    const second = keyEnvelopeJson("c2Vjb25k");
    const rotated = await h(putKeys(second, sha256(first)));
    expect(rotated.status).toBe(413);
    expect(await json(rotated)).toMatchObject({ ok: false, code: "quota_exceeded" });
    // The original envelope is intact (the rejected rotation changed nothing).
    const current = await h(request("a", "/sync/workspace-a/keys", { method: "GET" }));
    expect(await current.text()).toBe(first);
  });
});
