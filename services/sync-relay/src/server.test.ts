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

  // WS-G2-C1 GC-ROOT: a blob referenced by a LIVE ydoc.update log op is a root
  // and MUST NOT be collected out from under the rich-doc head — even with a
  // zero grace window (so aging cannot save it) and even though a sibling
  // orphan blob IS reclaimed in the same sweep. This is the relay side of the
  // GC-root invariant G2-B documented; referencedBlobShas now counts the update.
  it("never GCs a blob a live ydoc.update op references (GC root), while collecting a sibling orphan", async () => {
    const storage = await testStorage({ blobGraceMs: 0 });
    const h = handler(storage);
    await createWorkspace(h);

    const update = Buffer.from("yjs-update-bytes-🧬");
    const updateSha = sha256(update);
    const orphan = Buffer.from("truly-orphaned");
    const orphanSha = sha256(orphan);
    for (const [sha, body] of [
      [updateSha, update],
      [orphanSha, orphan],
    ] as const) {
      expect(
        (await h(request("a", `/sync/workspace-a/blobs/${sha}`, { method: "PUT", body }))).status,
      ).toBe(200);
    }

    // Append a ydoc.update op referencing the update blob. The relay is content
    // agnostic (dumb log), but referencedBlobShas must recognize the reference.
    const appended = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({
          originId: "origin-a",
          ops: [
            {
              originSeq: 0,
              opKind: "ydoc.update",
              payload: {
                versionId: "main",
                objectId: "obj-rich",
                path: "docs/rich.md",
                contentKind: "plaintext",
                updateBlobSha256: updateSha,
                isBaseState: true,
              },
              recordedAtMs: 1000,
            },
          ],
        }),
      ),
    );
    expect(appended.status).toBe(200);

    const gc = await json(await h(request("a", "/sync/workspace-a/maintenance/gc", { method: "POST" })));
    // Only the orphan is reclaimed; the live ydoc update blob is a root.
    expect(gc).toEqual({ ok: true, removed: 1, removedSha256s: [orphanSha] });
    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${updateSha}`, { method: "GET" }))).status,
    ).toBe(200);
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

  // 0P sync-hardening GATE FIX (durable log referencing a missing blob). The
  // grace window keeps a fresh blob alive across the PUT->POST gap, but it does
  // NOT cover an old blob that ages past the grace, nor a blob GC'd after a
  // failed /log that a retry re-references. The append validates every
  // referenced blob IN-TRANSACTION and rejects the whole batch (retryable
  // 422 blob_missing) rather than pinning the log to content the relay lost.
  it("rejects a log append referencing a blob the relay never received, atomically", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const contentSha = sha256("never uploaded");
    const rejected = await h(
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
    );
    expect(rejected.status).toBe(422);
    expect(await json(rejected)).toMatchObject({ ok: false, code: "blob_missing" });
    // No partial append: the log stays empty, so it holds no durable reference
    // to a blob the relay cannot serve.
    const log = await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })));
    expect(log.ops).toEqual([]);
  });

  it("rejects an append for a blob GC'd after upload, then accepts it once re-uploaded (closes the grace-window hole)", async () => {
    const clock = { now: 1_000_000 };
    // blobGraceMs: 0 makes the uploaded blob immediately collectible -- the
    // exact "aged past the grace before the referencing op arrives" hole the
    // grace window alone cannot close.
    const storage = await testStorage({ blobGraceMs: 0 });
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
    const content = Buffer.from("aged-out blob");
    const contentSha = sha256(content);
    const op0 = {
      originSeq: 0,
      opKind: "moment.append",
      payload: { operation: "write", payloadAfterBlobSha256: contentSha },
      recordedAtMs: 1000,
    };
    const postOp = () =>
      h(request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [op0] })));

    // Uploaded, then GC'd before any log row references it.
    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${contentSha}`, { method: "PUT", body: content }))).status,
    ).toBe(200);
    clock.now += 1;
    const gc = await json(await h(request("a", "/sync/workspace-a/maintenance/gc", { method: "POST" })));
    expect(gc).toEqual({ ok: true, removed: 1, removedSha256s: [contentSha] });

    // The append that would resurrect a dangling reference is rejected.
    const rejected = await postOp();
    expect(rejected.status).toBe(422);
    expect(await json(rejected)).toMatchObject({ ok: false, code: "blob_missing" });
    expect(
      (await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })))).ops,
    ).toEqual([]);

    // Two-phase happy path: re-upload the blob, then the SAME append lands
    // cleanly against durable content.
    expect(
      (await h(request("a", `/sync/workspace-a/blobs/${contentSha}`, { method: "PUT", body: content }))).status,
    ).toBe(200);
    const accepted = await postOp();
    expect(accepted.status).toBe(200);
    expect(await json(accepted)).toMatchObject({ ok: true, inserted: 1 });
    expect(
      (await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })))).ops,
    ).toHaveLength(1);
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

// WS-MU-C0 — the relay stamps/verifies that a chat op's claimed author equals
// the authenticated pusher (actor.userId) before admitting it to the log. These
// mirror PR-18's isolation rigor: a forged author is rejected atomically and
// leaves the log unchanged; the honest path is admitted; solo ops are untouched.
describe("MU-C0 verified chat authorship", () => {
  function messageOp(
    originSeq: number,
    author: string | undefined,
    messageId = `m-${originSeq}`,
  ) {
    return {
      originSeq,
      opKind: "chat.message.append",
      payload: {
        messageId,
        threadId: "t-1",
        authorKind: "human",
        authorDisplayName: "Someone",
        ...(author !== undefined ? { authorUserId: author } : {}),
        body: "hello",
        createdAtMs: 1000 + originSeq,
      },
      recordedAtMs: 1000 + originSeq,
    };
  }

  function reactionOp(
    originSeq: number,
    author: string | undefined,
    reactionId = `r-${originSeq}`,
  ) {
    const payload: Record<string, unknown> = {
      reactionId,
      messageId: "m-1",
      threadId: "t-1",
      emoji: "👍",
      authorKind: "human",
      authorDisplayName: "Someone",
      state: "added",
      atMs: 1000 + originSeq,
    };
    if (author !== undefined) payload.authorId = author;
    return { originSeq, opKind: "chat.reaction.set", payload, recordedAtMs: 1000 + originSeq };
  }

  function receiverStateOp(
    originSeq: number,
    opKind: "chat.follow.set" | "chat.feed.read.set",
    ownerUserId: string | undefined,
  ) {
    const payload: Record<string, unknown> =
      opKind === "chat.follow.set"
        ? {
            targetKind: "thread",
            targetId: "t-1",
            state: "following",
            atMs: 1000 + originSeq,
          }
        : {
            lastSeenCreatedAtMs: 1000 + originSeq,
            lastSeenMessageId: "m-1",
            atMs: 1000 + originSeq,
          };
    if (ownerUserId !== undefined) payload.ownerUserId = ownerUserId;
    return { originSeq, opKind, payload, recordedAtMs: 1000 + originSeq };
  }

  async function logOps(h: SyncRelayHandler): Promise<unknown[]> {
    const fetched = await json(await h(request("a", "/sync/workspace-a/log?since=0", { method: "GET" })));
    return fetched.ops as unknown[];
  }

  it("admits a chat op whose author IS the authenticated pusher", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const message = await h(
      request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [messageOp(0, "a")] })),
    );
    expect(message.status).toBe(200);
    const reaction = await h(
      request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [reactionOp(1, "a")] })),
    );
    expect(reaction.status).toBe(200);
    expect(await logOps(h)).toHaveLength(2);
  });

  it("stamps the authenticated pusher onto a message.append that omits authorUserId", async () => {
    // The relay only ever sees AUTHENTICATED pushes, so an append that omits
    // authorUserId is not "solo" here — it is attributable to its pusher. The
    // relay stamps actor.userId so the replicated op is VERIFIED, never NULL.
    // (The genuine solo/no-relay omission survives only in the engine-local
    // path, which never traverses the relay.)
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const stamped = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({ originId: "origin-a", ops: [messageOp(0, undefined)] }),
      ),
    );
    expect(stamped.status).toBe(200);
    const ops = await logOps(h);
    expect(ops).toHaveLength(1);
    expect((ops[0] as { payload: { authorUserId?: string } }).payload.authorUserId).toBe("a");
  });

  it("rejects a message.append forging another user's authorUserId, leaving the log unchanged", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const forged = await h(
      request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [messageOp(0, "victim")] })),
    );
    expect(forged.status).toBe(403);
    expect(await json(forged)).toMatchObject({ ok: false, code: "authorship_mismatch" });
    expect(await logOps(h)).toEqual([]);
  });

  it("rejects a chat.reaction.set forging another user's authorId, leaving the log unchanged", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const forged = await h(
      request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [reactionOp(0, "victim")] })),
    );
    expect(forged.status).toBe(403);
    expect(await json(forged)).toMatchObject({ ok: false, code: "authorship_mismatch" });
    expect(await logOps(h)).toEqual([]);
  });

  it("rejects a reaction op with no authorId at all (required author, fail-closed)", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const missing = await h(
      request("a", "/sync/workspace-a/log", jsonBody({ originId: "origin-a", ops: [reactionOp(0, undefined)] })),
    );
    expect(missing.status).toBe(403);
    expect(await json(missing)).toMatchObject({ ok: false, code: "authorship_mismatch" });
    expect(await logOps(h)).toEqual([]);
  });

  it("admits follow and feed-read state owned by the authenticated pusher", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const admitted = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({
          originId: "origin-a",
          ops: [
            receiverStateOp(0, "chat.follow.set", "a"),
            receiverStateOp(1, "chat.feed.read.set", "a"),
          ],
        }),
      ),
    );
    expect(admitted.status).toBe(200);
    expect(await logOps(h)).toHaveLength(2);
  });

  for (const opKind of ["chat.follow.set", "chat.feed.read.set"] as const) {
    it(`rejects ${opKind} forging another user's ownerUserId`, async () => {
      const storage = await testStorage();
      const h = handler(storage);
      await createWorkspace(h);
      const forged = await h(
        request(
          "a",
          "/sync/workspace-a/log",
          jsonBody({ originId: "origin-a", ops: [receiverStateOp(0, opKind, "victim")] }),
        ),
      );
      expect(forged.status).toBe(403);
      expect(await json(forged)).toMatchObject({ ok: false, code: "authorship_mismatch" });
      expect(await logOps(h)).toEqual([]);
    });

    it(`rejects ${opKind} with no ownerUserId (required owner, fail-closed)`, async () => {
      const storage = await testStorage();
      const h = handler(storage);
      await createWorkspace(h);
      const missing = await h(
        request(
          "a",
          "/sync/workspace-a/log",
          jsonBody({ originId: "origin-a", ops: [receiverStateOp(0, opKind, undefined)] }),
        ),
      );
      expect(missing.status).toBe(403);
      expect(await json(missing)).toMatchObject({ ok: false, code: "authorship_mismatch" });
      expect(await logOps(h)).toEqual([]);
    });
  }

  it("rejects a batch mixing one valid and one forged op ATOMICALLY (nothing admitted)", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const mixed = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({ originId: "origin-a", ops: [messageOp(0, "a"), reactionOp(1, "victim")] }),
      ),
    );
    expect(mixed.status).toBe(403);
    expect(await json(mixed)).toMatchObject({ ok: false, code: "authorship_mismatch" });
    // Atomic: the valid op in the same batch was NOT admitted either.
    expect(await logOps(h)).toEqual([]);
  });

  it("does not touch non-chat ops (opaque payloads with an authorId-shaped field pass through)", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    // A non-chat op that happens to carry an authorId belonging to someone else
    // is NOT a chat op, so the authorship gate ignores it.
    const opaque = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({ originId: "origin-a", ops: [op(0, { authorId: "victim", n: 0 })] }),
      ),
    );
    expect(opaque.status).toBe(200);
    expect(await logOps(h)).toHaveLength(1);
  });

  it("passes through known no-author structural and message-derived chat ops", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const structural = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({
          originId: "origin-a",
          ops: [
            {
              originSeq: 0,
              opKind: "chat.channel.create",
              payload: { channelId: "c-1", name: "general", slug: "general", createdAtMs: 1000 },
              recordedAtMs: 1000,
            },
            {
              originSeq: 1,
              opKind: "chat.thread.create",
              payload: { threadId: "t-1", title: "hi", createdAtMs: 1001, channelSlug: "general" },
              recordedAtMs: 1001,
            },
            {
              originSeq: 2,
              opKind: "chat.decision.set",
              payload: { threadId: "t-1", messageId: "m-1", state: "open", atMs: 1002 },
              recordedAtMs: 1002,
            },
            {
              originSeq: 3,
              opKind: "chat.attachment.add",
              payload: {
                attachmentId: "attachment-1",
                threadId: "t-1",
                messageId: "m-1",
                targetKind: "file",
                objectId: "object-1",
                createdAtMs: 1003,
              },
              recordedAtMs: 1003,
            },
          ],
        }),
      ),
    );
    expect(structural.status).toBe(200);
    expect(await logOps(h)).toHaveLength(4);
  });

  it("REJECTS an unknown chat.* op carrying author-shaped fields (fail-closed completeness)", async () => {
    // A future authored chat op (here a made-up chat.thread.update) that carries
    // an author-shaped field we have NOT taught the policy to verify must be
    // refused, not admitted unverified. Shipping a new authored chat op without
    // extending CHAT_OP_POLICY fails closed.
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const unknownAuthored = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({
          originId: "origin-a",
          ops: [
            {
              originSeq: 0,
              opKind: "chat.thread.update",
              payload: { threadId: "t-1", authorUserId: "victim", title: "renamed" },
              recordedAtMs: 1000,
            },
          ],
        }),
      ),
    );
    expect(unknownAuthored.status).toBe(403);
    expect(await json(unknownAuthored)).toMatchObject({ ok: false, code: "unknown_chat_op" });
    expect(await logOps(h)).toEqual([]);
  });

  it("REJECTS a made-up chat.* op even with no author field (unknown = fail-closed)", async () => {
    const storage = await testStorage();
    const h = handler(storage);
    await createWorkspace(h);
    const madeUp = await h(
      request(
        "a",
        "/sync/workspace-a/log",
        jsonBody({
          originId: "origin-a",
          ops: [
            {
              originSeq: 0,
              opKind: "chat.message.edit",
              payload: { messageId: "m-1", body: "edited" },
              recordedAtMs: 1000,
            },
          ],
        }),
      ),
    );
    expect(madeUp.status).toBe(403);
    expect(await json(madeUp)).toMatchObject({ ok: false, code: "unknown_chat_op" });
    expect(await logOps(h)).toEqual([]);
  });
});
