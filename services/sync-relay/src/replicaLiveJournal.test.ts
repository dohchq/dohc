import * as Y from "yjs";
import {markdownToYDoc} from "../../../packages/ydoc-projection/src/import-export";
import {afterEach, expect, it, vi} from "vitest";
import {registered, cleanupLiveDeliveryFixtures, hash} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createServiceHostReplication} from "./serviceHostReplication";
import {createSyncRelayHandler} from "./server";
import {drainOwnerOutbox} from "./ownerOutboxDelivery";
import {initializeSyncRelaySchema} from "./storage/schema";
import {canonicalVersionedAcceptedMetadata} from "./liveAcceptedHistory";
import * as journal from "./storage/liveUpdateJournal";
import type {StorageContext} from "./storage/context";
import type {LiveUpdateHostApplicationAck, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";

afterEach(() => {vi.restoreAllMocks(); cleanupLiveDeliveryFixtures();});

// A cancellation control entry has no delivery; it is named by its cursor.
const deliveryId = (row: journal.ReplicaLiveJournalPage["rows"][number]) =>
  "cancellation" in row ? `cancellation-${row.journalCursor}` : row.admitted.metadata.accepted.receipt.deliveryId;
const delivery = (row: journal.ReplicaLiveJournalPage["rows"][number] | undefined): journal.ReplicaLiveJournalRow => {
  if (!row || "cancellation" in row) throw new Error("Expected a delivery row.");
  return row;
};

function spyCapture(context: StorageContext, onRow?: (row: Record<string, unknown>) => void) {
  const prepare = context.db.prepare.bind(context.db);
  const captured: string[] = [], provenanceThrough: number[] = [], proofQueries: string[] = [];
  vi.spyOn(context.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (/^SELECT \* FROM sync_relay_live_update_journal\s+WHERE workspace_id=\? AND journal_cursor>\? AND journal_cursor<=\?/.test(sql)) {
      const all = statement.all.bind(statement), iterate = statement.iterate.bind(statement);
      Object.assign(statement, {all: (...args: unknown[]) => {
        const rows = all(...args);
        for (const row of rows) {onRow?.(row); captured.push(String(row.delivery_id));}
        return rows;
      }, iterate: function* (...args: unknown[]) {
        for (const row of iterate(...args)) {onRow?.(row); captured.push(String(row.delivery_id)); yield row;}
      }});
    }
    if (/SELECT \* FROM sync_relay_live_update_struct_provenance/.test(sql)) {
      const all = statement.all.bind(statement);
      Object.assign(statement, {all: (...args: unknown[]) => {provenanceThrough.push(Number(args[2])); return all(...args);}});
    }
    if (/SELECT .*admission_json/.test(sql)) proofQueries.push(sql);
    return statement;
  });
  return {captured, provenanceThrough, proofQueries};
}

function fixture() {
  const f = registered({deployment: true});
  f.storage.claimWorkspaceIdentity({workspaceId: "workspace", replicationEpoch: "epoch", streamIdentity: "stream"});
  const principal = createReplicaReadPrincipal(f.storage);
  const lease = principal.issue("workspace", "test");
  const read = (query = "", options: RequestInit = {}) => principal.handle(new Request(
    `https://relay.test/sync/workspace/live-journal${query}`, {
      ...options, headers: {authorization: `Bearer ${lease.bearer}`, ...options.headers},
    }));
  const append = (id: string, value = id) => {
    const input = f.capture(f.update("title", value), id);
    const reply = f.storage.commitLiveUpdateJournal({...input,
      trustedAccount: {accountId: "owner", name: "Private owner name"},
      metadata: {...input.metadata, authorContext: {kind: "account", accountId: "owner"}},
    });
    expect(reply.result.kind).toBe("accepted");
    if (reply.result.kind !== "accepted") throw new Error("Expected accepted update");
    return {input, receipt: reply.result.receipt};
  };
  const snapshot = () => f.raw.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(row => [row.name, f.raw.prepare(`SELECT * FROM "${row.name}"`).all()]);
  const readStorage = (after = 0, limit = 500, maxBytes?: number) => journal.readReplicaLiveJournal(f.storage as StorageContext,
    {workspaceId: "workspace", after, limit, ...(maxBytes === undefined ? {} : {maxBytes})});
  return {...f, principal, lease, read, append, snapshot, readStorage};
}

async function page(f: ReturnType<typeof fixture>, query = "") {
  const response = await f.read(query);
  expect(response.status).toBe(200);
  return await response.json();
}

it("already exposes the applied admitted metadata and author snapshot through the replica log GET", async () => {
  const f = fixture();
  try {
    const {input, receipt} = f.append("applied-owner");
    const committed = f.storage.readCommittedLiveUpdate({host: input.host, document: input.cutToken.document, journalCursor: receipt.journalCursor});
    if (committed.kind !== "committed") throw new Error("Expected host-readable update");
    const metadata = canonicalVersionedAcceptedMetadata(committed.admitted.metadata);
    const row = f.journalRows().journal[0]!;
    const record = {kind: "application", relayDatabaseNamespace: row.relay_database_namespace,
      eventCount: row.accepted_event_count, evidenceDigest: row.accepted_evidence_digest, updateByteLength: input.updateBytes.byteLength,
      metadata, sourceApplication: null, sourceRestore: null, contentCoordinate: {originId: "device", originSeq: 0}};
    const bytes = Buffer.from(JSON.stringify(record)), digest = hash(bytes);
    f.storage.putBlob({workspaceId: "workspace", sha256: receipt.updateDigest, content: input.updateBytes, createdAtMs: 1});
    f.storage.putBlob({workspaceId: "workspace", sha256: digest, content: bytes, createdAtMs: 1});
    const ops = [{originSeq: 0, opKind: "ydoc.update", recordedAtMs: 1, payloadJson: JSON.stringify({versionId: "main",
      objectId: "object", path: metadata.accepted.binding.currentPath, lineageClaimId: metadata.accepted.binding.lineageClaimId,
      contentKind: "richdoc", updateBlobSha256: receipt.updateDigest})},
    {originSeq: 1, opKind: "live.audit.application", recordedAtMs: 1, payloadJson: JSON.stringify({
      relayDatabaseNamespace: record.relayDatabaseNamespace, mainVersionId: "main", objectId: "object",
      lineageClaimId: metadata.accepted.binding.lineageClaimId, eventCount: record.eventCount,
      manifest: {formatVersion: 1, recordDigest: digest, byteLength: bytes.byteLength, chunks: [{sha256: digest, byteLength: bytes.byteLength}]},
      updateBlobSha256: receipt.updateDigest})}];
    const append = {workspaceId: "workspace", originId: "device", ops};
    await f.storage.prepareLogAppend(append);
    f.storage.appendLogBatch(append);
    const response = await f.principal.handle(new Request("https://relay.test/sync/workspace/log?replicationEpoch=epoch&streamIdentity=stream", {
      headers: {authorization: `Bearer ${f.lease.bearer}`},
    }));
    expect(response.status).toBe(200);
    const log = await response.json();
    const audit = log.ops.find((op: {opKind: string}) => op.opKind === "live.audit.application");
    expect(audit.admittedAuthorSnapshot).toEqual(metadata.authorSnapshot);
    expect(metadata.authorSnapshot).toEqual([{kind: "human", humanId: "owner", humanName: "Private owner name"}]);
    const blob = await f.principal.handle(new Request(`https://relay.test/sync/workspace/blobs/${audit.payload.manifest.chunks[0].sha256}`, {
      headers: {authorization: `Bearer ${f.lease.bearer}`},
    }));
    expect(blob.status).toBe(200);
    expect((await blob.json()).metadata).toEqual(metadata);
  } finally {f.close();}
});

it("reads the committed owner update while applyThrough is pending", async () => {
  const f = fixture();
  try {
    const input = f.capture(f.update(), "pending-owner");
    const binding = input.metadata.binding;
    const update = input.updateBytes;
    const entry = {sequence: 1, appendKey: "later-work", deliveryId: input.metadata.deliveryId,
      updateDigest: hash(update), byteLength: update.byteLength, createdAtMs: 1};
    const cursor = (part: string) => ({snapshot: hash(Buffer.from("snapshot")), part,
      sequence: part === "header" || part === "base" ? 0 : 1, offset: 0});
    let entered!: () => void, release!: (ack: LiveUpdateHostApplicationAck) => void;
    const pending = new Promise<LiveUpdateHostApplicationAck>(resolve => {release = resolve;});
    const applying = new Promise<void>(resolve => {entered = resolve;});
    let receipt!: LiveUpdateReceipt;
    let acknowledged = false;
    const client = {sendRequest: vi.fn(async (request: {id: number; method: string; params: Record<string, unknown>}) => {
      if (request.method === "liveApplication.ownerOutbox") return {id: request.id,
        result: {outboxId: "outbox", pendingBytes: acknowledged ? 0 : update.byteLength, state: "active"}};
      if (request.method === "liveApplication.acknowledgeOwnerOutbox") {
        acknowledged = true;
        return {id: request.id, result: {acknowledged: 1, pendingBytes: 0, oldestEntryAtMs: null}};
      }
      const current = request.params.cursor as ReturnType<typeof cursor> | undefined ?? cursor("header");
      const bytes = current.part === "header" ? Buffer.from(JSON.stringify({outboxId: "outbox", binding,
        baseUpdateDigest: binding.lineageClaimId, baseByteLength: f.input.baselineBytes.byteLength,
        state: "active", pendingBytes: update.byteLength, pendingEntryCount: 1, nextSequence: 2,
        oldestEntryAtMs: 1, quarantineReason: null, observedBinding: null, firstEntryCursor: cursor("entryHeader")}))
        : current.part === "entryHeader" ? Buffer.from(JSON.stringify(entry)) : Buffer.from(update);
      return {id: request.id, result: {kind: "page", ...current, totalBytes: bytes.length, digest: hash(bytes),
        bytesBase64: bytes.toString("base64"), nextCursor: current.part === "header" ? cursor("base")
          : current.part === "entryHeader" ? cursor("update") : null}};
    })};
    let requestId = 0;
    const drain = drainOwnerOutbox({storage: f.storage, client: client as never, workspace: "handle", host: input.host,
      registrationId: 1, binding, adoption: {adoptionId: "adoption", sequence: 1, applied() {}},
      admission: {trustedAccount: accountId => ({accountId, name: "Owner name"}),
        shares: new Map([["workspace", "share"]]), maxEntriesPerDrain: 1, maxBytesPerDrain: 10_000,
        validate: () => input.validation}, nextRequestId: () => ++requestId, deadlineMs: 30_000, assertCurrent() {},
      applyThrough: async value => {receipt = value; entered(); return pending;}});
    await Promise.race([applying, drain.then(() => {throw new Error("Drain returned before host application");})]);
    try {
      expect(acknowledged).toBe(false);
      expect(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_log").get()!.n).toBe(0);
      expect((await page(f)).rows).toMatchObject([{journalCursor: receipt.journalCursor,
        admitted: {metadata: {accepted: {receipt: {deliveryId: "pending-owner"}}}, updateBytes: Buffer.from(update).toString("base64")}}]);
    } finally {
      release({...receipt, localYDocSequence: 1, applicationReplayed: false});
      await drain;
    }
  } finally {f.close();}
});

it("returns only the leased workspace even with interleaved journal cursors", async () => {
  const f = fixture();
  try {
    f.append("first");
    f.storage.claimWorkspace({workspaceId: "other", ownerUserId: "owner", createdAtMs: 1});
    f.write(db => {
      const original = db.prepare("SELECT * FROM sync_relay_live_update_journal LIMIT 1").get()!;
      const {journal_cursor: _cursor, ...row} = original;
      row.workspace_id = "other"; row.delivery_id = "other-delivery";
      db.prepare(`INSERT INTO sync_relay_live_update_journal (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
        .run(...Object.values(row));
    });
    f.append("second");
    const result = await page(f);
    expect(result.rows.map(deliveryId)).toEqual(["first", "second"]);
    expect(result.rows.every((row: journal.ReplicaLiveJournalRow) => row.admitted.metadata.accepted.binding.workspaceId === "workspace")).toBe(true);
    expect((await f.principal.handle(new Request("https://relay.test/sync/other/live-journal", {
      headers: {authorization: `Bearer ${f.lease.bearer}`},
    }))).status).toBe(404);
  } finally {f.close();}
});

it.each(["POST", "revoked share", "grant generation", "epoch", "stream", "owner", "non-replica", "external", "cookie", "replaced lease"])(
  "refuses %s after proving the live-journal route works", async reason => {
    const f = fixture();
    try {
      f.append("visible");
      expect((await page(f)).rows).toHaveLength(1);
      let request = new Request("https://relay.test/sync/workspace/live-journal", {headers: {authorization: `Bearer ${f.lease.bearer}`}});
      let handle = f.principal.handle;
      if (reason === "POST") request = new Request(request, {method: "POST"});
      if (reason === "cookie") request = new Request(request, {headers: {authorization: `Bearer ${f.lease.bearer}`, cookie: "session=owner"}});
      if (reason === "revoked share") f.storage.revokeShareGrant({shareId: "share", grantId: "grant", revokedAtMs: 40});
      if (reason === "grant generation") f.write(db => db.exec("UPDATE sync_relay_share_grants SET generation=generation+1"));
      if (reason === "epoch") f.write(db => db.exec("UPDATE sync_relay_workspaces SET replication_epoch='new'"));
      if (reason === "stream") f.write(db => db.exec("UPDATE sync_relay_workspaces SET stream_identity='new'"));
      if (reason === "owner") f.write(db => db.exec("UPDATE sync_relay_workspaces SET owner_user_id='new'"));
      if (reason === "replaced lease") f.principal.issue("workspace", "replacement");
      if (reason === "non-replica") handle = createServiceHostReplication({storage: f.storage,
        prefix: "dohc-service-v1.", authorize: () => "owner"});
      if (reason === "non-replica") request = new Request(request, {headers: {authorization: "Bearer dohc-service-v1.test"}});
      if (reason === "external") handle = createSyncRelayHandler({storage: f.storage, resolveActor: async (_request, workspaceId) => ({userId: "owner", workspaceId})});
      expect((await handle(request)).status).toBe(404);
    } finally {f.close();}
  });

it("changes no relay table on successful, empty or refused reads", async () => {
  const f = fixture();
  try {
    const {receipt} = f.append("read-only");
    const before = f.snapshot();
    expect((await page(f)).rows).toHaveLength(1);
    expect((await page(f, `?after=${receipt.journalCursor}`)).rows).toEqual([]);
    expect((await f.read("", {method: "POST"})).status).toBe(404);
    expect(f.snapshot()).toEqual(before);
  } finally {f.close();}
});

it("bounds rows and complete response bytes without skipping the next row", async () => {
  const f = fixture();
  try {
    f.append("a"); f.append("b", "x".repeat(3000)); f.append("c");
    const first = await f.readStorage(0, 1);
    expect(first.rows).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify({ok: true, ...first, hasMore: false}));
    const bounded = await f.readStorage(0, 500, bytes);
    expect(bounded).toEqual(first);
    expect(Buffer.byteLength(JSON.stringify({ok: true, ...bounded}))).toBeLessThanOrEqual(bytes);
    // A row larger than the budget is served alone, so no admitted row can stall the replica.
    const alone = await f.readStorage(first.nextCursor, 500, bytes);
    expect(alone.rows.map(deliveryId)).toEqual(["b"]);
    expect(alone.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ok: true, ...alone}))).toBeGreaterThan(bytes);
    const following = await f.readStorage(first.nextCursor, 500);
    expect(following.rows.map(deliveryId)).toEqual(["b", "c"]);
    expect(following.hasMore).toBe(false);
    const empty = await f.readStorage(following.nextCursor);
    expect(empty).toMatchObject({rows: [], nextCursor: following.nextCursor, hasMore: false});
  } finally {f.close();}
});

it("prices metadata while capturing rows and loads at most one unserved row", async () => {
  const f = fixture();
  try {
    f.append("a"); f.append("b"); f.append("c");
    const first = await f.readStorage(0, 1);
    const bytes = Buffer.byteLength(JSON.stringify({ok: true, ...first, hasMore: false}));
    const capture = spyCapture(f.storage as StorageContext);
    const page = await f.readStorage(0, 500, bytes);
    expect(page.rows.map(deliveryId)).toEqual(["a"]);
    expect(capture.captured).toEqual(["a", "b"]);
    expect(capture.provenanceThrough).toEqual([first.nextCursor]);
  } finally {f.close();}
});

it("counts metadata stored beside the accepted record while capturing rows", async () => {
  const f = fixture();
  try {
    f.append("a"); f.append("b"); f.append("c");
    const first = await f.readStorage(0, 1);
    const bytes = Buffer.byteLength(JSON.stringify({ok: true, ...first, hasMore: false}));
    // Only the deleted-ranges column is heavy; the page must stop before retaining that row.
    const deletes = JSON.stringify(Array.from({length: 2000}, (_, index) => ({clientId: 1, startClock: 2 * index, endClock: 2 * index + 1})));
    f.write(db => db.prepare("UPDATE sync_relay_live_update_journal SET first_seen_deletes_json=? WHERE delivery_id='b'").run(deletes));
    const capture = spyCapture(f.storage as StorageContext);
    const page = await f.readStorage(0, 500, bytes * 2);
    expect(page.rows.map(deliveryId)).toEqual(["a"]);
    expect(page.hasMore).toBe(true);
    expect(capture.captured).toEqual(["a", "b"]);
    expect(capture.provenanceThrough).toEqual([first.nextCursor]);
  } finally {f.close();}
});


it("stops capture before a non-first restore checkpoint exceeds the response cap", async () => {
  const f = fixture();
  try {
    f.append("a"); f.append("b"); f.append("c");
    const first = await f.readStorage(0, 1);
    const bytes = Buffer.byteLength(JSON.stringify({ok: true, ...first, hasMore: false}));
    // A proof or decode of this excluded row would fail. Its checkpoint must stop capture first.
    const capture = spyCapture(f.storage as StorageContext, raw => {
      if (raw.delivery_id === "b") {
        raw.validation_checkpoint_bytes = new Uint8Array(1024 * 1024);
        raw.restore_operation_id = "excluded-restore";
      }
    });
    const result = await f.readStorage(0, 500, bytes * 4);
    expect(result.rows.map(deliveryId)).toEqual(["a"]);
    expect(result.hasMore).toBe(true);
    expect(capture.captured).toEqual(["a", "b"]);
    expect(capture.provenanceThrough).toEqual([first.nextCursor]);
    expect(capture.proofQueries).toEqual([]);
  } finally {f.close();}
});

it("keeps the header query before the blob overflow chains", async () => {
  const f = fixture();
  try {
    f.append("a");
    const columns = f.raw.prepare("PRAGMA table_info(sync_relay_live_update_journal)").all().map(row => String(row.name));
    const forbidden = columns.slice(columns.indexOf("update_bytes") + 1);
    const context = f.storage as StorageContext, prepare = context.db.prepare.bind(context.db), headers: string[] = [];
    vi.spyOn(context.db, "prepare").mockImplementation(sql => {
      if (/SELECT journal_cursor,workspace_id/.test(sql)) headers.push(sql);
      return prepare(sql);
    });
    await f.readStorage();
    expect(headers).toHaveLength(1);
    // Blob lengths come from the record header; any other read of a later column walks the overflow pages.
    const withoutLengths = headers[0]!.replace(/length\((update_bytes|validation_checkpoint_bytes)\)/g, "");
    for (const column of forbidden) expect(withoutLengths).not.toMatch(new RegExp("\\b" + column + "\\b"));
    expect(headers[0]).toContain("length(update_bytes)");
    expect(headers[0]).toContain("length(validation_checkpoint_bytes)");
  } finally {f.close();}
});

it("yields before decoding a heavy metadata row and stops after the guard revokes", async () => {
  const f = fixture();
  try {
    f.append("a"); f.append("b");
    f.write(db => db.prepare("UPDATE sync_relay_live_update_journal SET author_snapshot_json=? WHERE delivery_id='b'")
      .run(JSON.stringify({damaged: "x".repeat(1024 * 1024)})));
    const guard = vi.fn(() => {if (guard.mock.calls.length === 3) throw new Error("revoked before metadata decode");});
    await expect(journal.readReplicaLiveJournal(f.storage as StorageContext,
      {workspaceId: "workspace", after: 0, limit: 500, guard})).rejects.toThrow("revoked before metadata decode");
    expect(guard).toHaveBeenCalledTimes(3);
  } finally {f.close();}
});

it("stops capture before a row the exact response budget would drop", async () => {
  const f = fixture();
  try {
    f.append("a"); f.append("b");
    const first = await f.readStorage(0, 1), second = await f.readStorage(first.nextCursor, 1);
    const bytes = Buffer.byteLength(JSON.stringify({ok: true, rows: [...first.rows, ...second.rows],
      nextCursor: second.nextCursor, hasMore: false})) - 1;
    const damaged = Uint8Array.from(f.raw.prepare("SELECT update_bytes FROM sync_relay_live_update_journal WHERE delivery_id='b'").get()!.update_bytes as Uint8Array);
    damaged[0] = damaged[0]! ^ 1;
    f.write(db => db.prepare("UPDATE sync_relay_live_update_journal SET update_bytes=? WHERE delivery_id='b'").run(damaged));
    const capture = spyCapture(f.storage as StorageContext);
    const result = await f.readStorage(0, 500, bytes);
    expect(result.rows.map(deliveryId)).toEqual(["a"]);
    expect(result.hasMore).toBe(true);
    expect(capture.provenanceThrough).toEqual([first.nextCursor]);
  } finally {f.close();}
});

it("caps an oversized route limit at 500 rows and resumes at the unserved row", async () => {
  const f = fixture();
  try {
    const update = f.update("title", "Repeated accepted update");
    for (let index = 0; index < 501; index++) {
      expect(f.storage.commitLiveUpdateJournal(f.capture(update, `bounded-${index}`)).result.kind).toBe("accepted");
    }
    const first = await page(f, "?limit=1000");
    expect(first.rows).toHaveLength(500);
    expect(first).toMatchObject({nextCursor: 500, hasMore: true});
    const last = await page(f, `?after=${first.nextCursor}&limit=1000`);
    expect(last.rows.map(deliveryId)).toEqual(["bounded-500"]);
    expect(last).toMatchObject({nextCursor: 501, hasMore: false});
  } finally {f.close();}
}, 120_000);

it("keeps cursor paging stable when appends commit during verification and encoding", async () => {
  const f = fixture();
  try {
    f.append("a"); f.append("b");
    const readingFirst = page(f, "?limit=1");
    f.append("c");
    const first = await readingFirst;
    const repeat = await page(f, "?limit=1");
    expect(repeat).toEqual(first);
    const readingSecond = page(f, `?after=${first.nextCursor}&limit=1`);
    f.append("d");
    const second = await readingSecond;
    const last = await page(f, `?after=${second.nextCursor}&limit=2`);
    expect([...first.rows, ...second.rows, ...last.rows].map(deliveryId)).toEqual(["a", "b", "c", "d"]);
    expect(last.hasMore).toBe(false);
  } finally {f.close();}
});

it("uses cursor range searches without workspace scans or sorts for all page queries", async () => {
  const f = fixture();
  try {
    f.append("a"); f.append("b");
    const context = f.storage as StorageContext;
    const prepare = context.db.prepare.bind(context.db);
    const plans: string[] = [];
    vi.spyOn(context.db, "prepare").mockImplementation(sql => {
      if (/FROM sync_relay_live_update_(journal|struct_provenance)\s+WHERE [\s\S]*journal_cursor>\?/.test(sql)) {
        plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all("workspace", 1, 2).map(row => row.detail).join("; "));
      }
      return prepare(sql);
    });
    await f.readStorage(1, 1);
    expect(plans).toHaveLength(3);
    for (const plan of plans) {
      expect(plan).not.toMatch(/SCAN |TEMP B-TREE/);
      expect(plan).toMatch(/SEARCH .*journal_cursor>\?/);
    }
    expect(plans[0]).toContain("idx_sync_relay_live_update_journal_workspace");
    expect(plans[1]).toContain("idx_sync_relay_live_update_journal_workspace");
    expect(plans[2]).toContain("idx_sync_relay_live_update_struct_provenance_journal");
  } finally {f.close();}
});

it("migrates an existing journal to the workspace cursor index and validates it on reopen", () => {
  const f = fixture();
  try {
    f.append("existing");
    f.write(db => {
      db.exec("DROP INDEX IF EXISTS idx_sync_relay_live_update_journal_workspace");
      db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run("live-update-journal-workspace-index-v1");
      initializeSyncRelaySchema(db);
      initializeSyncRelaySchema(db);
    });
    expect(f.raw.prepare("PRAGMA index_info(idx_sync_relay_live_update_journal_workspace)").all().map(row => row.name))
      .toEqual(["workspace_id", "journal_cursor"]);
    expect(f.raw.prepare("SELECT delivery_id FROM sync_relay_live_update_journal").all()).toEqual([{delivery_id: "existing"}]);
    expect(() => f.write(db => {
      db.exec("DROP INDEX idx_sync_relay_live_update_journal_workspace");
      initializeSyncRelaySchema(db);
    })).toThrow("live journal workspace index is missing or damaged");
  } finally {f.close();}
});

it("yields within a large row and stops hashing after the guard revokes", async () => {
  const f = fixture();
  try {
    const {input} = f.append("large", "x".repeat(1024 * 1024));
    const guard = vi.fn(() => {
      if (guard.mock.calls.length === 3) throw new Error("revoked during hashing");
    });
    let failure: unknown;
    try {await journal.readReplicaLiveJournal(f.storage as StorageContext, {workspaceId: "workspace", after: 0, limit: 1, guard});}
    catch (error) {failure = error;}
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("revoked during hashing");
    expect(guard).toHaveBeenCalledTimes(3);
    expect(Buffer.from(delivery((await f.readStorage()).rows[0]).admitted.updateBytes, "base64")).toEqual(Buffer.from(input.updateBytes));
  } finally {f.close();}
});

it("stops verification before decoding a captured damaged row when the lease is revoked at a yield", async () => {
  const f = fixture();
  try {
    f.append("a");
    f.write(db => db.exec("UPDATE sync_relay_live_update_journal SET author_snapshot_json='{}'"));
    const reading = f.read();
    f.storage.revokeShareGrant({shareId: "share", grantId: "grant", revokedAtMs: 40});
    // Decoding the captured damaged row would produce a 500 instead of this 404.
    expect((await reading).status).toBe(404);
  } finally {f.close();}
});

it("captures authority and rows before a concurrent append while verification yields", async () => {
  const f = fixture();
  try {
    const {receipt} = f.append("a");
    const reading = f.readStorage();
    f.append("b");
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=9"));
    const first = await reading;
    expect(first).toMatchObject({rows: [{admitted: {metadata: {accepted: {receipt: {deliveryId: "a"}}}}, authority: {restoreFenceGeneration: 1}}],
      nextCursor: receipt.journalCursor, hasMore: false});
    expect((await f.readStorage(first.nextCursor)).rows).toMatchObject([{admitted: {metadata: {accepted: {receipt: {deliveryId: "b"}}}}, authority: {restoreFenceGeneration: 9}}]);
  } finally {f.close();}
});

it("rechecks the lease after a read yields and refuses a revoked share", async () => {
  const f = fixture();
  try {
    f.append("a"); await page(f);
    const reading = f.read();
    f.storage.revokeShareGrant({shareId: "share", grantId: "grant", revokedAtMs: 40});
    expect((await reading).status).toBe(404);
  } finally {f.close();}
});

it("returns exactly the host's committed admitted value and history namespace with current authority", async () => {
  const f = fixture();
  try {
    const {input, receipt} = f.append("private");
    const stored = f.raw.prepare("SELECT * FROM sync_relay_live_update_journal").get()!;
    expect(stored.author_snapshot_json).toContain("Private owner name");
    const result = await page(f);
    const committed = f.storage.readCommittedLiveUpdate({host: input.host, document: input.cutToken.document, journalCursor: receipt.journalCursor});
    if (committed.kind !== "committed") throw new Error("Expected host-readable update");
    expect(result).toEqual({ok: true, rows: [{admitted: {metadata: committed.admitted.metadata, updateBytes: Buffer.from(committed.admitted.updateBytes).toString("base64")},
      relayDatabaseNamespace: stored.relay_database_namespace, evidenceDigest: stored.accepted_evidence_digest,
      journalCursor: receipt.journalCursor, restore: null,
      authority: {lineageClaimId: input.cutToken.document.lineageClaimId, baselineSequence: 1,
        restoreFenceGeneration: input.metadata.binding.restoreFenceGeneration}}], nextCursor: receipt.journalCursor, hasMore: false});
    const encoded = JSON.stringify(result);
    for (const secret of ["authorContext", "hostCoordinate", "connectionId", "instanceId", "cookie", "bearer", f.lease.bearer]) expect(encoded).not.toContain(secret);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=9"));
    expect((await page(f)).rows[0]).toMatchObject({admitted: {metadata: {accepted: {binding: {restoreFenceGeneration: 1}}}}, authority: {restoreFenceGeneration: 9}});
  } finally {f.close();}
});

it("returns null current authority for a retired document and the replacement lineage when present", async () => {
  const f = fixture();
  try {
    f.append("old");
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET lineage_state='retired', admission_state='closed', retired_at_ms=40"));
    expect((await page(f)).rows[0].authority).toBeNull();
    const lineage = "f".repeat(64);
    f.write(db => db.exec(`INSERT INTO sync_relay_live_documents SELECT workspace_id,main_version_id,object_id,'${lineage}',
      lineage_claim_id,current_path,baseline_moment_relay_seq+10,baseline_projected_sha256,baseline_projected_byte_length,
      '${lineage}',baseline_bytes,'current','open',2,50,NULL FROM sync_relay_live_documents`));
    expect((await page(f)).rows[0].authority).toEqual({lineageClaimId: lineage, baselineSequence: 11, restoreFenceGeneration: 2});
  } finally {f.close();}
});

it.each(["after=-1", "after=9007199254740992", "after=1.2", "after=1e3", "after=1&after=2", "limit=0", "limit=-2", "limit=1.5", "limit=9007199254740992"])(
  "refuses invalid page input %s", async query => {
    const f = fixture();
    try {await page(f); expect((await f.read(`?${query}`)).status).toBe(400);}
    finally {f.close();}
  });

it("refuses an aborted read and relay storage that closes during verification", async () => {
  const f = fixture();
  let closed = false;
  try {
    f.append("a"); await page(f);
    const abort = new AbortController();
    const aborted = journal.readReplicaLiveJournal(f.storage as StorageContext,
      {workspaceId: "workspace", after: 0, limit: 1, signal: abort.signal});
    abort.abort();
    await expect(aborted).rejects.toThrow();
    const reading = f.readStorage();
    f.close(); closed = true;
    await expect(reading).rejects.toThrow(/unavailable/);
  } finally {if (!closed) f.close();}
});

it.each(["update_digest", "accepted_evidence_digest", "author_snapshot_json"])("refuses a damaged stored %s", async column => {
  const f = fixture();
  try {
    f.append("damaged"); await page(f);
    f.write(db => db.prepare(`UPDATE sync_relay_live_update_journal SET ${column}=?`).run(column === "author_snapshot_json" ? "{}" : "f".repeat(64)));
    await expect(f.readStorage()).rejects.toThrow();
  } finally {f.close();}
});

it("serves the maximum admitted update with many ranges and an author snapshot in one page", async () => {
  const maximum = 20 * 1024 * 1024;
  const baseline = markdownToYDoc("Hello");
  baseline.transact(() => {
    for (let index = 0; index < 4000; index++) {
      baseline.clientID = 4_000_000_000 + index;
      baseline.getMap("frontmatter").set("key-" + index, "x");
    }
  });
  const baselineBytes = Y.encodeStateAsUpdate(baseline);
  baseline.destroy();
  const f = registered({deployment: true, baselineBytes, workspaceQuotaBytes: 2 * 1024 ** 3});
  const context = {kind: "account" as const, accountId: "owner", agent: {agentId: "agent"}};
  const commit = (bytes: Uint8Array, id: string) => {
    const input = f.capture(bytes, id);
    expect(input.validation.kind).toBe("accepted");
    const result = f.storage.commitLiveUpdateJournal({...input, trustedAccount: {accountId: "owner", name: "Owner"},
      metadata: {...input.metadata, authorContext: context}});
    expect(result.result.kind).toBe("accepted");
    if (!result.admitted) throw new Error("Expected committed update");
    return {input, admitted: result.admitted};
  };
  try {
    // Keep historical payloads so the full update and retained state share the same byte bound.
    f.doc.gc = false;
    for (let index = 0; index < 16; index++) {
      f.doc.clientID = 3_000_000_000 + index;
      commit(f.update("title", String(index)), "bind-" + index);
    }
    const doc = new Y.Doc({gc: false});
    let bytes!: Uint8Array;
    try {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(f.doc));
      doc.transact(() => {
        for (let index = 0; index < 16; index++) {
          doc.clientID = 3_000_000_000 + index;
          doc.getMap("frontmatter").set("new-" + index, "x");
        }
        for (const key of doc.getMap("frontmatter").keys()) doc.getMap("frontmatter").delete(key);
      });
      let payloadLength = maximum - Y.encodeStateAsUpdate(doc).byteLength - 100;
      for (let attempt = 0; attempt < 4; attempt++) {
        const candidate = new Y.Doc({gc: false});
        try {
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
          candidate.clientID = doc.clientID;
          candidate.getMap("frontmatter").set("temporary", "x".repeat(payloadLength));
          candidate.getMap("frontmatter").delete("temporary");
          bytes = Y.encodeStateAsUpdate(candidate);
        } finally {candidate.destroy();}
        if (bytes.byteLength === maximum) break;
        payloadLength += maximum - bytes.byteLength;
      }
    } finally {doc.destroy();}
    expect(bytes.byteLength).toBe(maximum);
    const {input, admitted} = commit(bytes, "maximum");
    expect(() => f.storage.commitLiveUpdateJournal({...input, updateBytes: new Uint8Array(maximum + 1)})).toThrow("Invalid journal bytes");
    expect(admitted.metadata.firstSeen).toHaveLength(16);
    expect(admitted.metadata.firstSeenDeletes).toHaveLength(4016);
    expect(admitted.metadata.authorSnapshot).toEqual([{kind: "human", humanId: "owner", humanName: "Owner"},
      {kind: "agent", agentId: "agent", onBehalfOf: "owner"}]);
    expect(Buffer.byteLength(JSON.stringify(admitted.metadata))).toBeGreaterThan(600_000);
    const cursor = admitted.metadata.accepted.receipt.journalCursor;
    const result = await journal.readReplicaLiveJournal(f.storage as StorageContext, {workspaceId: "workspace", after: cursor - 1, limit: 1});
    expect(result).toMatchObject({rows: [{admitted: {metadata: admitted.metadata, updateBytes: Buffer.from(bytes).toString("base64")}}],
      nextCursor: cursor, hasMore: false});
    expect(result.rows).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify({ok: true, ...result}))).toBeLessThanOrEqual(journal.REPLICA_LIVE_JOURNAL_MAX_BYTES);
  } finally {f.close();}
}, 120_000);
