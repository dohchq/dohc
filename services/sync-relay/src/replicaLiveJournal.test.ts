import {afterEach, expect, it, vi} from "vitest";
import {registered, cleanupLiveDeliveryFixtures, hash} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import {createReplicaReadPrincipal} from "./replicaReadPrincipal";
import {createServiceHostReplication} from "./serviceHostReplication";
import {createSyncRelayHandler} from "./server";
import {drainOwnerOutbox} from "./ownerOutboxDelivery";
import * as journal from "./storage/liveUpdateJournal";
import type {StorageContext} from "./storage/context";
import type {LiveUpdateHostApplicationAck, LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";

afterEach(() => {vi.restoreAllMocks(); cleanupLiveDeliveryFixtures();});

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
      admission: {shares: new Map([["workspace", "share"]]), maxEntriesPerDrain: 1, maxBytesPerDrain: 10_000,
        validate: () => input.validation}, nextRequestId: () => ++requestId, deadlineMs: 30_000, assertCurrent() {},
      applyThrough: async value => {receipt = value; entered(); return pending;}});
    await Promise.race([applying, drain.then(() => {throw new Error("Drain returned before host application");})]);
    try {
      expect(acknowledged).toBe(false);
      expect(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_log").get()!.n).toBe(0);
      expect((await page(f)).rows).toMatchObject([{deliveryId: "pending-owner", journalCursor: receipt.journalCursor,
        updateBase64: Buffer.from(update).toString("base64")}]);
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
    expect(result.rows.map((row: {deliveryId: string}) => row.deliveryId)).toEqual(["first", "second"]);
    expect(result.rows.every((row: {document: {workspaceId: string}}) => row.document.workspaceId === "workspace")).toBe(true);
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
    const bytes = Buffer.byteLength(JSON.stringify({ok: true, ...first}));
    const bounded = await f.readStorage(0, 500, bytes);
    expect(bounded).toEqual(first);
    expect(Buffer.byteLength(JSON.stringify({ok: true, ...bounded}))).toBeLessThanOrEqual(bytes);
    await expect(f.readStorage(first.nextCursor, 500, bytes)).rejects.toThrow(/byte budget/);
    const following = await f.readStorage(first.nextCursor, 500);
    expect(following.rows.map(row => row.deliveryId)).toEqual(["b", "c"]);
    expect(following.hasMore).toBe(false);
    const empty = await f.readStorage(following.nextCursor);
    expect(empty).toMatchObject({rows: [], nextCursor: following.nextCursor, hasMore: false});
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
    expect(last).toMatchObject({rows: [{deliveryId: "bounded-500"}], nextCursor: 501, hasMore: false});
  } finally {f.close();}
}, 120_000);

it("keeps cursor paging stable when an append commits between pages", async () => {
  const f = fixture();
  try {
    f.append("a"); f.append("b");
    const first = await page(f, "?limit=1");
    f.append("c");
    const repeat = await page(f, "?limit=1");
    expect(repeat).toEqual(first);
    const second = await page(f, `?after=${first.nextCursor}&limit=1`);
    f.append("d");
    const last = await page(f, `?after=${second.nextCursor}&limit=2`);
    expect([...first.rows, ...second.rows, ...last.rows].map(row => row.deliveryId)).toEqual(["a", "b", "c", "d"]);
    expect(last.hasMore).toBe(false);
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
    expect(first).toMatchObject({rows: [{deliveryId: "a", authority: {restoreFenceGeneration: 1}}],
      nextCursor: receipt.journalCursor, hasMore: false});
    expect((await f.readStorage(first.nextCursor)).rows).toMatchObject([{deliveryId: "b", authority: {restoreFenceGeneration: 9}}]);
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

it("projects only update, scope, generation and dedupe evidence with current authority", async () => {
  const f = fixture();
  try {
    const {input, receipt} = f.append("private");
    const stored = f.raw.prepare("SELECT * FROM sync_relay_live_update_journal").get()!;
    expect(stored.author_snapshot_json).toContain("Private owner name");
    const result = await page(f);
    expect(result).toEqual({ok: true, rows: [{document: input.cutToken.document,
      restoreFenceGeneration: input.metadata.binding.restoreFenceGeneration, deliveryId: receipt.deliveryId,
      updateDigest: receipt.updateDigest, evidenceDigest: stored.accepted_evidence_digest,
      journalCursor: receipt.journalCursor, updateBase64: Buffer.from(input.updateBytes).toString("base64"),
      authority: {lineageClaimId: input.cutToken.document.lineageClaimId, baselineSequence: 1,
        restoreFenceGeneration: input.metadata.binding.restoreFenceGeneration}}], nextCursor: receipt.journalCursor, hasMore: false});
    const encoded = JSON.stringify(result);
    for (const secret of ["Private owner name", "authorSnapshot", "authorContext", "grantId", "principalId",
      "acceptingHostEpoch", "selectorPaths", "currentPath", f.lease.bearer]) expect(encoded).not.toContain(secret);
    f.write(db => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=9"));
    expect((await page(f)).rows[0]).toMatchObject({restoreFenceGeneration: 1, authority: {restoreFenceGeneration: 9}});
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
