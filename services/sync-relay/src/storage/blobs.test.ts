import { afterEach, expect, it, vi } from "vitest";
import { closeTestStorages, inspectDatabase, storagePath, testStorage, type InspectionDatabase } from "../testing";
import type { StorageContext } from "./context";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestStorages();
});

const hash = "0123456789abcdef".repeat(4);
const orphan = "f".repeat(64);

async function fixture() {
  const storage = await testStorage({ blobGraceMs: 100 });
  for (const workspaceId of ["w", "other"]) {
    storage.claimWorkspace({ workspaceId, ownerUserId: "owner", createdAtMs: 1 });
  }
  const db = (storage as StorageContext).db;
  const put = (sha256: string, createdAtMs = 1, workspaceId = "w") =>
    storage.putBlob({ workspaceId, sha256, content: Buffer.from("bytes"), createdAtMs });
  return { storage, db, put };
}

function append(db: Pick<InspectionDatabase, "prepare">, payload: string, originSeq = 0, workspaceId = "w") {
  db.prepare(`INSERT INTO sync_relay_log
    (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms)
    VALUES (?, 'origin', ?, 'opaque.future.kind', ?, 1)`).run(workspaceId, originSeq, payload);
}

const cases: [string, string, string[]][] = [
  ["lowercase", JSON.stringify({ value: hash }), [hash]],
  ["ASCII uppercase", JSON.stringify({ value: hash.toUpperCase() }), [hash]],
  ["field name", JSON.stringify({ [hash]: "key reference" }), [hash]],
  ["embedded text", JSON.stringify({ value: `left${hash}right` }), [hash]],
  ["overlapping windows", JSON.stringify({ value: `a${hash}b` }), [`a${hash.slice(0, 63)}`, hash, `${hash.slice(1)}b`]],
  ["escaped characters stay escaped", `{"value":"${hash.slice(0, 32)}\\u0038${hash.slice(33)}"}`, [hash]],
  ["non-ASCII lookalike", JSON.stringify({ value: hash.replaceAll("a", "Ａ") }), [hash]],
  ["near match", JSON.stringify({ value: hash.slice(0, -1) }), [hash]],
  ["before literal NUL", `${JSON.stringify({ value: hash })}\0`, [hash]],
  ["after literal NUL", `{}\0${hash}`, [hash]],
  ["chunk boundary", JSON.stringify({ value: "z".repeat(32_730) + hash }), [hash]],
  ["later chunk", JSON.stringify({ value: "z".repeat(80_000) + hash }), [hash]],
  ["astral character offsets", JSON.stringify({ value: "🧬".repeat(32_750) + hash }), [hash]],
  ["noncanonical identifier", JSON.stringify({ value: "prefix-MiXeD-pattern-suffix" }), ["mixed%pattern", "MIXED_pattern", "missing", hash.toUpperCase()]],
  ["mixed canonical and SQL-only identifiers", JSON.stringify({ value: hash.toUpperCase() }), [hash, hash.toUpperCase(), "%", `${hash}\n`]],
];

it.each(cases)("matches existing SQL retention for %s", async (_name, payload, hashes) => {
  const f = await fixture();
  for (const sha of [...hashes, orphan]) f.put(sha);
  append(f.db, payload);
  const expected = f.db.prepare(`SELECT b.sha256 FROM sync_relay_blobs b
    WHERE b.workspace_id = 'w' AND NOT EXISTS (
      SELECT 1 FROM sync_relay_log l WHERE l.workspace_id = b.workspace_id
      AND l.payload_json LIKE '%' || b.sha256 || '%') ORDER BY b.sha256`)
    .all().map(row => String(row.sha256));
  expect(await f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 }))
    .toEqual({ removed: expected.length, removedSha256s: expected });
});

it("does not join payloads across log rows or cross workspace boundaries", async () => {
  const f = await fixture();
  f.put(hash);
  f.put(orphan);
  f.put(hash, 1, "other");
  append(f.db, JSON.stringify(hash.slice(0, 32)), 0);
  append(f.db, JSON.stringify(hash.slice(32)), 1);
  append(f.db, JSON.stringify(hash), 0, "other");
  expect(await f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 }))
    .toEqual({ removed: 2, removedSha256s: [hash, orphan] });
  expect(f.storage.getBlob("other", hash)).not.toBeNull();
});

it("preserves the grace boundary and returns sorted actual deletions across chunks", async () => {
  const f = await fixture();
  const hashes = Array.from({ length: 205 }, (_, i) => i.toString(16).padStart(64, "0"));
  for (const sha of [...hashes].reverse()) f.put(sha, 900);
  f.put(hash, 901);
  const [first, second] = await Promise.all([
    f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 }),
    f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 }),
  ]);
  expect([...first.removedSha256s, ...second.removedSha256s].sort()).toEqual(hashes);
  expect(first.removedSha256s).toEqual([...first.removedSha256s].sort());
  expect(second.removedSha256s).toEqual([...second.removedSha256s].sort());
  expect(f.storage.getBlob("w", hash)).not.toBeNull();
  expect(await f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 }))
    .toEqual({ removed: 0, removedSha256s: [] });
});

it("rechecks external log writes and fresh replacement after discovery yields", async () => {
  const f = await fixture();
  const replacement = "e".repeat(64);
  for (const sha of [hash, replacement, orphan]) f.put(sha);
  for (let index = 0; index < 64; index++) append(f.db, "{}", index);
  const external = inspectDatabase(storagePath(f.storage), { foreignKeys: true });
  let changed = false;
  const change = new Promise<void>((resolve, reject) => setImmediate(() => {
    try {
      external.exec("BEGIN IMMEDIATE");
      append(external, JSON.stringify({ opaque: hash }), 64);
      external.prepare("DELETE FROM sync_relay_blobs WHERE workspace_id='w' AND sha256=?").run(replacement);
      external.prepare(`INSERT INTO sync_relay_blobs
        (workspace_id, sha256, byte_length, content, created_at_ms) VALUES ('w', ?, 1, x'01', 999)`).run(replacement);
      external.exec("COMMIT");
      changed = true;
      resolve();
    } catch (error) { reject(error); }
  }));
  const result = await f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 });
  await change;
  expect(changed).toBe(true);
  expect(result).toEqual({ removed: 1, removedSha256s: [orphan] });
  expect(f.storage.getBlob("w", hash)).not.toBeNull();
  expect(f.storage.getBlob("w", replacement)).toEqual(Buffer.from([1]));
});

it("keeps every locked retention predicate after initial discovery", async () => {
  const f = await fixture();
  const proposalHash = "a".repeat(64);
  const publicationHash = "b".repeat(64);
  for (const sha of [hash, proposalHash, publicationHash, orphan]) f.put(sha);
  f.storage.createShare({
    share: { shareId: "s", workspaceId: "w", granterUserId: "owner", selectorJson: "{}", createdAtMs: 1 },
    grant: { grantId: "g", shareId: "s", principalKind: "user", principalUserId: "reader", principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null },
  });
  const external = inspectDatabase(storagePath(f.storage), { foreignKeys: true });
  const context = f.storage as StorageContext;
  const originalTx = context.tx.bind(context);
  vi.spyOn(context, "tx").mockImplementationOnce(run => {
    external.exec("BEGIN IMMEDIATE");
    append(external, JSON.stringify({ opaque: hash }));
    external.exec(`INSERT INTO sync_relay_share_proposals
      (proposal_id, share_id, workspace_id, proposed_by_user_id, version_id, submit_id, state, created_at_ms)
      VALUES ('p', 's', 'w', 'reader', 'main', 'submit', 'open', 1)`);
    external.prepare(`INSERT INTO sync_relay_share_proposal_ops
      (proposal_id, op_index, operation, after_blob_sha256, recorded_at_ms) VALUES ('p', 0, 'write', ?, 1)`)
      .run(proposalHash);
    external.prepare(`INSERT INTO sync_relay_app_publications
      (publication_id, workspace_id, share_id, grant_id, grant_generation, owner_user_id,
        manifest_sha256, created_at_ms, active, authority_revision)
      VALUES ('pub', 'w', 's', 'g', 1, 'owner', ?, 1, 0, 1)`).run(publicationHash);
    external.prepare(`INSERT INTO sync_relay_app_publication_blobs VALUES ('pub', 'w', ?)`).run(publicationHash);
    external.exec("COMMIT");
    return originalTx(run);
  });
  expect(await f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 }))
    .toEqual({ removed: 1, removedSha256s: [orphan] });
  for (const sha of [hash, proposalHash, publicationHash]) expect(f.storage.getBlob("w", sha)).not.toBeNull();
});

it("rolls back a failed delete transaction and rejects the GC result", async () => {
  const f = await fixture();
  f.put(hash);
  f.put(orphan);
  f.db.exec(`CREATE TRIGGER fail_second_delete BEFORE DELETE ON sync_relay_blobs
    WHEN OLD.sha256 = '${orphan}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  await expect(f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 })).rejects.toThrow("test failure");
  expect(f.storage.getBlob("w", hash)).not.toBeNull();
  expect(f.storage.getBlob("w", orphan)).not.toBeNull();
});

it("retains a late-page root and a reference committed between deletion chunks", async () => {
  const f = await fixture();
  const hashes = Array.from({ length: 205 }, (_, i) => i.toString(16).padStart(64, "0"));
  for (const sha of hashes) f.put(sha);
  f.put(hash);
  f.put(orphan);
  for (let index = 0; index < 96; index++) {
    append(f.db, JSON.stringify({ value: index === 95 ? hash : "no root" }), index);
  }
  const external = inspectDatabase(storagePath(f.storage), { foreignKeys: true });
  const context = f.storage as StorageContext;
  const originalTx = context.tx.bind(context);
  let transactions = 0;
  vi.spyOn(context, "tx").mockImplementation(run => {
    if (++transactions === 2) append(external, JSON.stringify({ value: orphan }), 96);
    return originalTx(run);
  });
  expect(await f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 }))
    .toEqual({ removed: hashes.length, removedSha256s: hashes });
  expect(transactions).toBe(2);
  expect(f.storage.getBlob("w", hash)).not.toBeNull();
  expect(f.storage.getBlob("w", orphan)).not.toBeNull();
});

it("finishes discovery while a writer appends a full page at each yield", async () => {
  const f = await fixture();
  f.put(hash);
  f.put(orphan);
  for (let index = 0; index < 32; index++) append(f.db, "{}", index);
  const external = inspectDatabase(storagePath(f.storage), { foreignKeys: true });
  let appendedPages = 0;
  let handle: NodeJS.Immediate;
  const appendPage = () => {
    if (appendedPages === 4) return;
    for (let index = 0; index < 32; index++) {
      append(external, JSON.stringify({ value: hash }), 32 + appendedPages * 32 + index);
    }
    appendedPages++;
    handle = setImmediate(appendPage);
  };
  handle = setImmediate(appendPage);
  try {
    expect(await f.storage.collectUnreferencedBlobs("w", { nowMs: 1_000 }))
      .toEqual({ removed: 1, removedSha256s: [orphan] });
    expect(appendedPages).toBe(1);
    expect(f.storage.getBlob("w", hash)).not.toBeNull();
  } finally {
    clearImmediate(handle);
  }
});

it("retains a late root across payload pieces using the locked bulk scan", async () => {
  const f = await fixture();
  const secondOrphan = "e".repeat(64);
  for (const sha of [hash, secondOrphan, orphan]) f.put(sha);
  const external = inspectDatabase(storagePath(f.storage), {foreignKeys: true});
  const context = f.storage as StorageContext;
  const originalTx = context.tx.bind(context);
  vi.spyOn(context, "tx").mockImplementationOnce(run => {
    append(external, JSON.stringify({value: "z".repeat(32_740) + hash.toUpperCase()}));
    return originalTx(run);
  });
  expect(await f.storage.collectUnreferencedBlobs("w", {nowMs: 1_000}))
    .toEqual({removed: 2, removedSha256s: [secondOrphan, orphan]});
  expect(f.storage.getBlob("w", hash)).not.toBeNull();
});

it("does not delete after a partial locked log scan fails", async () => {
  const f = await fixture();
  for (const sha of [hash, orphan]) f.put(sha);
  for (let index = 0; index < 96; index++) append(f.db, "{}", index);
  const context = f.storage as StorageContext;
  const originalTx = context.tx.bind(context);
  let inWriter = false;
  let reads = 0;
  vi.spyOn(context, "tx").mockImplementation(run => originalTx(() => {
    inWriter = true;
    try { return run(); } finally { inWriter = false; }
  }));
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (inWriter && sql.includes("substr(payload_json")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        if (++reads === 2) throw new Error("injected scan failure");
        return all(...args);
      });
    }
    return statement;
  });
  await expect(f.storage.collectUnreferencedBlobs("w", {nowMs: 1_000})).rejects.toThrow("injected scan failure");
  expect(reads).toBe(2);
  for (const sha of [hash, orphan]) expect(f.storage.getBlob("w", sha)).not.toBeNull();
});
