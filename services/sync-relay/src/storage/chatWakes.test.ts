import { afterEach, expect, it } from "vitest";
import { closeTestStorage, closeTestStorages, inspectDatabase, reopenTestStorage, storagePath, testStorage } from "../testing";
import type { SyncRelayStorage } from "../storage";
import { initializeAccountDeletion, purgeAccountRows } from "./accountDeletion";
import {
  CHAT_RUNNER_LEASE_MS, CHAT_WAKE_CLAIM_MS, CHAT_WAKE_CONFIRM_MS, CHAT_WAKE_KEEP_MS, chatWakeId, type ChatWakeTarget, type OperationWakeChange,
} from "./chatWakes";
import type { StorageContext } from "./context";

afterEach(closeTestStorages);

const NOW = 1_000_000;
const MARKER = "chat-wakes-v1";

const target = (name: string, ...installs: string[]): ChatWakeTarget => ({
  target: `mention:${name}`, candidates: installs.map((installId) => ({ installId, agentId: "default", label: `${installId} label`, matched: { handle: name } })),
});
const wakeOf = (messageId: string, name: string, generation = 1, workspaceId = "trip", accountId = "ana") =>
  chatWakeId(accountId, workspaceId, messageId, `mention:${name}`, generation);

async function relay() {
  const storage = await testStorage();
  for (const [workspaceId, ownerUserId] of [["trip", "ana"], ["other", "ana"], ["bens", "ben"]] as const) {
    storage.claimWorkspace({ workspaceId, ownerUserId, createdAtMs: 1 });
  }
  return storage;
}

// Records a phone message's operation, then its verdict with the wake change, as publication does.
function record(storage: SyncRelayStorage, operationId: string, input: { accountId?: string; workspaceId?: string } = {}) {
  const { accountId = "ana", workspaceId = "trip" } = input;
  const claim = storage.recordAccountOperation({
    accountId, operationId, binding: { workspaceId, operation: "reply", args: { operationId } }, incarnation: 1,
    replicationEpoch: "epoch", streamIdentity: "stream", command: {}, writesMessage: true, nowMs: NOW,
  });
  if (claim.kind !== "recorded") throw new Error(`expected a new record, got ${claim.kind}`);
  return (change: OperationWakeChange, extra: { stage?: "saved" | "refused"; nowMs?: number } = {}) =>
    storage.advanceAccountOperation({ accountId, operationId, message: "published", nowMs: extra.nowMs ?? NOW, wakes: change,
      ...(extra.stage ? { stage: extra.stage } : {}) });
}

function publish(storage: SyncRelayStorage, operationId: string, messageId: string, targets: ChatWakeTarget[],
  input: { accountId?: string; workspaceId?: string; held?: boolean } = {}) {
  return record(storage, operationId, input)({ publish: { messageId, threadId: "thread-1", held: input.held ?? false, targets } });
}

function wakes(storage: SyncRelayStorage) {
  return (storage as StorageContext).db.prepare(
    `SELECT wake_id, account_id, workspace_id, message_id, thread_id, target, generation, state, candidates_json, prerequisite_message_id,
       winner_install_id, change_seq FROM sync_relay_chat_wakes ORDER BY account_id, workspace_id, message_id, generation`,
  ).all().map((row): Record<string, unknown> => ({ ...row, candidates_json: JSON.parse(String(row.candidates_json)) as unknown }));
}

const count = (storage: SyncRelayStorage, table: string) =>
  Number((storage as StorageContext).db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

it("creates the chat wake tables on an older relay once, and refuses an unmarked or damaged schema", async () => {
  const storage = await testStorage();
  const path = storagePath(storage);
  closeTestStorage(storage);
  const marker = () => {
    const db = inspectDatabase(path);
    try { return db.prepare("SELECT * FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER); } finally { db.close(); }
  };
  const older = inspectDatabase(path);
  older.exec(`DROP TABLE sync_relay_chat_wakes; DROP TABLE sync_relay_chat_runners; DROP TABLE sync_relay_chat_wake_heads;
    DROP TABLE sync_relay_chat_wake_retries; DELETE FROM sync_relay_migrations WHERE migration_id = '${MARKER}';`);
  older.close();

  const upgraded = reopenTestStorage(path);
  upgraded.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
  expect(upgraded.replaceChatRunners({ accountId: "ana", workspaceId: "trip", installId: "mac", computerLabel: "Mac",
    runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }], nowMs: NOW })).toBe(true);
  closeTestStorage(upgraded);
  const first = marker();
  expect(first).toEqual({ migration_id: MARKER, completed_at_ms: expect.any(Number) });
  // Marked, it is checked and kept as it is.
  const reopened = reopenTestStorage(path);
  expect(reopened.enabledChatRunners({ accountId: "ana", workspaceId: "trip", nowMs: NOW })).toHaveLength(1);
  closeTestStorage(reopened);
  expect(marker()).toEqual(first);

  const unmarked = inspectDatabase(path);
  unmarked.prepare("DELETE FROM sync_relay_migrations WHERE migration_id = ?").run(MARKER);
  unmarked.close();
  expect(() => reopenTestStorage(path)).toThrow("unmarked chat wake schema already exists");
  const damaged = inspectDatabase(path);
  damaged.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, 1)").run(MARKER);
  damaged.exec("DROP INDEX idx_sync_relay_chat_wakes_ended");
  damaged.close();
  expect(() => reopenTestStorage(path)).toThrow("chat wake schema is missing or damaged");
});

it("deletes runners and wakes with their workspace, keeps retries' bindings, and deletes everything of an account with it", async () => {
  const storage = await relay();
  const context = storage as StorageContext;
  const owner = (workspaceId: string, ownerUserId: string) =>
    context.db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?").run(ownerUserId, workspaceId);
  // A wake that wasn't confirmed, tried again under `operationId`.
  const retried = (accountId: string, workspaceId: string, operationId: string) => {
    const wakeId = wakeOf(`message-${workspaceId}`, "claude", 1, workspaceId, accountId);
    storage.claimChatWake({ accountId, wakeId, installId: "mac", nowMs: NOW });
    expect(storage.retryChatWake({ accountId, workspaceId, operationId, wakeId, nowMs: NOW + CHAT_WAKE_CONFIRM_MS }).kind).toBe("retried");
  };
  const bindings = () => context.db.prepare("SELECT account_id, workspace_id FROM sync_relay_chat_wake_retries ORDER BY account_id, workspace_id").all();
  const declare = (accountId: string, workspaceId: string) => storage.replaceChatRunners({
    accountId, workspaceId, installId: "mac", computerLabel: "Mac", runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }], nowMs: NOW,
  });
  for (const [accountId, workspaceId] of [["ana", "trip"], ["ana", "other"], ["ben", "bens"]] as const) {
    expect(declare(accountId, workspaceId)).toBe(true);
    publish(storage, `op-${workspaceId}`, `message-${workspaceId}`, [target("claude", "mac", "laptop")], { accountId, workspaceId });
  }
  expect(declare("ben", "trip"), "only the owner declares").toBe(false);
  retried("ana", "trip", "retry-trip");
  retried("ben", "bens", "retry-bens");
  // Ben's wake in a workspace he owned then, which Ana owns when her account goes.
  owner("other", "ben");
  publish(storage, "op-ben-other", "message-other", [target("claude", "mac", "laptop")], { accountId: "ben", workspaceId: "other" });
  retried("ben", "other", "retry-ben-other");
  owner("other", "ana");

  const db = inspectDatabase(storagePath(storage), { foreignKeys: true });
  db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run("trip");
  db.close();
  const left = (table: string) => (storage as StorageContext).db.prepare(`SELECT DISTINCT workspace_id FROM ${table} ORDER BY workspace_id`).all()
    .map((row) => row.workspace_id);
  expect(left("sync_relay_chat_runners")).toEqual(["bens", "other"]);
  expect(left("sync_relay_chat_wakes")).toEqual(["bens", "other"]);
  expect(bindings(), "a binding outlives its wake's workspace").toEqual([
    { account_id: "ana", workspace_id: "trip" }, { account_id: "ben", workspace_id: "bens" }, { account_id: "ben", workspace_id: "other" },
  ]);
  expect(storage.retryChatWake({ accountId: "ana", workspaceId: "trip", operationId: "retry-trip", wakeId: wakeOf("message-trip", "claude"), nowMs: NOW }))
    .toEqual({ kind: "too-old" });

  initializeAccountDeletion(context, "account-deletion-test-key");
  purgeAccountRows(context, "ana", "ana@dohc.test", {
    workspaces: [{ workspaceId: "other", replicationEpoch: null, streamIdentity: null }], shareIds: [], datasets: [], grantIds: [], publicationIds: [],
  });
  expect(left("sync_relay_chat_runners")).toEqual(["bens"]);
  expect(left("sync_relay_chat_wakes")).toEqual(["bens"]);
  expect(context.db.prepare("SELECT account_id FROM sync_relay_chat_wake_heads").all()).toEqual([{ account_id: "ben" }]);
  expect(bindings()).toEqual([{ account_id: "ben", workspace_id: "bens" }, { account_id: "ben", workspace_id: "other" }]);
});

it("makes a published message's wakes in its verdict's transaction, holds an answer's, and makes none when that fails", async () => {
  const storage = await relay();
  const message = record(storage, "op-1");
  const published = { publish: { messageId: "message-1", threadId: "thread-1", held: false, targets: [target("claude", "mac", "laptop")] } };
  message(published);
  expect(wakes(storage)).toEqual([expect.objectContaining({
    wake_id: wakeOf("message-1", "claude"), message_id: "message-1", thread_id: "thread-1", target: "mention:claude", generation: 1, state: "waiting",
    candidates_json: target("claude", "mac", "laptop").candidates, change_seq: 1,
  })]);

  // An answer's wake waits for its decision: released with the question as its prerequisite once saved.
  const answer = record(storage, "op-2");
  answer({ publish: { messageId: "message-2", threadId: "thread-1", held: true, targets: [target("claude", "mac")] } });
  expect(storage.claimChatWake({ accountId: "ana", wakeId: wakeOf("message-2", "claude"), installId: "mac", nowMs: NOW }))
    .toMatchObject({ won: false, wake: { state: "held", winnerLabel: null } });
  answer({ release: { prerequisite: "question-1" } }, { stage: "saved" });
  expect(wakes(storage)[1]).toMatchObject({ message_id: "message-2", state: "waiting", prerequisite_message_id: "question-1" });

  // A later verdict makes no second row, and leaves the first as it was.
  const before = wakes(storage);
  message(published, { stage: "saved" });
  expect(wakes(storage)).toEqual(before);

  // A wake that can't be stored rolls the message's publication back with it.
  const failing = record(storage, "op-4");
  expect(() => failing({ publish: { messageId: "message-4", threadId: "thread-1", held: false, targets: [target("claude", "mac"), { target: "mention:none", candidates: [] }] } }))
    .toThrow();
  expect(storage.listUnfinishedAccountOperations({ workspaceId: "trip" }).find((row) => row.operationId === "op-4"))
    .toMatchObject({ messageState: "pending" });
  expect(wakes(storage).filter((row) => row.message_id === "message-4")).toEqual([]);
});

it("gives a waiting wake to its first candidate's claim, answers the winner after, and confirms only the winner", async () => {
  const storage = await relay();
  publish(storage, "op-1", "message-1", [target("claude", "mac", "laptop")]);
  const wakeId = wakeOf("message-1", "claude");
  const claim = (installId: string, accountId = "ana") => storage.claimChatWake({ accountId, wakeId, installId, nowMs: NOW + 1 });
  const queued = (installId: string, nowMs = NOW + 2) => storage.confirmChatWakeQueued({ accountId: "ana", wakeId, installId, nowMs });
  expect(claim("desktop"), "not a candidate").toBeNull();
  expect(claim("mac", "ben"), "another account's").toBeNull();
  expect(storage.listWaitingChatWakes({ accountId: "ana", installId: "laptop", since: 0, nowMs: NOW }).wakes)
    .toEqual([expect.objectContaining({ wakeId, candidate: target("claude", "laptop").candidates[0] })]);
  expect(claim("mac")).toMatchObject({ won: true, wake: { state: "claimed", winnerLabel: "mac label" } });
  expect(claim("laptop")).toMatchObject({ won: false, wake: { state: "claimed", winnerLabel: "mac label" } });
  expect(claim("mac"), "a lost answer claims again").toMatchObject({ won: true });
  expect(storage.listWaitingChatWakes({ accountId: "ana", installId: "laptop", since: 0, nowMs: NOW }).wakes).toEqual([]);
  expect(queued("laptop")).toBeNull();
  expect(queued("mac")).toMatchObject({ state: "queued" });
  expect(queued("mac")).toMatchObject({ state: "queued" });

  // Once the account no longer owns the workspace, its wakes there answer as missing.
  (storage as StorageContext).db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'ben' WHERE workspace_id = 'trip'").run();
  expect(claim("mac")).toBeNull();
  expect(queued("mac")).toBeNull();
});

it("ends a wake with no claim in 7 days, a claim with no queued in 24 hours, takes a late queued, and deletes ended wakes after 30 days", async () => {
  const storage = await relay();
  publish(storage, "op-1", "message-1", [target("claude", "mac")]);
  publish(storage, "op-2", "message-2", [target("claude", "mac")]);
  const first = wakeOf("message-1", "claude"), second = wakeOf("message-2", "claude");
  expect(storage.claimChatWake({ accountId: "ana", wakeId: first, installId: "mac", nowMs: NOW + CHAT_WAKE_CLAIM_MS }))
    .toMatchObject({ won: false, wake: { state: "unclaimed" } });
  expect(storage.claimChatWake({ accountId: "ana", wakeId: second, installId: "mac", nowMs: NOW })).toMatchObject({ won: true });
  expect(storage.sweepChatWakes(NOW + CHAT_WAKE_CONFIRM_MS - 1)).toBe(0);
  expect(storage.sweepChatWakes(NOW + CHAT_WAKE_CONFIRM_MS)).toBe(1);
  expect(wakes(storage).map((row) => row.state)).toEqual(["unclaimed", "unconfirmed"]);
  const late = NOW + 2 * CHAT_WAKE_CONFIRM_MS;
  expect(storage.confirmChatWakeQueued({ accountId: "ana", wakeId: second, installId: "mac", nowMs: late })).toMatchObject({ state: "queued" });
  expect(storage.sweepChatWakes(late + CHAT_WAKE_KEEP_MS)).toBe(0);
  expect(storage.sweepChatWakes(late + CHAT_WAKE_KEEP_MS + 1)).toBe(1);
  expect(wakes(storage).map((row) => row.wake_id)).toEqual([first]);
  expect(storage.sweepChatWakes(NOW + CHAT_WAKE_CLAIM_MS + CHAT_WAKE_KEEP_MS + 1)).toBe(1);
  expect(count(storage, "sync_relay_chat_wakes")).toBe(0);
});

it("retries a wake that didn't start or wasn't confirmed once per generation, bound to its operation ID", async () => {
  const storage = await relay();
  publish(storage, "op-1", "message-1", [target("claude", "mac", "laptop")]);
  publish(storage, "op-2", "message-2", [target("codex", "mac")]);
  const source = wakeOf("message-1", "claude");
  const retry = (operationId: string, wakeId = source, workspaceId = "trip", accountId = "ana") =>
    storage.retryChatWake({ accountId, workspaceId, operationId, wakeId, nowMs: NOW + CHAT_WAKE_CONFIRM_MS });
  expect(retry("retry-0"), "still waiting").toEqual({ kind: "refused" });
  storage.claimChatWake({ accountId: "ana", wakeId: source, installId: "mac", nowMs: NOW });

  // Unconfirmed, it is tried on another computer: the winner leaves the candidates.
  const next = wakeOf("message-1", "claude", 2);
  expect(retry("retry-1")).toEqual({ kind: "retried", wake: expect.objectContaining({ wakeId: next, generation: 2, state: "waiting" }) });
  expect(wakes(storage).find((row) => row.wake_id === next)).toMatchObject({
    candidates_json: target("claude", "laptop").candidates, message_id: "message-1",
  });
  expect(wakes(storage).find((row) => row.wake_id === source), "the old row stays").toMatchObject({ state: "unconfirmed", winner_install_id: "mac" });
  expect(retry("retry-1"), "a repeat answers its row").toMatchObject({ kind: "retried", wake: { wakeId: next } });
  expect(retry("retry-1", wakeOf("message-2", "codex")), "the key names another retry").toEqual({ kind: "mismatch" });
  expect(retry("op-2"), "the key names a write").toEqual({ kind: "mismatch" });
  expect(storage.recordAccountOperation({
    accountId: "ana", operationId: "retry-1", binding: { workspaceId: "trip", operation: "reply", args: {} }, incarnation: 1,
    replicationEpoch: "epoch", streamIdentity: "stream", command: {}, writesMessage: true, nowMs: NOW,
  }), "a write can't take a retry's key").toEqual({ kind: "mismatch" });
  expect(retry("retry-2"), "a superseded generation answers its next row").toMatchObject({ kind: "retried", wake: { wakeId: next } });
  expect(count(storage, "sync_relay_chat_wakes")).toBe(3);
  // That answer binds its key too.
  expect(retry("retry-2", wakeOf("message-2", "codex"))).toEqual({ kind: "mismatch" });
  expect(storage.recordAccountOperation({
    accountId: "ana", operationId: "retry-2", binding: { workspaceId: "trip", operation: "reply", args: {} }, incarnation: 1,
    replicationEpoch: "epoch", streamIdentity: "stream", command: {}, writesMessage: true, nowMs: NOW,
  })).toEqual({ kind: "mismatch" });

  // The old winner can't claim the new generation; its late queued settles only its own row.
  expect(storage.claimChatWake({ accountId: "ana", wakeId: next, installId: "mac", nowMs: NOW + 1 })).toBeNull();
  expect(storage.confirmChatWakeQueued({ accountId: "ana", wakeId: source, installId: "mac", nowMs: NOW + 2 })).toMatchObject({ state: "queued" });
  expect(wakes(storage).find((row) => row.wake_id === next)).toMatchObject({ state: "waiting" });

  // With its only candidate the winner, an unconfirmed wake has no other computer to try.
  const single = wakeOf("message-2", "codex");
  storage.claimChatWake({ accountId: "ana", wakeId: single, installId: "mac", nowMs: NOW });
  expect(retry("retry-3", single)).toEqual({ kind: "refused" });
  expect(count(storage, "sync_relay_chat_wakes")).toBe(3);

  // Another workspace's, or another account's, answers as missing.
  publish(storage, "op-other", "message-other", [target("claude", "mac")], { workspaceId: "other" });
  expect(retry("retry-4", wakeOf("message-other", "claude", 1, "other"))).toEqual({ kind: "missing" });
  expect(retry("retry-5", source, "trip", "ben")).toEqual({ kind: "missing" });
});

it("names a computer as a wake target only while its declaration's lease holds, and starts the lease again on every declaration", async () => {
  const storage = await relay();
  const declare = (installId: string, nowMs: number, displayName = "Claude") => storage.replaceChatRunners({
    accountId: "ana", workspaceId: "trip", installId, computerLabel: installId,
    runners: [{ agentId: "default", handle: displayName.toLowerCase(), displayName, enabled: true }], nowMs,
  });
  const targets = (nowMs: number) =>
    storage.enabledChatRunners({ accountId: "ana", workspaceId: "trip", nowMs }).map((runner) => runner.installId);
  declare("mac", NOW);
  declare("laptop", NOW);
  // The boundary: a lease holds up to, not at, CHAT_RUNNER_LEASE_MS after its declaration.
  expect(targets(NOW + CHAT_RUNNER_LEASE_MS - 1)).toEqual(["laptop", "mac"]);
  expect(targets(NOW + CHAT_RUNNER_LEASE_MS)).toEqual([]);
  // The same declaration again starts the lease again: the refresh a signed-in computer sends about daily.
  declare("mac", NOW + CHAT_RUNNER_LEASE_MS - 1);
  const updated = (storage as StorageContext).db.prepare(
    "SELECT install_id, updated_at_ms FROM sync_relay_chat_runners WHERE install_id = 'mac'").get();
  expect(updated).toEqual({ install_id: "mac", updated_at_ms: NOW + CHAT_RUNNER_LEASE_MS - 1 });
  expect(targets(NOW + CHAT_RUNNER_LEASE_MS)).toEqual(["mac"]);
  // An expired computer's rows stay, read as absent, until it declares again.
  expect(count(storage, "sync_relay_chat_runners")).toBe(2);
  declare("laptop", NOW + 2 * CHAT_RUNNER_LEASE_MS, "Nova");
  expect(targets(NOW + 2 * CHAT_RUNNER_LEASE_MS).sort()).toEqual(["laptop"]);
});
