import { createHash } from "node:crypto";
import {
  CHAT_WAKE_PAGE_MAX,
  PHONE_CONTEXT_WAKES_MAX,
  type ChatWakeCandidate,
  type ChatWakeState,
  type ChatWakeView,
  type PhoneChatWake,
  type WaitingChatWake,
} from "@dohc/workspace-contracts/chat-wakes";
import { notifyChatWakeChange } from "../relayWriteChanges";
import type { StorageContext } from "./context";
import type { SqliteDb } from "./types";

const MARKER = "chat-wakes-v1";
const MEMORY_MARKER = "chat-runner-memory-v1";
const MEMORY_COLUMN = "memory INTEGER NOT NULL DEFAULT 0 CHECK (memory IN (0, 1))";
const RUNNERS = "sync_relay_chat_runners";
const WAKES = "sync_relay_chat_wakes";
const HEADS = "sync_relay_chat_wake_heads";
export const CHAT_WAKE_RETRIES = "sync_relay_chat_wake_retries";

// The whole chat wake schema. Nothing that existed before reads these tables.
//
// Runners: each of an owner's computers declares, per owned workspace, the
// agents it can run there. A row is one agent on one computer, keyed by the
// install ID, so equal agent IDs on two computers stay apart. The computer's
// label names a claim's winner. `memory` marks an agent that remembers earlier
// chats on that computer, which alone takes its wakes. A declaration holds for CHAT_RUNNER_LEASE_MS
// from `updated_at_ms`, which every declaration sets, the same one again
// included. A signed-in computer declares again about daily; one that doesn't
// stops being a wake target when its lease ends, and its rows stay until it
// declares again or a newer computer takes its place. Rows go with the
// workspace.
//
// Wakes: one row per wake target of a published phone message, or of the
// owner's browser post, per generation. A browser post's message ID is its
// operation ID. It names the message and its actual thread by ID and holds no
// message text. `candidates_json` is the frozen list of computers that may
// claim it: `[{installId, agentId, label, matched: {handle} | {displayName}}]`.
// Only one computer wins a row. A retry adds the next generation.
// `change_seq` is the account's head when the row last changed, which
// computers read after; the heads table holds each account's last
// `change_seq`. Rows go with the workspace, and 30 days after they end.
//
// Retries: each phone Try again that answered a generation, by the account
// and the phone's operation ID, with the wake it named and the generation it
// answered. It has no foreign key: it stays as long as the account, after its
// wakes or its workspace go, so a replay is told apart from a new request and
// its operation ID never names a write. Account deletion removes it.
const SCHEMA = {
  [RUNNERS]: `CREATE TABLE sync_relay_chat_runners (
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  install_id TEXT NOT NULL CHECK (length(install_id) BETWEEN 1 AND 256),
  computer_label TEXT NOT NULL CHECK (length(computer_label) BETWEEN 1 AND 64),
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 64),
  handle TEXT NOT NULL CHECK (length(handle) <= 200),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  ${MEMORY_COLUMN},
  PRIMARY KEY (workspace_id, account_id, install_id, agent_id)
) STRICT`,
  [WAKES]: `CREATE TABLE sync_relay_chat_wakes (
  wake_id TEXT NOT NULL PRIMARY KEY CHECK (length(wake_id) = 37 AND wake_id GLOB 'wake-*' AND substr(wake_id, 6) NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 256),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 600),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  candidates_json TEXT NOT NULL CHECK (json_valid(candidates_json) AND json_type(candidates_json) = 'array' AND json_array_length(candidates_json) >= 1),
  state TEXT NOT NULL CHECK (state IN ('held', 'waiting', 'claimed', 'queued', 'unclaimed', 'unconfirmed')),
  prerequisite_message_id TEXT CHECK (prerequisite_message_id IS NULL OR length(prerequisite_message_id) BETWEEN 1 AND 256),
  winner_install_id TEXT CHECK (winner_install_id IS NULL OR length(winner_install_id) BETWEEN 1 AND 256),
  winner_agent_id TEXT CHECK (winner_agent_id IS NULL OR length(winner_agent_id) BETWEEN 1 AND 64),
  winner_label TEXT CHECK (winner_label IS NULL OR length(winner_label) BETWEEN 1 AND 64),
  change_seq INTEGER NOT NULL CHECK (change_seq BETWEEN 1 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  waiting_since_ms INTEGER CHECK (waiting_since_ms IS NULL OR waiting_since_ms BETWEEN 0 AND 9007199254740991),
  claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR claimed_at_ms BETWEEN 0 AND 9007199254740991),
  ended_at_ms INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms BETWEEN 0 AND 9007199254740991),
  UNIQUE (account_id, workspace_id, message_id, target, generation),
  CHECK ((state = 'held') = (waiting_since_ms IS NULL)),
  CHECK ((state IN ('claimed', 'queued', 'unconfirmed')) = (winner_install_id IS NOT NULL)),
  CHECK ((winner_install_id IS NULL) = (winner_agent_id IS NULL) AND (winner_install_id IS NULL) = (winner_label IS NULL)
    AND (winner_install_id IS NULL) = (claimed_at_ms IS NULL)),
  CHECK ((state IN ('queued', 'unclaimed', 'unconfirmed')) = (ended_at_ms IS NOT NULL))
) STRICT`,
  [HEADS]: `CREATE TABLE sync_relay_chat_wake_heads (
  account_id TEXT NOT NULL PRIMARY KEY CHECK (length(account_id) BETWEEN 1 AND 256),
  head INTEGER NOT NULL CHECK (head BETWEEN 1 AND 9007199254740991)
) STRICT`,
  [CHAT_WAKE_RETRIES]: `CREATE TABLE sync_relay_chat_wake_retries (
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) >= 1),
  wake_id TEXT NOT NULL CHECK (length(wake_id) = 37),
  next_wake_id TEXT NOT NULL CHECK (length(next_wake_id) = 37),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (account_id, operation_id)
) STRICT`,
  idx_sync_relay_chat_wakes_changes: `CREATE INDEX idx_sync_relay_chat_wakes_changes
  ON sync_relay_chat_wakes(account_id, change_seq)`,
  idx_sync_relay_chat_wakes_operation: `CREATE INDEX idx_sync_relay_chat_wakes_operation
  ON sync_relay_chat_wakes(account_id, operation_id)`,
  idx_sync_relay_chat_wakes_waiting: `CREATE INDEX idx_sync_relay_chat_wakes_waiting
  ON sync_relay_chat_wakes(waiting_since_ms) WHERE state = 'waiting'`,
  idx_sync_relay_chat_wakes_claimed: `CREATE INDEX idx_sync_relay_chat_wakes_claimed
  ON sync_relay_chat_wakes(claimed_at_ms) WHERE state = 'claimed'`,
  idx_sync_relay_chat_wakes_ended: `CREATE INDEX idx_sync_relay_chat_wakes_ended
  ON sync_relay_chat_wakes(ended_at_ms) WHERE ended_at_ms IS NOT NULL`,
} as const;

const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

function assertSchema(db: SqliteDb): void {
  const objects = db
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE tbl_name IN (?, ?, ?, ?) AND sql IS NOT NULL ORDER BY name",
    )
    .all(RUNNERS, WAKES, HEADS, CHAT_WAKE_RETRIES);
  const expected = Object.keys(SCHEMA).sort();
  const schema: Record<string, string> = SCHEMA;
  if (
    objects.length !== expected.length ||
    objects.some(
      (row, index) =>
        row.name !== expected[index] ||
        typeof row.sql !== "string" ||
        normalize(row.sql) !== normalize(schema[row.name as string]!),
    )
  ) {
    throw new Error("chat wake schema is missing or damaged");
  }
}

export function initializeChatWakeSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?");
  if (marked.get(MARKER)) {
    if (!marked.get(MEMORY_MARKER)) {
      // SQLite adds the column after the last column, where SCHEMA has it.
      if (!db.prepare(`SELECT 1 FROM pragma_table_info('${RUNNERS}') WHERE name = 'memory'`).get())
        db.exec(`ALTER TABLE ${RUNNERS} ADD COLUMN ${MEMORY_COLUMN}`);
      db.prepare(
        "INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)",
      ).run(MEMORY_MARKER, Date.now());
    }
    assertSchema(db);
    return;
  }
  const names = Object.keys(SCHEMA);
  if (
    db
      .prepare(`SELECT 1 FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`)
      .get(...names)
  ) {
    throw new Error("unmarked chat wake schema already exists");
  }
  for (const sql of Object.values(SCHEMA)) db.exec(sql);
  assertSchema(db);
  for (const marker of [MARKER, MEMORY_MARKER])
    db.prepare(
      "INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)",
    ).run(marker, Date.now());
}

/** How long a wake waits for a claim before it is unclaimed. */
export const CHAT_WAKE_CLAIM_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a claimed wake waits for its winner's queued before it is unconfirmed. */
export const CHAT_WAKE_CONFIRM_MS = 24 * 60 * 60 * 1000;
// Agent lists: per owned workspace, each computer's agents that aren't runners, by name only, which with its runner
// rows is every agent the computer has there. A row says the computer still declares there; its list is NULL when the
// computer couldn't send it. No row is a withdrawal, or a desktop from before lists. The phone names agent chats from these and runner rows, and
// archives one whose agent no computer has. No lease: a computer that is off keeps its agents' chats where they are.
const AGENT_LISTS_MARKER = "chat-agent-lists-v1";
const AGENT_LISTS_SQL = `CREATE TABLE sync_relay_chat_agent_lists (
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 256),
  workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  install_id TEXT NOT NULL CHECK (length(install_id) BETWEEN 1 AND 256),
  agents_json TEXT CHECK (agents_json IS NULL OR (json_valid(agents_json) AND json_type(agents_json) = 'array')),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (workspace_id, account_id, install_id)
) STRICT`;

export function initializeChatAgentListSchema(db: SqliteDb): void {
  if (
    db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(AGENT_LISTS_MARKER)
  )
    return;
  db.exec(AGENT_LISTS_SQL);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    AGENT_LISTS_MARKER,
    Date.now(),
  );
}

/** How long a wake is kept once it ends. */
export const CHAT_WAKE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long a computer's declaration names it as a wake target without another. Computers declare again about
 * daily (the desktop's CHAT_RUNNER_REFRESH_MS), so a few missed days of a computer that is off don't drop it.
 */
export const CHAT_RUNNER_LEASE_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * The computers one account declares per workspace. A new one past this replaces the one heard from longest ago,
 * so a computer whose lease ended goes first.
 */
const CHAT_RUNNER_COMPUTERS = 32;
/** The most rows one sweep call changes; the caller repeats until fewer come back. */
const CHAT_WAKE_SWEEP_BATCH = 1_000;

/** One computer's agent, as its owner declared it. */
export interface ChatRunner {
  installId: string;
  computerLabel: string;
  agentId: string;
  /** The handle of the display name, normalized; empty when the name has none. */
  handle: string;
  displayName: string;
  enabled: boolean;
  /** The agent remembers earlier chats on this computer. */
  memory?: boolean;
}

/** One of a computer's agents that dohc doesn't start: only its name. */
export interface DeclaredAgent {
  agentId: string;
  displayName: string;
}

/** One wake target, frozen when its message was written. */
export type ChatWakeTarget = { target: string; candidates: ChatWakeCandidate[] };

/** The targets the owner's browser post wakes, resolved before its append and written with it. */
export interface BrowserPostWakes {
  accountId: string;
  threadId: string;
  targets: readonly ChatWakeTarget[];
  nowMs: number;
}

/** What a recorded verdict does to its operation's wakes. Applied in the verdict's own transaction. */
export interface OperationWakeChange {
  /** Each target becomes a row once the message is published, held for an answer until its decision has an outcome. */
  publish?: {
    messageId: string;
    threadId: string;
    held: boolean;
    targets: readonly ChatWakeTarget[];
  };
  /** The decision has an outcome: held rows wait for a computer, syncing through the question's decision when it was accepted. */
  release?: { prerequisite: string | null };
}

export type ChatWakeRetry =
  | { kind: "retried"; wake: ChatWakeView }
  /** The operation ID names another write or another retry. */
  | { kind: "mismatch" }
  /** No such wake for this account in this workspace. */
  | { kind: "missing" }
  /** A repeat whose generation is gone. */
  | { kind: "too-old" }
  /** Not a latest generation that didn't start or wasn't confirmed, or no candidate is left. */
  | { kind: "refused" };

type Row = Record<string, unknown>;

/** A wake's ID: its account, workspace, message, target, and generation. */
export function chatWakeId(
  accountId: string,
  workspaceId: string,
  messageId: string,
  target: string,
  generation: number,
): string {
  return `wake-${createHash("sha256")
    .update(JSON.stringify([accountId, workspaceId, messageId, target, generation]))
    .digest("hex")
    .slice(0, 32)}`;
}

const candidatesOf = (row: Row) => JSON.parse(String(row.candidates_json)) as ChatWakeCandidate[];
const nullableString = (value: unknown) => (value === null ? null : String(value));

function viewOf(row: Row): ChatWakeView {
  return {
    wakeId: String(row.wake_id),
    workspaceId: String(row.workspace_id),
    messageId: String(row.message_id),
    threadId: String(row.thread_id),
    generation: Number(row.generation),
    state: String(row.state) as ChatWakeState,
    prerequisiteMessageId: nullableString(row.prerequisite_message_id),
    winnerLabel: nullableString(row.winner_label),
  };
}

// The account's next change sequence, which the caller's row takes. Inside the caller's write transaction.
function bump(storage: StorageContext, accountId: string): number {
  return Number(
    storage.db
      .prepare(
        `INSERT INTO sync_relay_chat_wake_heads (account_id, head) VALUES (?, 1)
     ON CONFLICT (account_id) DO UPDATE SET head = head + 1 RETURNING head`,
      )
      .get(accountId)!.head,
  );
}

const headOf = (storage: StorageContext, accountId: string) =>
  Number(
    storage.db
      .prepare("SELECT head FROM sync_relay_chat_wake_heads WHERE account_id = ?")
      .get(accountId)?.head ?? 0,
  );

// A wake of the account in a workspace it owns now. Another account's, or one in a workspace it no longer owns, is absent.
const OWNED = `SELECT c.* FROM sync_relay_chat_wakes c
  JOIN sync_relay_workspaces w ON w.workspace_id = c.workspace_id AND w.owner_user_id = c.account_id`;

// The state a row ends in once its wait ran out at `nowMs`: no claim in 7 days, or no queued 24 hours after its claim.
// Null while its wait holds, or for a row that isn't waiting.
function expiredState(row: Row, nowMs: number): "unclaimed" | "unconfirmed" | null {
  return row.state === "waiting" && Number(row.waiting_since_ms) + CHAT_WAKE_CLAIM_MS <= nowMs
    ? "unclaimed"
    : row.state === "claimed" && Number(row.claimed_at_ms) + CHAT_WAKE_CONFIRM_MS <= nowMs
      ? "unconfirmed"
      : null;
}

// The candidates a retry of an ended row in `state` takes: its frozen ones, less an unconfirmed winner, whose
// declaration of that agent is enabled and still leased at `nowMs`. A computer that quit after signing out, or never
// came back, can't take the retry the person asked for.
function retryCandidates(
  storage: StorageContext,
  row: Row,
  state: "unclaimed" | "unconfirmed",
  nowMs: number,
): ChatWakeCandidate[] {
  const leased = storage.db.prepare(
    `SELECT 1 FROM sync_relay_chat_runners WHERE workspace_id = ? AND account_id = ? AND install_id = ? AND agent_id = ?
       AND enabled = 1 AND updated_at_ms > ?`,
  );
  return candidatesOf(row).filter(
    (each) =>
      (state !== "unconfirmed" || each.installId !== row.winner_install_id) &&
      leased.get(
        row.workspace_id,
        row.account_id,
        each.installId,
        each.agentId,
        nowMs - CHAT_RUNNER_LEASE_MS,
      ) !== undefined,
  );
}

// Ends a row whose wait ran out. Inside a write transaction.
function expire(storage: StorageContext, row: Row, nowMs: number): Row {
  const state = expiredState(row, nowMs);
  if (state === null) return row;
  storage.db
    .prepare(
      "UPDATE sync_relay_chat_wakes SET state = ?, ended_at_ms = ?, change_seq = ? WHERE wake_id = ?",
    )
    .run(state, nowMs, bump(storage, String(row.account_id)), row.wake_id);
  notifyChatWakeChange(storage, String(row.account_id));
  return storage.db
    .prepare("SELECT * FROM sync_relay_chat_wakes WHERE wake_id = ?")
    .get(row.wake_id)!;
}

/**
 * Replaces one computer's declared agents in a workspace the account owns,
 * and starts its lease again at `nowMs`, even when nothing changed. Answers
 * false, writing nothing, when it doesn't own it. A computer new to the
 * workspace past CHAT_RUNNER_COMPUTERS replaces the one heard from longest
 * ago.
 */
export function replaceChatRunners(
  storage: StorageContext,
  input: {
    accountId: string;
    workspaceId: string;
    installId: string;
    computerLabel: string;
    runners: readonly Omit<ChatRunner, "installId" | "computerLabel">[];
    /** The computer's other agents; null when it couldn't send them; absent in a withdrawal or from an older desktop. */
    agents?: readonly DeclaredAgent[] | null;
    nowMs: number;
  },
): boolean {
  return storage.tx(() => {
    if (
      !storage.db
        .prepare("SELECT 1 FROM sync_relay_workspaces WHERE workspace_id = ? AND owner_user_id = ?")
        .get(input.workspaceId, input.accountId)
    ) {
      return false;
    }
    storage.db
      .prepare(
        "DELETE FROM sync_relay_chat_runners WHERE workspace_id = ? AND account_id = ? AND install_id = ?",
      )
      .run(input.workspaceId, input.accountId, input.installId);
    const insert = storage.db.prepare(
      `INSERT INTO sync_relay_chat_runners (account_id, workspace_id, install_id, computer_label, agent_id, handle, display_name, enabled, updated_at_ms, memory)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const runner of input.runners) {
      insert.run(
        input.accountId,
        input.workspaceId,
        input.installId,
        input.computerLabel,
        runner.agentId,
        runner.handle,
        runner.displayName,
        runner.enabled ? 1 : 0,
        input.nowMs,
        runner.memory ? 1 : 0,
      );
    }
    if (input.agents === undefined) {
      storage.db
        .prepare(
          "DELETE FROM sync_relay_chat_agent_lists WHERE workspace_id = ? AND account_id = ? AND install_id = ?",
        )
        .run(input.workspaceId, input.accountId, input.installId);
    } else {
      storage.db
        .prepare(
          `INSERT INTO sync_relay_chat_agent_lists (account_id, workspace_id, install_id, agents_json, updated_at_ms)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id, account_id, install_id)
           DO UPDATE SET agents_json = excluded.agents_json, updated_at_ms = excluded.updated_at_ms`,
        )
        .run(
          input.accountId,
          input.workspaceId,
          input.installId,
          input.agents === null ? null : JSON.stringify(input.agents),
          input.nowMs,
        );
    }
    storage.db
      .prepare(
        `DELETE FROM sync_relay_chat_agent_lists WHERE workspace_id = ? AND account_id = ? AND install_id IN (
         SELECT install_id FROM sync_relay_chat_agent_lists WHERE workspace_id = ? AND account_id = ?
         ORDER BY updated_at_ms DESC, install_id LIMIT -1 OFFSET ?)`,
      )
      .run(
        input.workspaceId,
        input.accountId,
        input.workspaceId,
        input.accountId,
        CHAT_RUNNER_COMPUTERS,
      );
    storage.db
      .prepare(
        `DELETE FROM sync_relay_chat_runners WHERE workspace_id = ? AND account_id = ? AND install_id IN (
         SELECT install_id FROM sync_relay_chat_runners WHERE workspace_id = ? AND account_id = ?
         GROUP BY install_id ORDER BY MAX(updated_at_ms) DESC, install_id LIMIT -1 OFFSET ?)`,
      )
      .run(
        input.workspaceId,
        input.accountId,
        input.workspaceId,
        input.accountId,
        CHAT_RUNNER_COMPUTERS,
      );
    return true;
  });
}

/**
 * Every agent the account's computers have in the workspace, by ID, with its name, leased or not. Null when that isn't
 * known: no computer sent its list, one couldn't, or one that has runners sent none. Where two computers name an agent apart, the
 * first by install ID names it, so a daily renewal never changes the name.
 */
export function declaredAgentNames(
  storage: StorageContext,
  input: { accountId: string; workspaceId: string },
): Map<string, string> | null {
  return storage.readTx(() => {
    const args = [input.workspaceId, input.accountId] as const;
    const lists = storage.db
      .prepare(
        "SELECT install_id, agents_json FROM sync_relay_chat_agent_lists WHERE workspace_id = ? AND account_id = ?",
      )
      .all(...args);
    if (lists.some((row) => row.agents_json === null)) return null;
    const listed = new Set(lists.map((row) => String(row.install_id)));
    const agents = storage.db
      .prepare(
        `SELECT install_id, agent_id, display_name FROM sync_relay_chat_runners WHERE workspace_id = ? AND account_id = ?
         UNION ALL
         SELECT l.install_id, json_extract(a.value, '$.agentId'), json_extract(a.value, '$.displayName')
         FROM sync_relay_chat_agent_lists l, json_each(l.agents_json) a WHERE l.workspace_id = ? AND l.account_id = ?
         ORDER BY 1`,
      )
      .all(...args, ...args);
    if (listed.size === 0 || agents.some((row) => !listed.has(String(row.install_id)))) return null;
    const names = new Map<string, string>();
    for (const row of agents)
      if (!names.has(String(row.agent_id)))
        names.set(String(row.agent_id), String(row.display_name));
    return names;
  });
}

/**
 * The account's enabled agents on its computers in the workspace, whose declarations' leases hold at `nowMs`.
 * Every new wake target and its candidates come from here. A retry starts from the frozen candidates of the
 * generation it answers, and keeps only those whose declaration is enabled and still leased (retryChatWake).
 */
export function enabledChatRunners(
  storage: StorageContext,
  input: { accountId: string; workspaceId: string; nowMs: number },
): ChatRunner[] {
  return storage.readTx(() =>
    storage.db
      .prepare(
        `SELECT install_id, computer_label, agent_id, handle, display_name, memory FROM sync_relay_chat_runners
     WHERE workspace_id = ? AND account_id = ? AND enabled = 1 AND updated_at_ms > ? ORDER BY install_id, agent_id`,
      )
      .all(input.workspaceId, input.accountId, input.nowMs - CHAT_RUNNER_LEASE_MS)
      .map((row) => ({
        installId: String(row.install_id),
        computerLabel: String(row.computer_label),
        agentId: String(row.agent_id),
        handle: String(row.handle),
        displayName: String(row.display_name),
        enabled: true,
        memory: Number(row.memory) === 1,
      })),
  );
}

function insertWakeRows(
  storage: StorageContext,
  wake: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    messageId: string;
    threadId: string;
    held: boolean;
    targets: readonly ChatWakeTarget[];
  },
  nowMs: number,
): boolean {
  const { accountId, workspaceId, messageId, held } = wake;
  const exists = storage.db.prepare(
    "SELECT 1 FROM sync_relay_chat_wakes WHERE account_id = ? AND workspace_id = ? AND message_id = ? AND target = ? AND generation = 1",
  );
  const insert = storage.db.prepare(
    `INSERT INTO sync_relay_chat_wakes (wake_id, account_id, workspace_id, operation_id, message_id, thread_id, target, generation,
       candidates_json, state, change_seq, created_at_ms, waiting_since_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  );
  let changed = false;
  for (const { target, candidates } of wake.targets) {
    if (exists.get(accountId, workspaceId, messageId, target)) continue;
    insert.run(
      chatWakeId(accountId, workspaceId, messageId, target, 1),
      accountId,
      workspaceId,
      wake.operationId,
      messageId,
      wake.threadId,
      target,
      JSON.stringify(candidates),
      held ? "held" : "waiting",
      bump(storage, accountId),
      nowMs,
      held ? null : nowMs,
    );
    changed = true;
  }
  return changed;
}

/**
 * The wake rows of the owner's browser post, in the transaction that appends
 * it. The post's message ID stands for its operation, and nothing holds it.
 */
export function insertBrowserWakesInTransaction(
  storage: StorageContext,
  wake: BrowserPostWakes & { workspaceId: string; messageId: string },
): void {
  const { nowMs, ...rest } = wake;
  if (insertWakeRows(storage, { ...rest, operationId: wake.messageId, held: false }, nowMs))
    notifyChatWakeChange(storage, wake.accountId);
}

/**
 * Applies a verdict's wake change to an operation, inside the transaction
 * that records the verdict: a published message's targets become rows, and
 * an answer's held rows are released.
 */
export function applyOperationWakesInTransaction(
  storage: StorageContext,
  operation: {
    accountId: string;
    operationId: string;
    workspaceId: string;
    messagePublished: boolean;
  },
  change: OperationWakeChange,
  nowMs: number,
): void {
  const { accountId, operationId, workspaceId } = operation;
  let changed =
    change.publish !== undefined &&
    operation.messagePublished &&
    insertWakeRows(storage, { accountId, workspaceId, operationId, ...change.publish }, nowMs);
  if (change.release !== undefined) {
    const update = storage.db.prepare(
      `UPDATE sync_relay_chat_wakes SET state = 'waiting', waiting_since_ms = ?, prerequisite_message_id = ?, change_seq = ?
       WHERE wake_id = ?`,
    );
    for (const row of storage.db
      .prepare(
        "SELECT wake_id FROM sync_relay_chat_wakes WHERE account_id = ? AND operation_id = ? AND state = 'held'",
      )
      .all(accountId, operationId)) {
      update.run(nowMs, change.release.prerequisite, bump(storage, accountId), row.wake_id);
      changed = true;
    }
  }
  if (changed) notifyChatWakeChange(storage, accountId);
}

/** Whether a retry used this operation ID. Inside the caller's transaction. */
export function retryUsesOperationIdInTransaction(
  storage: StorageContext,
  accountId: string,
  operationId: string,
): boolean {
  return Boolean(
    storage.db
      .prepare(
        "SELECT 1 FROM sync_relay_chat_wake_retries WHERE account_id = ? AND operation_id = ?",
      )
      .get(accountId, operationId),
  );
}

/**
 * The threads of every wake a retry could answer, each read through its own
 * wake ID: the wake it names, and the generation a matching binding of its
 * operation ID answered, which can outlive the named wake. Only wakes the
 * account has in a workspace it owns count.
 */
export function retryWakeThreads(
  storage: StorageContext,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    wakeId: string;
  },
): string[] {
  return storage.readTx(() => {
    const bound = storage.db
      .prepare(
        "SELECT next_wake_id FROM sync_relay_chat_wake_retries WHERE account_id = ? AND operation_id = ? AND workspace_id = ? AND wake_id = ?",
      )
      .get(input.accountId, input.operationId, input.workspaceId, input.wakeId);
    const thread = storage.db.prepare(
      `${OWNED} WHERE c.wake_id = ? AND c.account_id = ? AND c.workspace_id = ?`,
    );
    const threads = [
      input.wakeId,
      ...(bound === undefined ? [] : [String(bound.next_wake_id)]),
    ].flatMap((wakeId) => {
      const row = thread.get(wakeId, input.accountId, input.workspaceId);
      return row === undefined ? [] : [String(row.thread_id)];
    });
    return [...new Set(threads)];
  });
}

/** The account's change head for its wakes. */
export function chatWakeHead(storage: StorageContext, accountId: string): number {
  return storage.readTx(() => headOf(storage, accountId));
}

// The message IDs one statement names at most.
const MESSAGE_BATCH = 500;
const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

/**
 * The latest generation of each wake target of the given messages, for the
 * phone: only rows of the account in a workspace it owns, whose thread is the
 * one the caller read each message in. A row whose wait ran out reads as the
 * state it ends in, before a sweep writes it. A swept row, or one never made,
 * has no hint. Each names its agent as that account's computer declares it
 * now, or null. Nothing here names a computer's install ID or candidates. At
 * most PHONE_CONTEXT_WAKES_MAX hints answer.
 */
export function phoneChatWakes(
  storage: StorageContext,
  input: {
    accountId: string;
    workspaceId: string;
    /** Each shown message's ID, to the thread it was read in. */
    messages: ReadonlyMap<string, string>;
    nowMs: number;
  },
): PhoneChatWake[] {
  return storage.readTx(() => {
    // The agent's current name, by the wake row's own full key. Enabled or not, leased or not.
    const declared = storage.db.prepare(
      `SELECT display_name FROM sync_relay_chat_runners
       WHERE account_id = ? AND workspace_id = ? AND install_id = ? AND agent_id = ?`,
    );
    const agentName = (row: Row): string | null => {
      const { installId, agentId } =
        row.winner_install_id === null
          ? candidatesOf(row)[0]!
          : { installId: row.winner_install_id, agentId: row.winner_agent_id };
      const found = declared.get(row.account_id, row.workspace_id, installId, agentId);
      return found === undefined ? null : String(found.display_name);
    };
    const ids = [...input.messages.keys()];
    const hints: PhoneChatWake[] = [];
    for (let start = 0; start < ids.length; start += MESSAGE_BATCH) {
      const batch = ids.slice(start, start + MESSAGE_BATCH);
      const rows = storage.db
        .prepare(
          `${OWNED} WHERE c.account_id = ? AND c.workspace_id = ? AND c.message_id IN (${placeholders(batch.length)})
           AND c.generation = (SELECT MAX(d.generation) FROM sync_relay_chat_wakes d WHERE d.account_id = c.account_id
             AND d.workspace_id = c.workspace_id AND d.message_id = c.message_id AND d.target = c.target)
         ORDER BY c.message_id, c.created_at_ms, c.wake_id`,
        )
        .all(input.accountId, input.workspaceId, ...batch);
      for (const row of rows) {
        if (hints.length === PHONE_CONTEXT_WAKES_MAX) return hints;
        if (input.messages.get(String(row.message_id)) !== String(row.thread_id)) continue;
        const ended = expiredState(row, input.nowMs);
        const state = ended ?? (String(row.state) as ChatWakeState);
        hints.push({
          wakeId: String(row.wake_id),
          messageId: String(row.message_id),
          threadId: String(row.thread_id),
          generation: Number(row.generation),
          state,
          winnerLabel: nullableString(row.winner_label),
          agentName: agentName(row),
          canRetry:
            (state === "unclaimed" || state === "unconfirmed") &&
            retryCandidates(storage, row, state, input.nowMs).length > 0,
        });
      }
    }
    return hints;
  });
}

/** The most changed rows one call of chatWakeChanges reads. */
export const CHAT_WAKE_CHANGES_PAGE = 1_000;

/**
 * The threads of the account's wakes in a workspace it owns whose rows
 * changed after `since`, through `through`, oldest change first. `next` is
 * `through`, or the last row's change when the page is full.
 */
export function chatWakeChanges(
  storage: StorageContext,
  input: { accountId: string; workspaceId: string; since: number; through: number },
): { next: number; threadIds: string[] } {
  return storage.readTx(() => {
    const rows = storage.db
      .prepare(
        `${OWNED} WHERE c.account_id = ? AND c.workspace_id = ? AND c.change_seq > ? AND c.change_seq <= ?
         ORDER BY c.change_seq LIMIT ?`,
      )
      .all(input.accountId, input.workspaceId, input.since, input.through, CHAT_WAKE_CHANGES_PAGE);
    return {
      next:
        rows.length === CHAT_WAKE_CHANGES_PAGE ? Number(rows.at(-1)!.change_seq) : input.through,
      threadIds: [...new Set(rows.map((row) => String(row.thread_id)))],
    };
  });
}

/**
 * The waiting wakes that list this computer among their candidates, in
 * workspaces the account owns, that changed after `since`, oldest change
 * first. The cursor is the head, or the last row's change when the page is
 * full. A `since` past the head starts again from nothing.
 */
export function listWaitingChatWakes(
  storage: StorageContext,
  input: {
    accountId: string;
    installId: string;
    since: number;
    nowMs: number;
  },
): { cursor: number; wakes: WaitingChatWake[] } {
  return storage.readTx(() => {
    const head = headOf(storage, input.accountId);
    const since = input.since > head ? 0 : input.since;
    const rows = storage.db
      .prepare(
        `${OWNED} WHERE c.account_id = ? AND c.change_seq > ? AND c.state = 'waiting' AND c.waiting_since_ms > ?
         AND EXISTS (SELECT 1 FROM json_each(c.candidates_json) e WHERE json_extract(e.value, '$.installId') = ?)
       ORDER BY c.change_seq LIMIT ?`,
      )
      .all(
        input.accountId,
        since,
        input.nowMs - CHAT_WAKE_CLAIM_MS,
        input.installId,
        CHAT_WAKE_PAGE_MAX,
      );
    return {
      cursor: rows.length === CHAT_WAKE_PAGE_MAX ? Number(rows.at(-1)!.change_seq) : head,
      wakes: rows.map((row) => ({
        ...viewOf(row),
        state: "waiting" as const,
        candidate: candidatesOf(row).find((each) => each.installId === input.installId)!,
      })),
    };
  });
}

/**
 * Claims a waiting wake for one of its candidates. The first claim of a
 * generation wins; a later one answers the winner. A held wake can't be
 * claimed. Null when the account has no such wake in a workspace it owns, or
 * the computer isn't a candidate.
 */
export function claimChatWake(
  storage: StorageContext,
  input: {
    accountId: string;
    wakeId: string;
    installId: string;
    nowMs: number;
  },
): { won: boolean; wake: ChatWakeView } | null {
  return storage.tx(() => {
    const found = storage.db
      .prepare(`${OWNED} WHERE c.wake_id = ? AND c.account_id = ?`)
      .get(input.wakeId, input.accountId);
    const candidate =
      found === undefined
        ? undefined
        : candidatesOf(found).find((each) => each.installId === input.installId);
    if (found === undefined || candidate === undefined) return null;
    let row = expire(storage, found, input.nowMs);
    if (row.state === "waiting") {
      storage.db
        .prepare(
          `UPDATE sync_relay_chat_wakes SET state = 'claimed', winner_install_id = ?, winner_agent_id = ?, winner_label = ?, claimed_at_ms = ?,
           change_seq = ? WHERE wake_id = ?`,
        )
        .run(
          candidate.installId,
          candidate.agentId,
          candidate.label,
          input.nowMs,
          bump(storage, input.accountId),
          input.wakeId,
        );
      notifyChatWakeChange(storage, input.accountId);
      row = storage.db
        .prepare("SELECT * FROM sync_relay_chat_wakes WHERE wake_id = ?")
        .get(input.wakeId)!;
    }
    return { won: row.winner_install_id === input.installId, wake: viewOf(row) };
  });
}

/**
 * The winner confirms it recorded the trigger, from claimed or, late, from
 * unconfirmed. Null when the account has no such wake in a workspace it owns,
 * or this computer didn't win it.
 */
export function confirmChatWakeQueued(
  storage: StorageContext,
  input: {
    accountId: string;
    wakeId: string;
    installId: string;
    nowMs: number;
  },
): ChatWakeView | null {
  return storage.tx(() => {
    const row = storage.db
      .prepare(`${OWNED} WHERE c.wake_id = ? AND c.account_id = ?`)
      .get(input.wakeId, input.accountId);
    if (row === undefined || row.winner_install_id !== input.installId) return null;
    if (row.state === "claimed" || row.state === "unconfirmed") {
      storage.db
        .prepare(
          "UPDATE sync_relay_chat_wakes SET state = 'queued', ended_at_ms = ?, change_seq = ? WHERE wake_id = ?",
        )
        .run(input.nowMs, bump(storage, input.accountId), input.wakeId);
      notifyChatWakeChange(storage, input.accountId);
    }
    return viewOf(
      storage.db
        .prepare("SELECT * FROM sync_relay_chat_wakes WHERE wake_id = ?")
        .get(input.wakeId)!,
    );
  });
}

/**
 * Try again: the next generation of a wake that didn't start or wasn't
 * confirmed, in one transaction. Each answered generation binds the
 * operation ID to the wake it named: a repeat answers the same generation,
 * or too old once that is gone, and the ID used for anything else is a
 * mismatch. A superseded generation answers its next row. The new
 * generation keeps the candidates, less an unconfirmed winner, and is never
 * made with none. The old row stays as it is.
 */
export function retryChatWake(
  storage: StorageContext,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    wakeId: string;
    nowMs: number;
  },
): ChatWakeRetry {
  const { accountId, workspaceId, operationId, nowMs } = input;
  return storage.tx(() => {
    const owned = (wakeId: string) =>
      storage.db
        .prepare(`${OWNED} WHERE c.wake_id = ? AND c.account_id = ?`)
        .get(wakeId, accountId);
    const bound = storage.db
      .prepare(
        "SELECT * FROM sync_relay_chat_wake_retries WHERE account_id = ? AND operation_id = ?",
      )
      .get(accountId, operationId);
    if (bound !== undefined) {
      if (bound.workspace_id !== workspaceId || bound.wake_id !== input.wakeId)
        return { kind: "mismatch" };
      const answered = owned(String(bound.next_wake_id));
      return answered === undefined
        ? { kind: "too-old" }
        : { kind: "retried", wake: viewOf(answered) };
    }
    if (
      storage.db
        .prepare(
          "SELECT 1 FROM sync_relay_account_operations WHERE account_id = ? AND operation_id = ?",
        )
        .get(accountId, operationId)
    ) {
      return { kind: "mismatch" };
    }
    const found = storage.db
      .prepare(`${OWNED} WHERE c.wake_id = ? AND c.account_id = ? AND c.workspace_id = ?`)
      .get(input.wakeId, accountId, workspaceId);
    if (found === undefined) return { kind: "missing" };
    const generation = Number(found.generation) + 1;
    const nextId = chatWakeId(
      accountId,
      workspaceId,
      String(found.message_id),
      String(found.target),
      generation,
    );
    const answer = (): ChatWakeRetry => {
      storage.db
        .prepare(
          `INSERT INTO sync_relay_chat_wake_retries (account_id, operation_id, workspace_id, wake_id, next_wake_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(accountId, operationId, workspaceId, input.wakeId, nextId, nowMs);
      return { kind: "retried", wake: viewOf(owned(nextId)!) };
    };
    if (owned(nextId) !== undefined) return answer();
    const source = expire(storage, found, nowMs);
    const ended = source.state;
    if (ended !== "unclaimed" && ended !== "unconfirmed") return { kind: "refused" };
    const candidates = retryCandidates(storage, source, ended, nowMs);
    if (candidates.length === 0) return { kind: "refused" };
    storage.db
      .prepare(
        `INSERT INTO sync_relay_chat_wakes (wake_id, account_id, workspace_id, operation_id, message_id, thread_id, target, generation,
         candidates_json, state, prerequisite_message_id, change_seq, created_at_ms, waiting_since_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
      )
      .run(
        nextId,
        accountId,
        workspaceId,
        source.operation_id,
        source.message_id,
        source.thread_id,
        source.target,
        generation,
        JSON.stringify(candidates),
        source.prerequisite_message_id,
        bump(storage, accountId),
        nowMs,
        nowMs,
      );
    notifyChatWakeChange(storage, accountId);
    return answer();
  });
}

/**
 * Ends wakes whose wait ran out, then deletes those ended more than
 * CHAT_WAKE_KEEP_MS ago, at most CHAT_WAKE_SWEEP_BATCH rows of each. Answers
 * how many rows it changed.
 */
export function sweepChatWakes(storage: StorageContext, nowMs: number): number {
  return storage.tx(() => {
    const due = storage.db
      .prepare(
        `SELECT * FROM (SELECT * FROM sync_relay_chat_wakes WHERE state = 'waiting' AND waiting_since_ms <= ? LIMIT ?)
       UNION ALL SELECT * FROM (SELECT * FROM sync_relay_chat_wakes WHERE state = 'claimed' AND claimed_at_ms <= ? LIMIT ?)`,
      )
      .all(
        nowMs - CHAT_WAKE_CLAIM_MS,
        CHAT_WAKE_SWEEP_BATCH,
        nowMs - CHAT_WAKE_CONFIRM_MS,
        CHAT_WAKE_SWEEP_BATCH,
      );
    for (const row of due) expire(storage, row, nowMs);
    const deleted = Number(
      storage.db
        .prepare(
          `DELETE FROM sync_relay_chat_wakes WHERE rowid IN (SELECT rowid FROM sync_relay_chat_wakes
         WHERE ended_at_ms IS NOT NULL AND ended_at_ms < ? LIMIT ?)`,
        )
        .run(nowMs - CHAT_WAKE_KEEP_MS, CHAT_WAKE_SWEEP_BATCH).changes,
    );
    return due.length + deleted;
  });
}
