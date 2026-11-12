import { afterEach, expect, it } from "vitest";
import type { JsonValue } from "@dohc/workspace-engine-client";
import { claimWorkspace, closeTestStorage, closeTestStorages, inspectDatabase, reopenTestStorage, storagePath, testHandler, testStorage } from "../testing";
import type { SyncRelayStorage } from "../storage";
import { initializeAccountDeletion, purgeAccountRows } from "./accountDeletion";
import type { StorageContext } from "./context";
import {
  OPERATION_ACTIVE_MS,
  OPERATION_KEEP_SETTLED_MS,
  type AdvanceOperationInput,
  type OperationBinding,
  type OperationClaim,
  type OperationStage,
  type RecordOperationInput,
} from "./operationRecords";

afterEach(closeTestStorages);

const NOW = 1_000_000;
const ACCOUNT = "phone-owner";
const MARKER = "account-operations-v1";
const ARGS = { threadId: "thread", body: "Hello" };
const COMMAND = { messageId: "message", author: { displayName: "Phone owner", authorUserId: ACCOUNT, actorKey: "actor" } };
const TOMBSTONE = ["account_id", "operation_id", "binding_hash", "stage"];

const binding = (args: JsonValue = ARGS, workspaceId = "workspace"): OperationBinding => ({ workspaceId, operation: "send", args });
const key = (operationId: string, changed = binding(), accountId = ACCOUNT) => ({ accountId, operationId, binding: changed });

function input(overrides: Partial<RecordOperationInput> = {}): RecordOperationInput {
  return {
    accountId: ACCOUNT, operationId: "operation-1", binding: binding(), incarnation: 1, replicationEpoch: "epoch",
    streamIdentity: "stream", command: COMMAND, writesMessage: true, nowMs: NOW, ...overrides,
  };
}

async function own(storage: SyncRelayStorage, accountId: string, ...workspaceIds: string[]): Promise<void> {
  const h = testHandler(storage);
  for (const workspaceId of workspaceIds) await claimWorkspace(h, accountId, workspaceId);
}

function giveWorkspace(storage: SyncRelayStorage, workspaceId: string, ownerUserId: string): void {
  const db = inspectDatabase(storagePath(storage));
  db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?").run(ownerUserId, workspaceId);
  db.close();
}

function rowCount(storage: SyncRelayStorage): unknown {
  const db = inspectDatabase(storagePath(storage));
  try { return db.prepare("SELECT count(*) AS n FROM sync_relay_account_operations").get(); } finally { db.close(); }
}

function recorded(claim: OperationClaim) {
  if (claim.kind !== "recorded") throw new Error(`expected a new record, got ${claim.kind}`);
  return claim.record;
}

function advance(storage: SyncRelayStorage, operationId: string, stage: OperationStage, extra: Partial<AdvanceOperationInput> = {}) {
  return storage.advanceAccountOperation({ accountId: ACCOUNT, operationId, stage, nowMs: NOW + 10, ...extra });
}

// The columns each tombstone still holds.
function tombstones(storage: SyncRelayStorage): Array<{ accountId: unknown; operationId: unknown; stage: unknown; kept: string[] }> {
  const db = inspectDatabase(storagePath(storage));
  try {
    return db.prepare("SELECT * FROM sync_relay_account_operations WHERE command_json IS NULL ORDER BY account_id, operation_id").all()
      .map(row => ({ accountId: row.account_id, operationId: row.operation_id, stage: row.stage, kept: Object.keys(row).filter(column => row[column] !== null) }));
  } finally { db.close(); }
}

it("creates the operation table on an older relay once, and refuses an unmarked or damaged one", async () => {
  const storage = await testStorage();
  await own(storage, ACCOUNT, "workspace");
  const path = storagePath(storage);
  closeTestStorage(storage);
  const marker = () => {
    const db = inspectDatabase(path);
    try { return db.prepare("SELECT * FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER); } finally { db.close(); }
  };
  const older = inspectDatabase(path);
  older.exec(`DROP TRIGGER sync_relay_account_operations_workspace_deleted;
    DROP TABLE sync_relay_account_operations;
    DELETE FROM sync_relay_migrations WHERE migration_id = '${MARKER}';`);
  older.close();

  const upgraded = reopenTestStorage(path);
  expect(recorded(upgraded.recordAccountOperation(input())).stage).toBe("recorded");
  closeTestStorage(upgraded);
  const first = marker();
  expect(first).toEqual({ migration_id: MARKER, completed_at_ms: expect.any(Number) });
  const reopened = reopenTestStorage(path);
  expect(reopened.lookupAccountOperation(key("operation-1"))).toMatchObject({ kind: "found" });
  closeTestStorage(reopened);
  expect(marker()).toEqual(first);

  const unmarked = inspectDatabase(path);
  unmarked.prepare("DELETE FROM sync_relay_migrations WHERE migration_id = ?").run(MARKER);
  unmarked.close();
  expect(() => reopenTestStorage(path)).toThrow("unmarked account operation schema already exists");
  const damaged = inspectDatabase(path);
  damaged.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, 1)").run(MARKER);
  damaged.exec("DROP INDEX idx_sync_relay_account_operations_settled");
  damaged.close();
  expect(() => reopenTestStorage(path)).toThrow("account operation schema is missing or damaged");
});

it("records a write once and answers a retry with the same binding from its row", async () => {
  const storage = await testStorage();
  await own(storage, ACCOUNT, "workspace");
  await own(storage, "another-account", "theirs");
  expect(storage.lookupAccountOperation(key("operation-1"))).toEqual({ kind: "absent" });
  const record = recorded(storage.recordAccountOperation(input()));
  expect(record).toEqual({
    accountId: ACCOUNT, operationId: "operation-1", workspaceId: "workspace", incarnation: 1, replicationEpoch: "epoch",
    streamIdentity: "stream", operation: "send", bindingHash: expect.stringMatching(/^[0-9a-f]{64}$/u), command: COMMAND,
    stage: "recorded", messageState: "pending", result: null, activeUntilMs: NOW + OPERATION_ACTIVE_MS,
    createdAtMs: NOW, updatedAtMs: NOW, settledAtMs: null,
  });
  expect(storage.lookupAccountOperation(key("operation-1"))).toEqual({ kind: "found", record });
  // The binding is canonical, and a retry keeps the command recorded first.
  expect(storage.recordAccountOperation(input({ binding: binding({ body: "Hello", threadId: "thread" }), command: { changed: true }, nowMs: NOW + 5 })))
    .toEqual({ kind: "found", record });
  for (const changed of [binding({ ...ARGS, body: "Other" }), binding(ARGS, "other-workspace"), { ...binding(), operation: "post" }]) {
    expect(storage.recordAccountOperation(input({ binding: changed }))).toEqual({ kind: "mismatch" });
    expect(storage.lookupAccountOperation(key("operation-1", changed))).toEqual({ kind: "mismatch" });
  }
  expect(storage.lookupAccountOperation(key("operation-1"))).toEqual({ kind: "found", record });
  expect(recorded(storage.recordAccountOperation(input({ accountId: "another-account", binding: binding(ARGS, "theirs") }))).accountId)
    .toBe("another-account");
  expect(recorded(storage.recordAccountOperation(input({ operationId: "reaction", writesMessage: false }))).messageState).toBeNull();
});

it("admits one row per key across two connections", async () => {
  const first = await testStorage();
  await own(first, ACCOUNT, "workspace");
  const second = reopenTestStorage(storagePath(first));
  const claims = [first, second].map((storage, attempt) => storage.recordAccountOperation(input({ command: { attempt } })));
  const record = recorded(claims[0]!);
  expect(record.command).toEqual({ attempt: 0 });
  expect(claims[1]).toEqual({ kind: "found", record });
  expect(second.recordAccountOperation(input({ binding: binding({ ...ARGS, body: "Other" }) }))).toEqual({ kind: "mismatch" });
  expect(rowCount(first)).toEqual({ n: 1 });
});

it("moves a stage only forward and never out of saved or refused", async () => {
  const storage = await testStorage();
  await own(storage, ACCOUNT, "workspace");
  recorded(storage.recordAccountOperation(input()));
  expect(advance(storage, "operation-1", "reply-written")).toMatchObject({ moved: true, record: { stage: "reply-written", updatedAtMs: NOW + 10 } });
  expect(advance(storage, "operation-1", "recorded")).toMatchObject({ moved: false, record: { stage: "reply-written" } });
  expect(advance(storage, "operation-1", "reply-written", { message: "published" }))
    .toMatchObject({ moved: true, record: { stage: "reply-written", messageState: "published" } });
  // Nothing changed, so nothing is written.
  expect(advance(storage, "operation-1", "reply-written", { message: "published", nowMs: NOW + 20 }))
    .toMatchObject({ moved: false, record: { updatedAtMs: NOW + 10 } });
  expect(advance(storage, "operation-1", "stalled")).toMatchObject({ moved: true, record: { stage: "stalled", settledAtMs: null } });
  expect(advance(storage, "operation-1", "publishing")).toMatchObject({ moved: false, record: { stage: "stalled" } });
  expect(advance(storage, "operation-1", "saved", { result: { messageId: "message" }, nowMs: NOW + 30 }))
    .toMatchObject({ moved: true, record: { stage: "saved", result: { messageId: "message" }, settledAtMs: NOW + 30 } });
  for (const stage of ["refused", "stalled", "saved"] as const) {
    expect(advance(storage, "operation-1", stage, { result: { other: true } }))
      .toMatchObject({ moved: false, record: { stage: "saved", result: { messageId: "message" }, settledAtMs: NOW + 30 } });
  }

  recorded(storage.recordAccountOperation(input({ operationId: "reaction", writesMessage: false })));
  expect(() => advance(storage, "reaction", "publishing", { message: "published" })).toThrow("This operation writes no message.");
  expect(advance(storage, "reaction", "refused", { result: { reason: "Couldn't send" } }))
    .toMatchObject({ moved: true, record: { stage: "refused", messageState: null, settledAtMs: NOW + 10 } });
  expect(advance(storage, "reaction", "saved")).toMatchObject({ moved: false, record: { stage: "refused" } });
  expect(advance(storage, "missing", "saved")).toBeNull();
});

it("lists a copy's unfinished writes, stalled ones included, oldest first", async () => {
  const storage = await testStorage();
  await own(storage, ACCOUNT, "workspace", "other-workspace");
  for (const [index, operationId] of ["stalled", "recorded", "saved", "refused"].entries()) {
    recorded(storage.recordAccountOperation(input({ operationId, nowMs: NOW + index })));
  }
  recorded(storage.recordAccountOperation(input({ operationId: "next-incarnation", incarnation: 2 })));
  recorded(storage.recordAccountOperation(input({ operationId: "other-workspace", binding: binding(ARGS, "other-workspace") })));
  for (const stage of ["stalled", "saved", "refused"] as const) advance(storage, stage, stage);
  expect(storage.listUnfinishedAccountOperations({ workspaceId: "workspace", incarnation: 1 }).map(row => [row.operationId, row.stage]))
    .toEqual([["stalled", "stalled"], ["recorded", "recorded"]]);
});

it("turns writes settled more than 30 days ago into tombstones that answer too old", async () => {
  const storage = await testStorage();
  await own(storage, ACCOUNT, "workspace");
  for (const operationId of ["settled", "later", "unfinished"]) recorded(storage.recordAccountOperation(input({ operationId })));
  advance(storage, "settled", "saved", { result: { messageId: "message" }, nowMs: NOW });
  advance(storage, "later", "refused", { nowMs: NOW + 1 });
  expect(storage.tombstoneSettledAccountOperations(NOW + OPERATION_KEEP_SETTLED_MS)).toBe(0);
  expect(storage.tombstoneSettledAccountOperations(NOW + OPERATION_KEEP_SETTLED_MS + 1)).toBe(1);
  expect(tombstones(storage)).toEqual([{ accountId: ACCOUNT, operationId: "settled", stage: "saved", kept: TOMBSTONE }]);
  expect(storage.lookupAccountOperation(key("settled"))).toEqual({ kind: "too-old" });
  expect(storage.recordAccountOperation(input({ operationId: "settled" }))).toEqual({ kind: "too-old" });
  expect(storage.lookupAccountOperation(key("settled", binding({ ...ARGS, body: "Other" })))).toEqual({ kind: "mismatch" });
  expect(advance(storage, "settled", "saved")).toBeNull();
  expect(storage.lookupAccountOperation(key("later"))).toMatchObject({ kind: "found", record: { stage: "refused" } });

  // An unfinished write is never forgotten, and a tombstone stays.
  expect(storage.tombstoneSettledAccountOperations(NOW + 10 * OPERATION_KEEP_SETTLED_MS)).toBe(1);
  expect(storage.tombstoneSettledAccountOperations(NOW + 10 * OPERATION_KEEP_SETTLED_MS)).toBe(0);
  expect(storage.lookupAccountOperation(key("unfinished"))).toMatchObject({ kind: "found", record: { stage: "recorded" } });
  expect(tombstones(storage).map(row => row.operationId)).toEqual(["later", "settled"]);
});

it("leaves a deleted workspace's writes as tombstones, so a retry is too old", async () => {
  const storage = await testStorage();
  await own(storage, ACCOUNT, "workspace", "other-workspace");
  const unfinished = input({ operationId: "unfinished" });
  const saved = input({ operationId: "saved" });
  const elsewhere = input({ operationId: "elsewhere", binding: binding(ARGS, "other-workspace") });
  for (const each of [unfinished, saved, elsewhere]) recorded(storage.recordAccountOperation(each));
  advance(storage, "saved", "saved", { message: "published", result: { messageId: "message" } });

  const db = inspectDatabase(storagePath(storage), { foreignKeys: true });
  db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run("workspace");
  db.close();
  expect(tombstones(storage)).toEqual([
    { accountId: ACCOUNT, operationId: "saved", stage: "saved", kept: TOMBSTONE },
    { accountId: ACCOUNT, operationId: "unfinished", stage: "refused", kept: TOMBSTONE },
  ]);
  expect(storage.recordAccountOperation(unfinished)).toEqual({ kind: "too-old" });
  expect(storage.lookupAccountOperation(saved)).toEqual({ kind: "too-old" });
  expect(storage.recordAccountOperation({ ...saved, binding: binding({ ...ARGS, body: "Other" }) })).toEqual({ kind: "mismatch" });
  expect(storage.listUnfinishedAccountOperations({ workspaceId: "workspace", incarnation: 1 })).toEqual([]);
  // A write that reaches storage after the deletion leaves nothing behind.
  expect(storage.recordAccountOperation(input({ operationId: "late" }))).toEqual({ kind: "not-owner" });
  expect(storage.lookupAccountOperation(key("late"))).toEqual({ kind: "absent" });
  expect(storage.lookupAccountOperation(elsewhere)).toMatchObject({ kind: "found", record: { workspaceId: "other-workspace" } });
});

it("deletes an account's writes and tombstones, and leaves another account's on its workspaces as tombstones", async () => {
  const storage = await testStorage();
  await own(storage, "former-owner", "owned");
  await own(storage, "bystander", "workspace");
  const owned = (accountId: string, operationId: string) => input({ accountId, operationId, binding: binding(ARGS, "owned") });
  // A former owner's write on the workspace the deleted account then owned, and a write elsewhere.
  const former = owned("former-owner", "former");
  recorded(storage.recordAccountOperation(former));
  giveWorkspace(storage, "owned", "leaving");
  recorded(storage.recordAccountOperation(owned("leaving", "unfinished")));
  recorded(storage.recordAccountOperation(owned("leaving", "forgotten")));
  storage.advanceAccountOperation({ accountId: "leaving", operationId: "forgotten", stage: "saved", nowMs: NOW });
  expect(storage.tombstoneSettledAccountOperations(NOW + OPERATION_KEEP_SETTLED_MS + 1)).toBe(1);
  const elsewhere = input({ accountId: "bystander", operationId: "elsewhere" });
  recorded(storage.recordAccountOperation(elsewhere));

  const context = storage as StorageContext;
  initializeAccountDeletion(context, "account-deletion-test-key");
  purgeAccountRows(context, "leaving", "leaving@dohc.test", {
    workspaces: [{ workspaceId: "owned", replicationEpoch: null, streamIdentity: null }],
    shareIds: [], datasets: [], grantIds: [], publicationIds: [],
  });
  const db = inspectDatabase(storagePath(storage));
  expect(db.prepare("SELECT account_id, operation_id, stage, workspace_id FROM sync_relay_account_operations ORDER BY account_id").all()).toEqual([
    { account_id: "bystander", operation_id: "elsewhere", stage: "recorded", workspace_id: "workspace" },
    { account_id: "former-owner", operation_id: "former", stage: "refused", workspace_id: null },
  ]);
  db.close();
  expect(storage.recordAccountOperation(former)).toEqual({ kind: "too-old" });
  expect(storage.lookupAccountOperation(elsewhere)).toMatchObject({ kind: "found" });
  // A write the deleted account's request started before the purge records nothing after it.
  expect(storage.recordAccountOperation(owned("leaving", "late"))).toEqual({ kind: "not-owner" });
  expect(rowCount(storage)).toEqual({ n: 2 });
});

it("records a new write only for the workspace's owner, and answers a retry from its row after ownership changes", async () => {
  const storage = await testStorage();
  expect(storage.recordAccountOperation(input())).toEqual({ kind: "not-owner" });
  await own(storage, "someone-else", "workspace");
  expect(storage.recordAccountOperation(input())).toEqual({ kind: "not-owner" });
  expect(storage.lookupAccountOperation(key("operation-1"))).toEqual({ kind: "absent" });
  expect(rowCount(storage)).toEqual({ n: 0 });

  giveWorkspace(storage, "workspace", ACCOUNT);
  const record = recorded(storage.recordAccountOperation(input()));
  giveWorkspace(storage, "workspace", "someone-else");
  expect(storage.recordAccountOperation(input())).toEqual({ kind: "found", record });
  expect(storage.recordAccountOperation(input({ binding: binding({ ...ARGS, body: "Other" }) }))).toEqual({ kind: "mismatch" });
  expect(storage.recordAccountOperation(input({ operationId: "operation-2" }))).toEqual({ kind: "not-owner" });
  expect(rowCount(storage)).toEqual({ n: 1 });
});
