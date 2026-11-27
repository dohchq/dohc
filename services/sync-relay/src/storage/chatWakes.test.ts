import { afterEach, expect, it } from "vitest";
import {
  closeTestStorage,
  closeTestStorages,
  inspectDatabase,
  reopenTestStorage,
  storagePath,
  testStorage,
} from "../testing";
import type { SyncRelayStorage } from "../storage";
import { initializeAccountDeletion, purgeAccountRows } from "./accountDeletion";
import {
  CHAT_RUNNER_LEASE_MS,
  CHAT_WAKE_CLAIM_MS,
  CHAT_WAKE_CONFIRM_MS,
  CHAT_WAKE_KEEP_MS,
  chatWakeId,
  type ChatWakeTarget,
  type OperationWakeChange,
} from "./chatWakes";
import type { StorageContext } from "./context";

afterEach(closeTestStorages);

const NOW = 1_000_000;
const MARKER = "chat-wakes-v1";
const MEMORY_MARKER = "chat-runner-memory-v1";

const target = (name: string, ...installs: string[]): ChatWakeTarget => ({
  target: `mention:${name}`,
  candidates: installs.map((installId) => ({
    installId,
    agentId: "default",
    label: `${installId} label`,
    matched: { handle: name },
  })),
});
const wakeOf = (
  messageId: string,
  name: string,
  generation = 1,
  workspaceId = "trip",
  accountId = "ana",
) => chatWakeId(accountId, workspaceId, messageId, `mention:${name}`, generation);

async function relay() {
  const storage = await testStorage();
  for (const [workspaceId, ownerUserId] of [
    ["trip", "ana"],
    ["other", "ana"],
    ["bens", "ben"],
  ] as const) {
    storage.claimWorkspace({ workspaceId, ownerUserId, createdAtMs: 1 });
  }
  return storage;
}

function record(
  storage: SyncRelayStorage,
  operationId: string,
  input: { accountId?: string; workspaceId?: string } = {},
) {
  const { accountId = "ana", workspaceId = "trip" } = input;
  const claim = storage.recordAccountOperation({
    accountId,
    operationId,
    binding: { workspaceId, operation: "reply", args: { operationId } },
    incarnation: 1,
    replicationEpoch: "epoch",
    streamIdentity: "stream",
    command: {},
    writesMessage: true,
    nowMs: NOW,
  });
  if (claim.kind !== "recorded") throw new Error(`expected a new record, got ${claim.kind}`);
  return (
    change: OperationWakeChange,
    extra: { stage?: "saved" | "refused"; nowMs?: number } = {},
  ) =>
    storage.advanceAccountOperation({
      accountId,
      operationId,
      message: "published",
      nowMs: extra.nowMs ?? NOW,
      wakes: change,
      ...(extra.stage ? { stage: extra.stage } : {}),
    });
}

function publish(
  storage: SyncRelayStorage,
  operationId: string,
  messageId: string,
  targets: ChatWakeTarget[],
  input: { accountId?: string; workspaceId?: string; held?: boolean } = {},
) {
  return record(
    storage,
    operationId,
    input,
  )({ publish: { messageId, threadId: "thread-1", held: input.held ?? false, targets } });
}

function wakes(storage: SyncRelayStorage) {
  return (storage as StorageContext).db
    .prepare(
      `SELECT wake_id, account_id, workspace_id, message_id, thread_id, target, generation, state, candidates_json, prerequisite_message_id,
       winner_install_id, change_seq FROM sync_relay_chat_wakes ORDER BY account_id, workspace_id, message_id, generation`,
    )
    .all()
    .map((row): Record<string, unknown> => ({
      ...row,
      candidates_json: JSON.parse(String(row.candidates_json)) as unknown,
    }));
}

const count = (storage: SyncRelayStorage, table: string) =>
  Number((storage as StorageContext).db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

it("creates the chat wake tables on an older relay once, and refuses an unmarked or damaged schema", async () => {
  const storage = await testStorage();
  const path = storagePath(storage);
  closeTestStorage(storage);
  const marker = () => {
    const db = inspectDatabase(path);
    try {
      return db.prepare("SELECT * FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER);
    } finally {
      db.close();
    }
  };
  const older = inspectDatabase(path);
  older.exec(`DROP TABLE sync_relay_chat_wakes; DROP TABLE sync_relay_chat_runners; DROP TABLE sync_relay_chat_wake_heads;
    DROP TABLE sync_relay_chat_wake_retries;
    DELETE FROM sync_relay_migrations WHERE migration_id IN ('${MARKER}', '${MEMORY_MARKER}');`);
  older.close();

  const upgraded = reopenTestStorage(path);
  upgraded.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
  expect(
    upgraded.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId: "mac",
      computerLabel: "Mac",
      runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }],
      nowMs: NOW,
    }),
  ).toBe(true);
  closeTestStorage(upgraded);
  const first = marker();
  expect(first).toEqual({ migration_id: MARKER, completed_at_ms: expect.any(Number) });
  const reopened = reopenTestStorage(path);
  expect(
    reopened.enabledChatRunners({ accountId: "ana", workspaceId: "trip", nowMs: NOW }),
  ).toHaveLength(1);
  closeTestStorage(reopened);
  expect(marker()).toEqual(first);

  const unmarked = inspectDatabase(path);
  unmarked.prepare("DELETE FROM sync_relay_migrations WHERE migration_id = ?").run(MARKER);
  unmarked.close();
  expect(() => reopenTestStorage(path)).toThrow("unmarked chat wake schema already exists");
  const damaged = inspectDatabase(path);
  damaged
    .prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, 1)")
    .run(MARKER);
  damaged.exec("DROP INDEX idx_sync_relay_chat_wakes_ended");
  damaged.close();
  expect(() => reopenTestStorage(path)).toThrow("chat wake schema is missing or damaged");
});

it("adds runners' memory to a relay that has chat wakes, once, keeping its runners", async () => {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
  storage.replaceChatRunners({
    accountId: "ana",
    workspaceId: "trip",
    installId: "mac",
    computerLabel: "Mac",
    runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }],
    nowMs: NOW,
  });
  const path = storagePath(storage);
  closeTestStorage(storage);
  const older = inspectDatabase(path);
  older.exec(`ALTER TABLE sync_relay_chat_runners DROP COLUMN memory;
    DELETE FROM sync_relay_migrations WHERE migration_id = '${MEMORY_MARKER}';`);
  older.close();

  for (let boot = 0; boot < 2; boot += 1) {
    const upgraded = reopenTestStorage(path);
    expect(
      upgraded.enabledChatRunners({ accountId: "ana", workspaceId: "trip", nowMs: NOW }),
    ).toMatchObject([{ installId: "mac", agentId: "default", memory: false }]);
    closeTestStorage(upgraded);
  }
});

it("opens a relay whose runners gained memory before its migration was marked", async () => {
  const storage = await testStorage();
  const path = storagePath(storage);
  closeTestStorage(storage);
  const interrupted = inspectDatabase(path);
  interrupted
    .prepare("DELETE FROM sync_relay_migrations WHERE migration_id = ?")
    .run(MEMORY_MARKER);
  interrupted.close();

  const reopened = reopenTestStorage(path);
  closeTestStorage(reopened);
  const db = inspectDatabase(path);
  try {
    expect(
      db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MEMORY_MARKER),
    ).toBeDefined();
  } finally {
    db.close();
  }
});

it("deletes runners and wakes with their workspace, keeps retries' bindings, and deletes everything of an account with it", async () => {
  const storage = await relay();
  const context = storage as StorageContext;
  const owner = (workspaceId: string, ownerUserId: string) =>
    context.db
      .prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?")
      .run(ownerUserId, workspaceId);
  const retried = (accountId: string, workspaceId: string, operationId: string) => {
    // The computer the retry moves to holds a leased declaration.
    expect(
      storage.replaceChatRunners({
        accountId,
        workspaceId,
        installId: "laptop",
        computerLabel: "Laptop",
        runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }],
        nowMs: NOW,
      }),
    ).toBe(true);
    const wakeId = wakeOf(`message-${workspaceId}`, "claude", 1, workspaceId, accountId);
    storage.claimChatWake({ accountId, wakeId, installId: "mac", nowMs: NOW });
    expect(
      storage.retryChatWake({
        accountId,
        workspaceId,
        operationId,
        wakeId,
        nowMs: NOW + CHAT_WAKE_CONFIRM_MS,
      }).kind,
    ).toBe("retried");
  };
  const bindings = () =>
    context.db
      .prepare(
        "SELECT account_id, workspace_id FROM sync_relay_chat_wake_retries ORDER BY account_id, workspace_id",
      )
      .all();
  const declare = (accountId: string, workspaceId: string) =>
    storage.replaceChatRunners({
      accountId,
      workspaceId,
      installId: "mac",
      computerLabel: "Mac",
      runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }],
      nowMs: NOW,
    });
  for (const [accountId, workspaceId] of [
    ["ana", "trip"],
    ["ana", "other"],
    ["ben", "bens"],
  ] as const) {
    expect(declare(accountId, workspaceId)).toBe(true);
    publish(
      storage,
      `op-${workspaceId}`,
      `message-${workspaceId}`,
      [target("claude", "mac", "laptop")],
      { accountId, workspaceId },
    );
  }
  expect(declare("ben", "trip"), "only the owner declares").toBe(false);
  retried("ana", "trip", "retry-trip");
  retried("ben", "bens", "retry-bens");
  owner("other", "ben");
  publish(storage, "op-ben-other", "message-other", [target("claude", "mac", "laptop")], {
    accountId: "ben",
    workspaceId: "other",
  });
  retried("ben", "other", "retry-ben-other");
  owner("other", "ana");

  const db = inspectDatabase(storagePath(storage), { foreignKeys: true });
  db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run("trip");
  db.close();
  const left = (table: string) =>
    (storage as StorageContext).db
      .prepare(`SELECT DISTINCT workspace_id FROM ${table} ORDER BY workspace_id`)
      .all()
      .map((row) => row.workspace_id);
  expect(left("sync_relay_chat_runners")).toEqual(["bens", "other"]);
  expect(left("sync_relay_chat_wakes")).toEqual(["bens", "other"]);
  expect(bindings(), "a binding outlives its wake's workspace").toEqual([
    { account_id: "ana", workspace_id: "trip" },
    { account_id: "ben", workspace_id: "bens" },
    { account_id: "ben", workspace_id: "other" },
  ]);
  expect(
    storage.retryChatWake({
      accountId: "ana",
      workspaceId: "trip",
      operationId: "retry-trip",
      wakeId: wakeOf("message-trip", "claude"),
      nowMs: NOW,
    }),
  ).toEqual({ kind: "too-old" });

  initializeAccountDeletion(context, "account-deletion-test-key");
  purgeAccountRows(context, "ana", "ana@dohc.test", {
    workspaces: [{ workspaceId: "other", replicationEpoch: null, streamIdentity: null }],
    shareIds: [],
    datasets: [],
    grantIds: [],
    publicationIds: [],
  });
  expect(left("sync_relay_chat_runners")).toEqual(["bens"]);
  expect(left("sync_relay_chat_wakes")).toEqual(["bens"]);
  expect(context.db.prepare("SELECT account_id FROM sync_relay_chat_wake_heads").all()).toEqual([
    { account_id: "ben" },
  ]);
  expect(bindings()).toEqual([
    { account_id: "ben", workspace_id: "bens" },
    { account_id: "ben", workspace_id: "other" },
  ]);
});

it("makes a published message's wakes in its verdict's transaction, holds an answer's, and makes none when that fails", async () => {
  const storage = await relay();
  const message = record(storage, "op-1");
  const published = {
    publish: {
      messageId: "message-1",
      threadId: "thread-1",
      held: false,
      targets: [target("claude", "mac", "laptop")],
    },
  };
  message(published);
  expect(wakes(storage)).toEqual([
    expect.objectContaining({
      wake_id: wakeOf("message-1", "claude"),
      message_id: "message-1",
      thread_id: "thread-1",
      target: "mention:claude",
      generation: 1,
      state: "waiting",
      candidates_json: target("claude", "mac", "laptop").candidates,
      change_seq: 1,
    }),
  ]);

  // An answer's wake waits for its decision: released with the question as its prerequisite once saved.
  const answer = record(storage, "op-2");
  answer({
    publish: {
      messageId: "message-2",
      threadId: "thread-1",
      held: true,
      targets: [target("claude", "mac")],
    },
  });
  expect(
    storage.claimChatWake({
      accountId: "ana",
      wakeId: wakeOf("message-2", "claude"),
      installId: "mac",
      nowMs: NOW,
    }),
  ).toMatchObject({ won: false, wake: { state: "held", winnerLabel: null } });
  answer({ release: { prerequisite: "question-1" } }, { stage: "saved" });
  expect(wakes(storage)[1]).toMatchObject({
    message_id: "message-2",
    state: "waiting",
    prerequisite_message_id: "question-1",
  });

  const before = wakes(storage);
  message(published, { stage: "saved" });
  expect(wakes(storage)).toEqual(before);

  const failing = record(storage, "op-4");
  expect(() =>
    failing({
      publish: {
        messageId: "message-4",
        threadId: "thread-1",
        held: false,
        targets: [target("claude", "mac"), { target: "mention:none", candidates: [] }],
      },
    }),
  ).toThrow();
  expect(
    storage
      .listUnfinishedAccountOperations({ workspaceId: "trip" })
      .find((row) => row.operationId === "op-4"),
  ).toMatchObject({ messageState: "pending" });
  expect(wakes(storage).filter((row) => row.message_id === "message-4")).toEqual([]);
});

it("gives a waiting wake to its first candidate's claim, answers the winner after, and confirms only the winner", async () => {
  const storage = await relay();
  publish(storage, "op-1", "message-1", [target("claude", "mac", "laptop")]);
  const wakeId = wakeOf("message-1", "claude");
  const claim = (installId: string, accountId = "ana") =>
    storage.claimChatWake({ accountId, wakeId, installId, nowMs: NOW + 1 });
  const queued = (installId: string, nowMs = NOW + 2) =>
    storage.confirmChatWakeQueued({ accountId: "ana", wakeId, installId, nowMs });
  expect(claim("desktop"), "not a candidate").toBeNull();
  expect(claim("mac", "ben"), "another account's").toBeNull();
  expect(
    storage.listWaitingChatWakes({ accountId: "ana", installId: "laptop", since: 0, nowMs: NOW })
      .wakes,
  ).toEqual([
    expect.objectContaining({ wakeId, candidate: target("claude", "laptop").candidates[0] }),
  ]);
  expect(claim("mac")).toMatchObject({
    won: true,
    wake: { state: "claimed", winnerLabel: "mac label" },
  });
  expect(claim("laptop")).toMatchObject({
    won: false,
    wake: { state: "claimed", winnerLabel: "mac label" },
  });
  expect(claim("mac"), "a lost answer claims again").toMatchObject({ won: true });
  expect(
    storage.listWaitingChatWakes({ accountId: "ana", installId: "laptop", since: 0, nowMs: NOW })
      .wakes,
  ).toEqual([]);
  expect(queued("laptop")).toBeNull();
  expect(queued("mac")).toMatchObject({ state: "queued" });
  expect(queued("mac")).toMatchObject({ state: "queued" });

  (storage as StorageContext).db
    .prepare("UPDATE sync_relay_workspaces SET owner_user_id = 'ben' WHERE workspace_id = 'trip'")
    .run();
  expect(claim("mac")).toBeNull();
  expect(queued("mac")).toBeNull();
});

it("ends a wake with no claim in 7 days, a claim with no queued in 24 hours, takes a late queued, and deletes ended wakes after 30 days", async () => {
  const storage = await relay();
  publish(storage, "op-1", "message-1", [target("claude", "mac")]);
  publish(storage, "op-2", "message-2", [target("claude", "mac")]);
  const first = wakeOf("message-1", "claude"),
    second = wakeOf("message-2", "claude");
  expect(
    storage.claimChatWake({
      accountId: "ana",
      wakeId: first,
      installId: "mac",
      nowMs: NOW + CHAT_WAKE_CLAIM_MS,
    }),
  ).toMatchObject({ won: false, wake: { state: "unclaimed" } });
  expect(
    storage.claimChatWake({ accountId: "ana", wakeId: second, installId: "mac", nowMs: NOW }),
  ).toMatchObject({ won: true });
  expect(storage.sweepChatWakes(NOW + CHAT_WAKE_CONFIRM_MS - 1)).toBe(0);
  expect(storage.sweepChatWakes(NOW + CHAT_WAKE_CONFIRM_MS)).toBe(1);
  expect(wakes(storage).map((row) => row.state)).toEqual(["unclaimed", "unconfirmed"]);
  const late = NOW + 2 * CHAT_WAKE_CONFIRM_MS;
  expect(
    storage.confirmChatWakeQueued({
      accountId: "ana",
      wakeId: second,
      installId: "mac",
      nowMs: late,
    }),
  ).toMatchObject({ state: "queued" });
  expect(storage.sweepChatWakes(late + CHAT_WAKE_KEEP_MS)).toBe(0);
  expect(storage.sweepChatWakes(late + CHAT_WAKE_KEEP_MS + 1)).toBe(1);
  expect(wakes(storage).map((row) => row.wake_id)).toEqual([first]);
  expect(storage.sweepChatWakes(NOW + CHAT_WAKE_CLAIM_MS + CHAT_WAKE_KEEP_MS + 1)).toBe(1);
  expect(count(storage, "sync_relay_chat_wakes")).toBe(0);
});

it("retries a wake that didn't start or wasn't confirmed once per generation, bound to its operation ID", async () => {
  const storage = await relay();
  // Both computers declared, so their leases hold for the retries below.
  for (const installId of ["mac", "laptop"]) {
    storage.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId,
      computerLabel: installId,
      runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }],
      nowMs: NOW,
    });
  }
  publish(storage, "op-1", "message-1", [target("claude", "mac", "laptop")]);
  publish(storage, "op-2", "message-2", [target("codex", "mac")]);
  const source = wakeOf("message-1", "claude");
  const retry = (operationId: string, wakeId = source, workspaceId = "trip", accountId = "ana") =>
    storage.retryChatWake({
      accountId,
      workspaceId,
      operationId,
      wakeId,
      nowMs: NOW + CHAT_WAKE_CONFIRM_MS,
    });
  expect(retry("retry-0"), "still waiting").toEqual({ kind: "refused" });
  storage.claimChatWake({ accountId: "ana", wakeId: source, installId: "mac", nowMs: NOW });

  const next = wakeOf("message-1", "claude", 2);
  expect(retry("retry-1")).toEqual({
    kind: "retried",
    wake: expect.objectContaining({ wakeId: next, generation: 2, state: "waiting" }),
  });
  expect(wakes(storage).find((row) => row.wake_id === next)).toMatchObject({
    candidates_json: target("claude", "laptop").candidates,
    message_id: "message-1",
  });
  expect(
    wakes(storage).find((row) => row.wake_id === source),
    "the old row stays",
  ).toMatchObject({ state: "unconfirmed", winner_install_id: "mac" });
  expect(retry("retry-1"), "a repeat answers its row").toMatchObject({
    kind: "retried",
    wake: { wakeId: next },
  });
  expect(retry("retry-1", wakeOf("message-2", "codex")), "the key names another retry").toEqual({
    kind: "mismatch",
  });
  expect(retry("op-2"), "the key names a write").toEqual({ kind: "mismatch" });
  expect(
    storage.recordAccountOperation({
      accountId: "ana",
      operationId: "retry-1",
      binding: { workspaceId: "trip", operation: "reply", args: {} },
      incarnation: 1,
      replicationEpoch: "epoch",
      streamIdentity: "stream",
      command: {},
      writesMessage: true,
      nowMs: NOW,
    }),
    "a write can't take a retry's key",
  ).toEqual({ kind: "mismatch" });
  expect(retry("retry-2"), "a superseded generation answers its next row").toMatchObject({
    kind: "retried",
    wake: { wakeId: next },
  });
  expect(count(storage, "sync_relay_chat_wakes")).toBe(3);
  expect(retry("retry-2", wakeOf("message-2", "codex"))).toEqual({ kind: "mismatch" });
  expect(
    storage.recordAccountOperation({
      accountId: "ana",
      operationId: "retry-2",
      binding: { workspaceId: "trip", operation: "reply", args: {} },
      incarnation: 1,
      replicationEpoch: "epoch",
      streamIdentity: "stream",
      command: {},
      writesMessage: true,
      nowMs: NOW,
    }),
  ).toEqual({ kind: "mismatch" });

  expect(
    storage.claimChatWake({ accountId: "ana", wakeId: next, installId: "mac", nowMs: NOW + 1 }),
  ).toBeNull();
  expect(
    storage.confirmChatWakeQueued({
      accountId: "ana",
      wakeId: source,
      installId: "mac",
      nowMs: NOW + 2,
    }),
  ).toMatchObject({ state: "queued" });
  expect(wakes(storage).find((row) => row.wake_id === next)).toMatchObject({ state: "waiting" });

  const single = wakeOf("message-2", "codex");
  storage.claimChatWake({ accountId: "ana", wakeId: single, installId: "mac", nowMs: NOW });
  expect(retry("retry-3", single)).toEqual({ kind: "refused" });
  expect(count(storage, "sync_relay_chat_wakes")).toBe(3);

  publish(storage, "op-other", "message-other", [target("claude", "mac")], {
    workspaceId: "other",
  });
  expect(retry("retry-4", wakeOf("message-other", "claude", 1, "other"))).toEqual({
    kind: "missing",
  });
  expect(retry("retry-5", source, "trip", "ben")).toEqual({ kind: "missing" });
});

it("names a computer as a wake target only while its declaration's lease holds, and starts the lease again on every declaration", async () => {
  const storage = await relay();
  const declare = (installId: string, nowMs: number, displayName = "Claude") =>
    storage.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId,
      computerLabel: installId,
      runners: [
        { agentId: "default", handle: displayName.toLowerCase(), displayName, enabled: true },
      ],
      nowMs,
    });
  const targets = (nowMs: number) =>
    storage
      .enabledChatRunners({ accountId: "ana", workspaceId: "trip", nowMs })
      .map((runner) => runner.installId);
  declare("mac", NOW);
  declare("laptop", NOW);
  expect(targets(NOW + CHAT_RUNNER_LEASE_MS - 1)).toEqual(["laptop", "mac"]);
  expect(targets(NOW + CHAT_RUNNER_LEASE_MS)).toEqual([]);
  // The same declaration again starts the lease again: the refresh a signed-in computer sends about daily.
  declare("mac", NOW + CHAT_RUNNER_LEASE_MS - 1);
  const updated = (storage as StorageContext).db
    .prepare(
      "SELECT install_id, updated_at_ms FROM sync_relay_chat_runners WHERE install_id = 'mac'",
    )
    .get();
  expect(updated).toEqual({ install_id: "mac", updated_at_ms: NOW + CHAT_RUNNER_LEASE_MS - 1 });
  expect(targets(NOW + CHAT_RUNNER_LEASE_MS)).toEqual(["mac"]);
  expect(count(storage, "sync_relay_chat_runners")).toBe(2);
  declare("laptop", NOW + 2 * CHAT_RUNNER_LEASE_MS, "Nova");
  expect(targets(NOW + 2 * CHAT_RUNNER_LEASE_MS).sort()).toEqual(["laptop"]);
});

it("tries a wake again only on computers whose declaration of its agent is enabled and still leased", async () => {
  const storage = await relay();
  const late = NOW + CHAT_WAKE_CLAIM_MS;
  const declare = (installId: string, nowMs: number, enabled = true) =>
    storage.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId,
      computerLabel: installId,
      runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled }],
      nowMs,
    });
  // Every wake below waited its whole claim time unclaimed. By then: the Mac never declared, the laptop's lease holds,
  // the desktop's ended just then, and the tablet declared its agent switched off.
  publish(storage, "op-some", "message-some", [
    target("claude", "mac", "laptop", "desktop", "tablet"),
  ]);
  publish(storage, "op-none", "message-none", [target("claude", "mac", "desktop", "tablet")]);
  declare("laptop", late - 1);
  declare("desktop", late - CHAT_RUNNER_LEASE_MS);
  declare("tablet", late - 1, false);
  const retry = (operationId: string, messageId: string) =>
    storage.retryChatWake({
      accountId: "ana",
      workspaceId: "trip",
      operationId,
      wakeId: wakeOf(messageId, "claude"),
      nowMs: late,
    });

  const next = wakeOf("message-some", "claude", 2);
  expect(retry("retry-some", "message-some")).toMatchObject({
    kind: "retried",
    wake: { wakeId: next, generation: 2, state: "waiting" },
  });
  expect(wakes(storage).find((row) => row.wake_id === next)?.candidates_json).toEqual(
    target("claude", "laptop").candidates,
  );
  const before = count(storage, "sync_relay_chat_wakes");
  expect(retry("retry-none", "message-none")).toEqual({ kind: "refused" });
  expect(count(storage, "sync_relay_chat_wakes")).toBe(before);
});

const shown = (...messageIds: string[]) =>
  new Map(messageIds.map((messageId) => [messageId, "thread-1"]));
const byWake = (hints: readonly { wakeId: string }[]) =>
  Object.fromEntries(hints.map((hint) => [hint.wakeId, hint]));

it("gives the phone each shown message's latest generation per target, as its wait's end leaves it, and whether a retry finds another computer", async () => {
  const storage = await relay();
  // Only the laptop holds a leased declaration of the agent.
  storage.replaceChatRunners({
    accountId: "ana",
    workspaceId: "trip",
    installId: "laptop",
    computerLabel: "laptop label",
    runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }],
    nowMs: NOW,
  });
  publish(storage, "op-1", "message-1", [
    target("claude", "mac", "laptop"),
    target("codex", "mac"),
  ]);
  publish(storage, "op-held", "message-held", [target("claude", "mac", "laptop")], { held: true });
  publish(storage, "op-ben", "message-1", [target("claude", "mac")], {
    accountId: "ben",
    workspaceId: "bens",
  });
  const claude = wakeOf("message-1", "claude"),
    codex = wakeOf("message-1", "codex");
  for (const wakeId of [claude, codex])
    storage.claimChatWake({ accountId: "ana", wakeId, installId: "mac", nowMs: NOW });
  const hints = (nowMs: number, messages = shown("message-1", "message-held", "message-quiet")) =>
    storage.phoneChatWakes({ accountId: "ana", workspaceId: "trip", messages, nowMs });

  expect(byWake(hints(NOW))).toEqual({
    [claude]: {
      wakeId: claude,
      messageId: "message-1",
      threadId: "thread-1",
      generation: 1,
      state: "claimed",
      winnerLabel: "mac label",
      // The Mac won, and declares nothing.
      agentName: null,
      canRetry: false,
    },
    [codex]: expect.objectContaining({ state: "claimed", canRetry: false }),
    [wakeOf("message-held", "claude")]: expect.objectContaining({
      state: "held",
      winnerLabel: null,
      canRetry: false,
    }),
  });
  const late = NOW + CHAT_WAKE_CONFIRM_MS;
  expect(byWake(hints(late)), "a claim past its time reads unconfirmed before a sweep").toEqual(
    expect.objectContaining({
      [claude]: expect.objectContaining({ state: "unconfirmed", canRetry: true }),
      [codex]: expect.objectContaining({
        state: "unconfirmed",
        winnerLabel: "mac label",
        canRetry: false,
      }),
    }),
  );
  expect(
    wakes(storage)
      .filter((row) => row.account_id === "ana" && row.message_id === "message-1")
      .map((row) => row.state),
    "the read writes nothing",
  ).toEqual(["claimed", "claimed"]);
  expect(JSON.stringify(hints(late))).not.toContain("laptop");

  expect(
    storage.retryChatWake({
      accountId: "ana",
      workspaceId: "trip",
      operationId: "retry-1",
      wakeId: claude,
      nowMs: late,
    }).kind,
  ).toBe("retried");
  const next = wakeOf("message-1", "claude", 2);
  const latest = byWake(hints(late));
  expect(latest[claude], "a superseded generation has no hint").toBeUndefined();
  expect(latest[next]).toEqual({
    wakeId: next,
    messageId: "message-1",
    threadId: "thread-1",
    generation: 2,
    state: "waiting",
    winnerLabel: null,
    // Its only candidate is the laptop's agent.
    agentName: "Claude",
    canRetry: false,
  });
  expect(latest[codex]).toMatchObject({ generation: 1, state: "unconfirmed" });

  expect(
    hints(late, new Map([["message-1", "thread-elsewhere"]])),
    "a wake whose thread isn't the one the message was read in",
  ).toEqual([]);
  expect(
    storage.phoneChatWakes({
      accountId: "ana",
      workspaceId: "bens",
      messages: shown("message-1"),
      nowMs: late,
    }),
    "another account's workspace",
  ).toEqual([]);
  expect(
    storage.phoneChatWakes({
      accountId: "ben",
      workspaceId: "trip",
      messages: shown("message-1"),
      nowMs: late,
    }),
  ).toEqual([]);
});

it("gives no hint once a wake's row is gone, rather than a guess", async () => {
  const storage = await relay();
  publish(storage, "op-old", "message-old", [target("claude", "mac")]);
  const hints = (nowMs: number) =>
    storage.phoneChatWakes({
      accountId: "ana",
      workspaceId: "trip",
      messages: shown("message-old"),
      nowMs,
    });
  const ended = NOW + CHAT_WAKE_CLAIM_MS;
  expect(storage.sweepChatWakes(ended)).toBe(1);
  expect(hints(ended)).toEqual([expect.objectContaining({ state: "unclaimed", canRetry: false })]);
  expect(storage.sweepChatWakes(ended + CHAT_WAKE_KEEP_MS + 1)).toBe(1);
  expect(hints(ended + CHAT_WAKE_KEEP_MS + 1)).toEqual([]);
});

it("names a wake's agent as its computer declares it now: the winner's, or else the first candidate's, by the wake's own account, workspace, computer, and agent", async () => {
  const storage = await relay();
  const context = storage as StorageContext;
  const declare = (
    installId: string,
    agents: Array<[agentId: string, displayName: string, enabled?: boolean]>,
    input: { accountId?: string; workspaceId?: string } = {},
  ) =>
    expect(
      storage.replaceChatRunners({
        accountId: input.accountId ?? "ana",
        workspaceId: input.workspaceId ?? "trip",
        installId,
        computerLabel: `${installId} label`,
        runners: agents.map(([agentId, displayName, enabled = true]) => ({
          agentId,
          handle: displayName.toLowerCase().replaceAll(" ", ""),
          displayName,
          enabled,
        })),
        nowMs: NOW,
      }),
    ).toBe(true);
  const implicit = (installId: string, agentId: string): ChatWakeTarget => ({
    target: `implicit:${installId}:${agentId}`,
    candidates: [
      { installId, agentId, label: `${installId} label`, matched: { displayName: "Old Name" } },
    ],
  });
  const hints = (nowMs: number, workspaceId = "trip", messageId = "message-1") =>
    storage.phoneChatWakes({ accountId: "ana", workspaceId, messages: shown(messageId), nowMs });
  const labels = (nowMs: number, workspaceId = "trip", messageId = "message-1") =>
    Object.fromEntries(
      hints(nowMs, workspaceId, messageId).map((hint) => [hint.wakeId, hint.agentName]),
    );
  const owner = (workspaceId: string, ownerUserId: string) =>
    context.db
      .prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?")
      .run(ownerUserId, workspaceId);

  publish(storage, "op-trip", "message-1", [
    target("claude", "mac", "laptop"),
    implicit("desk", "helper"),
    implicit("tablet", "helper"),
  ]);
  publish(storage, "op-other", "message-1", [target("claude", "mac"), implicit("desk", "helper")], {
    workspaceId: "other",
  });
  const claude = wakeOf("message-1", "claude"),
    desk = chatWakeId("ana", "trip", "message-1", "implicit:desk:helper", 1),
    tablet = chatWakeId("ana", "trip", "message-1", "implicit:tablet:helper", 1),
    otherClaude = wakeOf("message-1", "claude", 1, "other"),
    otherDesk = chatWakeId("ana", "other", "message-1", "implicit:desk:helper", 1);

  expect(labels(NOW), "no computer declares any of them").toEqual({
    [claude]: null,
    [desk]: null,
    [tablet]: null,
  });

  // The two candidates of one mention name their agents apart; before a claim only the first one's shows. Two
  // computers' agents of the same name stay two wakes.
  declare("mac", [["default", "Claude"]]);
  declare("laptop", [["default", "Claude Laptop"]]);
  declare("desk", [["helper", "Helper"]]);
  declare("tablet", [["helper", "Helper"]]);
  expect(labels(NOW)).toEqual({ [claude]: "Claude", [desk]: "Helper", [tablet]: "Helper" });
  for (const absent of ["Claude Laptop", "Old Name"])
    expect(JSON.stringify(hints(NOW))).not.toContain(absent);

  // Another workspace's wakes take only that workspace's declarations, and only their own account's: another account
  // that owned the workspace and declared the same computer and agent IDs names nothing.
  expect(labels(NOW, "other")).toEqual({ [otherClaude]: null, [otherDesk]: null });
  owner("other", "ben");
  declare("mac", [["default", "Ben's Claude"]], { accountId: "ben", workspaceId: "other" });
  declare("desk", [["helper", "Ben's Helper"]], { accountId: "ben", workspaceId: "other" });
  owner("other", "ana");
  expect(labels(NOW, "other")).toEqual({ [otherClaude]: null, [otherDesk]: null });
  declare("desk", [["helper", "Other Helper"]], { workspaceId: "other" });
  expect(labels(NOW, "other")).toEqual({ [otherClaude]: null, [otherDesk]: "Other Helper" });
  expect(labels(NOW)[desk]).toBe("Helper");

  // A rename names the old mention and implicit wakes anew, switched off and past its lease too. The reads write nothing.
  const head = storage.chatWakeHead("ana");
  const rows = wakes(storage);
  declare("mac", [["default", "Sonnet", false]]);
  declare("desk", [["helper", "Scout"]]);
  const leaseEnded = NOW + CHAT_RUNNER_LEASE_MS;
  expect(
    storage.enabledChatRunners({ accountId: "ana", workspaceId: "trip", nowMs: leaseEnded }),
  ).toEqual([]);
  expect(labels(leaseEnded)).toEqual({ [claude]: "Sonnet", [desk]: "Scout", [tablet]: "Helper" });
  expect(storage.chatWakeHead("ana")).toBe(head);
  expect(wakes(storage)).toEqual(rows);

  // Once a computer claims a wake, its agent names it.
  storage.claimChatWake({ accountId: "ana", wakeId: claude, installId: "laptop", nowMs: NOW + 1 });
  expect(labels(NOW + 1)[claude]).toBe("Claude Laptop");

  // A computer that stops declaring an agent leaves no name, not the one it had.
  declare("desk", []);
  expect(labels(NOW + 1)[desk]).toBeNull();
  for (const absent of ["Scout", "Helper", "Old Name"])
    expect(JSON.stringify(hints(NOW + 1).find((hint) => hint.wakeId === desk))).not.toContain(
      absent,
    );

  // A retry that leaves out the unconfirmed winner names the next generation by its new first candidate.
  publish(storage, "op-retry", "message-retry", [target("codex", "mac", "laptop")]);
  const first = wakeOf("message-retry", "codex");
  expect(labels(NOW + 1, "trip", "message-retry")).toEqual({ [first]: "Sonnet" });
  storage.claimChatWake({ accountId: "ana", wakeId: first, installId: "mac", nowMs: NOW + 1 });
  const late = NOW + 1 + CHAT_WAKE_CONFIRM_MS;
  expect(labels(late, "trip", "message-retry")).toEqual({ [first]: "Sonnet" });
  expect(
    storage.retryChatWake({
      accountId: "ana",
      workspaceId: "trip",
      operationId: "retry-1",
      wakeId: first,
      nowMs: late,
    }).kind,
  ).toBe("retried");
  expect(labels(late, "trip", "message-retry")).toEqual({
    [wakeOf("message-retry", "codex", 2)]: "Claude Laptop",
  });
});

it("lists the threads whose wakes changed after a position, only in the workspace named and only the account's own", async () => {
  const storage = await relay();
  const changes = (since: number, workspaceId = "trip", accountId = "ana") =>
    storage.chatWakeChanges({
      accountId,
      workspaceId,
      since,
      through: storage.chatWakeHead(accountId),
    });
  record(
    storage,
    "op-1",
  )({
    publish: {
      messageId: "message-1",
      threadId: "thread-a",
      held: false,
      targets: [target("claude", "mac")],
    },
  });
  record(
    storage,
    "op-2",
  )({
    publish: {
      messageId: "message-2",
      threadId: "thread-b",
      held: false,
      targets: [target("claude", "mac")],
    },
  });
  const published = storage.chatWakeHead("ana");
  expect(changes(0)).toEqual({ next: published, threadIds: ["thread-a", "thread-b"] });
  storage.claimChatWake({
    accountId: "ana",
    wakeId: wakeOf("message-2", "claude"),
    installId: "mac",
    nowMs: NOW,
  });
  expect(changes(published)).toEqual({ next: published + 1, threadIds: ["thread-b"] });

  publish(storage, "op-other", "message-other", [target("claude", "mac")], {
    workspaceId: "other",
  });
  expect(changes(published + 1), "a change in another workspace moves only the position").toEqual({
    next: published + 2,
    threadIds: [],
  });
  publish(storage, "op-ben", "message-ben", [target("claude", "mac")], {
    accountId: "ben",
    workspaceId: "bens",
  });
  expect(changes(0, "bens")).toEqual({ next: storage.chatWakeHead("ana"), threadIds: [] });
  expect(changes(0, "trip", "ben")).toEqual({ next: 1, threadIds: [] });
});

it("knows every agent of the account's computers only once each computer sent its list, leased or not", async () => {
  const storage = await relay();
  const context = storage as StorageContext;
  const names = () => storage.declaredAgentNames({ accountId: "ana", workspaceId: "trip" });
  const claude = { agentId: "default", handle: "claude", displayName: "Claude", enabled: true };
  const declare = (
    installId: string,
    runners: (typeof claude)[],
    agents?: { agentId: string; displayName: string }[] | null,
    nowMs = NOW,
  ) =>
    storage.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId,
      computerLabel: installId,
      runners,
      ...(agents === undefined ? {} : { agents }),
      nowMs,
    });

  // Nobody sent a list: unknown, so the phone changes nothing.
  expect(names()).toBeNull();
  // An older desktop's runners alone still say nothing of the agents it runs itself.
  declare("old-mac", [claude]);
  expect(names()).toBeNull();
  // A computer with no agents at all says so; the older one beside it still leaves the whole unknown.
  declare("pc", [], []);
  expect(names()).toBeNull();
  declare("old-mac", [claude], []);
  expect(names()).toEqual(new Map([["default", "Claude"]]));
  // A sleeping computer keeps its agents past the wake lease; the first by install ID names an agent both have.
  declare(
    "pc",
    [],
    [
      { agentId: "t3-code", displayName: "d3-code" },
      { agentId: "default", displayName: "Codex" },
    ],
  );
  expect(storage.declaredAgentNames({ accountId: "ana", workspaceId: "trip" })).toEqual(
    new Map([
      ["default", "Claude"],
      ["t3-code", "d3-code"],
    ]),
  );
  declare("old-mac", [claude], [], NOW + CHAT_RUNNER_LEASE_MS * 2);
  expect(names()?.get("default")).toBe("Claude");
  // Another account's or workspace's lists are apart.
  expect(storage.declaredAgentNames({ accountId: "ana", workspaceId: "other" })).toBeNull();
  // A computer that couldn't send its list leaves the whole unknown, whatever the others say.
  declare("laptop", [], null);
  expect(names()).toBeNull();
  declare("laptop", []);
  // A withdrawal takes the computer's list back.
  declare("pc", []);
  expect(names()).toEqual(new Map([["default", "Claude"]]));
  declare("old-mac", []);
  expect(names()).toBeNull();
  expect(count(storage, "sync_relay_chat_agent_lists")).toBe(0);

  // The list goes with its account.
  declare("pc", [], [{ agentId: "t3-code", displayName: "d3-code" }]);
  initializeAccountDeletion(context, "account-deletion-test-key");
  purgeAccountRows(context, "ana", "ana@dohc.test", {
    workspaces: [],
    shareIds: [],
    datasets: [],
    grantIds: [],
    publicationIds: [],
  });
  expect(count(storage, "sync_relay_chat_agent_lists")).toBe(0);
});

it("adds the agent lists to an older relay once", async () => {
  const storage = await testStorage();
  const path = storagePath(storage);
  closeTestStorage(storage);
  const older = inspectDatabase(path);
  older.exec(`DROP TABLE sync_relay_chat_agent_lists;
    DELETE FROM sync_relay_migrations WHERE migration_id = 'chat-agent-lists-v1';`);
  older.close();
  const upgraded = reopenTestStorage(path);
  upgraded.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
  upgraded.replaceChatRunners({
    accountId: "ana",
    workspaceId: "trip",
    installId: "pc",
    computerLabel: "PC",
    runners: [],
    agents: [{ agentId: "t3-code", displayName: "d3-code" }],
    nowMs: NOW,
  });
  expect(upgraded.declaredAgentNames({ accountId: "ana", workspaceId: "trip" })).toEqual(
    new Map([["t3-code", "d3-code"]]),
  );
  closeTestStorage(upgraded);
  expect(count(reopenTestStorage(path), "sync_relay_chat_agent_lists")).toBe(1);
});
