import { afterEach, expect, it, vi } from "vitest";
import {
  registered,
  cleanupLiveDeliveryFixtures,
  hash,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import { createReplicaReadPrincipal } from "./replicaReadPrincipal";

import { drainOwnerOutbox } from "./ownerOutboxDelivery";
import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import { initializeSyncRelaySchema } from "./storage/schema";

import * as journal from "./storage/liveUpdateJournal";
import type { StorageContext } from "./storage/context";
import type {
  LiveUpdateHostApplicationAck,
  LiveUpdateReceipt,
} from "@dohc/live-session-contract/live-update-admission";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupLiveDeliveryFixtures();
});

// A cancellation control entry has no delivery; it is named by its cursor.
const deliveryId = (row: journal.ReplicaLiveJournalPage["rows"][number]) =>
  "cancellation" in row
    ? `cancellation-${row.journalCursor}`
    : row.admitted.metadata.accepted.receipt.deliveryId;

function fixture() {
  const f = registered({ deployment: true });
  f.storage.claimWorkspaceIdentity({
    workspaceId: "workspace",
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  const principal = createReplicaReadPrincipal(f.storage);
  const lease = principal.issue("workspace", "test");
  const read = (query = "", options: RequestInit = {}) =>
    principal.handle(
      new Request(`https://relay.test/sync/workspace/live-journal${query}`, {
        ...options,
        headers: { authorization: `Bearer ${lease.bearer}`, ...options.headers },
      }),
    );
  const append = (id: string, value = id) => {
    const input = f.capture(f.update("title", value), id);
    const reply = f.storage.commitLiveUpdateJournal({
      ...input,
      trustedAccount: { accountId: "owner", name: "Private owner name" },
      metadata: { ...input.metadata, authorContext: { kind: "account", accountId: "owner" } },
    });
    expect(reply.result.kind).toBe("accepted");
    if (reply.result.kind !== "accepted") throw new Error("Expected accepted update");
    return { input, receipt: reply.result.receipt };
  };
  const snapshot = () =>
    f.raw
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all()
      .map((row) => [row.name, f.raw.prepare(`SELECT * FROM "${row.name}"`).all()]);
  const readStorage = (after = 0, limit = 500, maxBytes?: number) =>
    journal.readReplicaLiveJournal(f.storage as StorageContext, {
      workspaceId: "workspace",
      after,
      limit,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
  return { ...f, principal, lease, read, append, snapshot, readStorage };
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
    const entry = {
      sequence: 1,
      appendKey: "later-work",
      deliveryId: input.metadata.deliveryId,
      updateDigest: hash(update),
      byteLength: update.byteLength,
      createdAtMs: 1,
    };
    const cursor = (part: string) => ({
      snapshot: hash(Buffer.from("snapshot")),
      part,
      sequence: part === "header" || part === "base" ? 0 : 1,
      offset: 0,
    });
    let entered!: () => void, release!: (ack: LiveUpdateHostApplicationAck) => void;
    const pending = new Promise<LiveUpdateHostApplicationAck>((resolve) => {
      release = resolve;
    });
    const applying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let receipt!: LiveUpdateReceipt;
    let acknowledged = false;
    const client = {
      sendRequest: vi.fn(
        async (request: { id: number; method: string; params: Record<string, unknown> }) => {
          if (request.method === "liveApplication.ownerOutbox")
            return {
              id: request.id,
              result: {
                outboxId: "outbox",
                pendingBytes: acknowledged ? 0 : update.byteLength,
                state: "active",
                retryDeliveryId: null,
              },
            };
          if (request.method === "liveApplication.acknowledgeOwnerOutbox") {
            acknowledged = true;
            return {
              id: request.id,
              result: { acknowledged: 1, pendingBytes: 0, oldestEntryAtMs: null },
            };
          }
          const current =
            (request.params.cursor as ReturnType<typeof cursor> | undefined) ?? cursor("header");
          const bytes =
            current.part === "header"
              ? Buffer.from(
                  JSON.stringify({
                    outboxId: "outbox",
                    binding,
                    baseUpdateDigest: binding.lineageClaimId,
                    baseByteLength: f.input.baselineBytes.byteLength,
                    state: "active",
                    pendingBytes: update.byteLength,
                    pendingEntryCount: 1,
                    nextSequence: 2,
                    oldestEntryAtMs: 1,
                    quarantineReason: null,
                    observedBinding: null,
                    retryDeliveryId: null,
                    firstEntryCursor: cursor("entryHeader"),
                    frozenAtRefusedSeed: false,
                    checkpointDigest: null,
                    recoveryCheckpointDigest: null,
                  }),
                )
              : current.part === "entryHeader"
                ? Buffer.from(JSON.stringify(entry))
                : Buffer.from(update);
          return {
            id: request.id,
            result: {
              kind: "page",
              ...current,
              totalBytes: bytes.length,
              digest: hash(bytes),
              bytesBase64: bytes.toString("base64"),
              nextCursor:
                current.part === "header"
                  ? cursor("base")
                  : current.part === "entryHeader"
                    ? cursor("update")
                    : null,
            },
          };
        },
      ),
    };
    let requestId = 0;
    const drain = drainOwnerOutbox({
      storage: f.storage,
      client: client as never,
      workspace: "handle",
      host: input.host,
      registrationId: 1,
      binding,
      adoption: { adoptionId: "adoption", sequence: 1, applied() {} },
      admission: {
        trustedAccount: (accountId) => ({ accountId, name: "Owner name" }),
        workspaceIds: new Set(["workspace"]),
        maxEntriesPerDrain: 1,
        maxBytesPerDrain: 10_000,
        refusals: new OwnerKnownRefusals(),
        validate: () => input.validation,
      },
      nextRequestId: () => ++requestId,
      deadlineMs: 30_000,
      assertCurrent() {},
      applyThrough: async (value) => {
        receipt = value;
        entered();
        return pending;
      },
    });
    await Promise.race([
      applying,
      drain.then(() => {
        throw new Error("Drain returned before host application");
      }),
    ]);
    try {
      expect(acknowledged).toBe(false);
      expect(f.raw.prepare("SELECT count(*) AS n FROM sync_relay_log").get()!.n).toBe(0);
      expect((await page(f)).rows).toMatchObject([
        {
          journalCursor: receipt.journalCursor,
          admitted: {
            metadata: { accepted: { receipt: { deliveryId: "pending-owner" } } },
            updateBytes: Buffer.from(update).toString("base64"),
          },
        },
      ]);
    } finally {
      release({ ...receipt, localYDocSequence: 1, applicationReplayed: false });
      await drain;
    }
  } finally {
    f.close();
  }
});

it("returns only the leased workspace even with interleaved journal cursors", async () => {
  const f = fixture();
  try {
    f.append("first");
    f.storage.claimWorkspace({ workspaceId: "other", ownerUserId: "owner", createdAtMs: 1 });
    f.write((db) => {
      const original = db.prepare("SELECT * FROM sync_relay_live_update_journal LIMIT 1").get()!;
      const { journal_cursor: _cursor, ...row } = original;
      row.workspace_id = "other";
      row.delivery_id = "other-delivery";
      db.prepare(
        `INSERT INTO sync_relay_live_update_journal (${Object.keys(row).join(",")}) VALUES (${Object.keys(
          row,
        )
          .map(() => "?")
          .join(",")})`,
      ).run(...Object.values(row));
    });
    f.append("second");
    const result = await page(f);
    expect(result.rows.map(deliveryId)).toEqual(["first", "second"]);
    expect(
      result.rows.every(
        (row: journal.ReplicaLiveJournalRow) =>
          row.admitted.metadata.accepted.binding.workspaceId === "workspace",
      ),
    ).toBe(true);
    expect(
      (
        await f.principal.handle(
          new Request("https://relay.test/sync/other/live-journal", {
            headers: { authorization: `Bearer ${f.lease.bearer}` },
          }),
        )
      ).status,
    ).toBe(404);
  } finally {
    f.close();
  }
});

it("bounds rows and complete response bytes without skipping the next row", async () => {
  const f = fixture();
  try {
    f.append("a");
    f.append("b", "x".repeat(3000));
    f.append("c");
    const first = await f.readStorage(0, 1);
    expect(first.rows).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify({ ok: true, ...first, hasMore: false }));
    const bounded = await f.readStorage(0, 500, bytes);
    expect(bounded).toEqual(first);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, ...bounded }))).toBeLessThanOrEqual(bytes);
    // A row larger than the budget is served alone, so no admitted row can stall the replica.
    const alone = await f.readStorage(first.nextCursor, 500, bytes);
    expect(alone.rows.map(deliveryId)).toEqual(["b"]);
    expect(alone.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ ok: true, ...alone }))).toBeGreaterThan(bytes);
    const following = await f.readStorage(first.nextCursor, 500);
    expect(following.rows.map(deliveryId)).toEqual(["b", "c"]);
    expect(following.hasMore).toBe(false);
    const empty = await f.readStorage(following.nextCursor);
    expect(empty).toMatchObject({ rows: [], nextCursor: following.nextCursor, hasMore: false });
  } finally {
    f.close();
  }
});

it("migrates an existing journal to the workspace cursor index and validates it on reopen", () => {
  const f = fixture();
  try {
    f.append("existing");
    f.write((db) => {
      db.exec("DROP INDEX IF EXISTS idx_sync_relay_live_update_journal_workspace");
      db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(
        "live-update-journal-workspace-index-v1",
      );
      initializeSyncRelaySchema(db);
      initializeSyncRelaySchema(db);
    });
    expect(
      f.raw
        .prepare("PRAGMA index_info(idx_sync_relay_live_update_journal_workspace)")
        .all()
        .map((row) => row.name),
    ).toEqual(["workspace_id", "journal_cursor"]);
    expect(f.raw.prepare("SELECT delivery_id FROM sync_relay_live_update_journal").all()).toEqual([
      { delivery_id: "existing" },
    ]);
    expect(() =>
      f.write((db) => {
        db.exec("DROP INDEX idx_sync_relay_live_update_journal_workspace");
        initializeSyncRelaySchema(db);
      }),
    ).toThrow("live journal workspace index is missing or damaged");
  } finally {
    f.close();
  }
});

it("stops verification before decoding a captured damaged row when the lease is revoked at a yield", async () => {
  const f = fixture();
  try {
    f.append("a");
    f.write((db) => db.exec("UPDATE sync_relay_live_update_journal SET author_snapshot_json='{}'"));
    const reading = f.read();
    f.storage.revokeShareGrant({ shareId: "share", grantId: "grant", revokedAtMs: 40 });
    // Decoding the captured damaged row would produce a 500 instead of this 404.
    expect((await reading).status).toBe(404);
  } finally {
    f.close();
  }
});

it("returns exactly the host's committed admitted value and history namespace with current authority", async () => {
  const f = fixture();
  try {
    const { input, receipt } = f.append("private");
    const stored = f.raw.prepare("SELECT * FROM sync_relay_live_update_journal").get()!;
    expect(stored.author_snapshot_json).toContain("Private owner name");
    const result = await page(f);
    const committed = f.storage.readCommittedLiveUpdate({
      host: input.host,
      document: input.cutToken.document,
      journalCursor: receipt.journalCursor,
    });
    if (committed.kind !== "committed") throw new Error("Expected host-readable update");
    expect(result).toEqual({
      ok: true,
      rows: [
        {
          admitted: {
            metadata: committed.admitted.metadata,
            updateBytes: Buffer.from(committed.admitted.updateBytes).toString("base64"),
          },
          relayDatabaseNamespace: stored.relay_database_namespace,
          evidenceDigest: stored.accepted_evidence_digest,
          journalCursor: receipt.journalCursor,
          restore: null,
          authority: {
            lineageClaimId: input.cutToken.document.lineageClaimId,
            baselineSequence: 1,
            restoreFenceGeneration: input.metadata.binding.restoreFenceGeneration,
          },
        },
      ],
      nextCursor: receipt.journalCursor,
      hasMore: false,
    });
    const encoded = JSON.stringify(result);
    for (const secret of [
      "authorContext",
      "hostCoordinate",
      "connectionId",
      "instanceId",
      "cookie",
      "bearer",
      f.lease.bearer,
    ])
      expect(encoded).not.toContain(secret);
    f.write((db) => db.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=9"));
    expect((await page(f)).rows[0]).toMatchObject({
      admitted: { metadata: { accepted: { binding: { restoreFenceGeneration: 1 } } } },
      authority: { restoreFenceGeneration: 9 },
    });
  } finally {
    f.close();
  }
});

it("returns null current authority for a retired document and the replacement lineage when present", async () => {
  const f = fixture();
  try {
    f.append("old");
    f.write((db) =>
      db.exec(
        "UPDATE sync_relay_live_documents SET lineage_state='retired', admission_state='closed', retired_at_ms=40",
      ),
    );
    expect((await page(f)).rows[0].authority).toBeNull();
    const lineage = "f".repeat(64);
    f.write((db) =>
      db.exec(`INSERT INTO sync_relay_live_documents SELECT workspace_id,main_version_id,object_id,'${lineage}',
      lineage_claim_id,current_path,baseline_moment_relay_seq+10,baseline_projected_sha256,baseline_projected_byte_length,
      '${lineage}',baseline_bytes,'current','open',2,50,NULL FROM sync_relay_live_documents`),
    );
    expect((await page(f)).rows[0].authority).toEqual({
      lineageClaimId: lineage,
      baselineSequence: 11,
      restoreFenceGeneration: 2,
    });
  } finally {
    f.close();
  }
});

it("refuses an aborted read and relay storage that closes during verification", async () => {
  const f = fixture();
  let closed = false;
  try {
    f.append("a");
    await page(f);
    const abort = new AbortController();
    const aborted = journal.readReplicaLiveJournal(f.storage as StorageContext, {
      workspaceId: "workspace",
      after: 0,
      limit: 1,
      signal: abort.signal,
    });
    abort.abort();
    await expect(aborted).rejects.toThrow();
    const reading = f.readStorage();
    f.close();
    closed = true;
    await expect(reading).rejects.toThrow(/unavailable/);
  } finally {
    if (!closed) f.close();
  }
});

it.each(["update_digest"])("refuses a damaged stored %s", async (column) => {
  const f = fixture();
  try {
    f.append("damaged");
    await page(f);
    f.write((db) =>
      db
        .prepare(`UPDATE sync_relay_live_update_journal SET ${column}=?`)
        .run(column === "author_snapshot_json" ? "{}" : "f".repeat(64)),
    );
    await expect(f.readStorage()).rejects.toThrow();
  } finally {
    f.close();
  }
});
