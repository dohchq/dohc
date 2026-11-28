import type { AccountState, SignIn } from "./account";
import { isFields, text } from "./api";
import {
  derivedMessageId,
  isRefusalReason,
  readChatWrite,
  sendWrite,
  type ChatWrite,
  type RefusalReason,
  type WriteAnswer,
} from "./chatWrites";
import { ServerError } from "./client";
import { sleep as timerSleep } from "./deviceFlow";
import { deleteAccountRows, StoreError, type KeptStore, type Row, type Sql } from "./keptStore";
import type { ChatMessage } from "./workspaceReads";

// The phone's outbox: chat writes the person made, kept on disk until the server has them and a read shows them.
// It is one account-level store beside the read cache, never inside a workspace's store, so switching workspace
// doesn't touch it.
//
// Each write is one row of kept.db (keptStore.ts). Enqueue inserts it withheld, so its first durable form never
// sends. Only once that commit has returned does a second commit make it sendable: its sender's "sending" mark when it
// can send at once, or a commit of its own when it waits its turn. Enqueue resolves as kept only once that second
// commit has returned. When either commit fails, the record stays withheld in memory and enqueue rejects as
// `indeterminate`: it is sent only after `retryEnqueue` with the same operation ID. A relaunch can send it unasked only
// when the second commit failed yet stood; the record then says so (`maySendOnReopen`), until a later commit of it
// returns. Nothing here deletes a record except a read that shows its result,
// `discard`, and Sign out. A row that can't be read is kept, and `discard` deletes it only by the handle `state()` gives
// for it.
//
// `discard` deletes one record from this phone. It can't take back a write the server may already have. It first
// writes a record that may still send as withheld, and keeps it withheld in memory whatever that write and the delete
// do, so a late answer or a failed discard doesn't send it again in this run. A relaunch can't send it once either the
// withheld version or the delete is committed. When neither is, discard rejects as `withheld-in-memory`, because a
// relaunch may send it. It refuses a write that a waiting reply still needs.
//
// Only a sign-in with the record's own server and account sends it. Within each account, workspace, and thread or
// stream, only the oldest unfinished record runs, and none while another of that lane's records is running. A reaction
// waits its turn in its message's thread. A reply to a post or send still in the outbox waits until that write is
// saved, then takes the thread its result names. A record that may have reached the server is asked again with the
// same operation ID and arguments until it's saved or refused, so it is written at most once. A 401 pauses sending and
// keeps every record.
//
// Sign out, through `signOut`, stops sending and deletes the rows of the account last signed in, its Notice marks and
// list too (deleteAccountRows), and every other account's Notice list, in one commit. It then empties the WAL, whose
// older frames still hold their text. Only then does the account end the sign-in and delete its token. If the commit fails, Sign out fails, a phone still signed in stays signed in, and `state()` shows the
// failure, so Connect can say so after a 401 has already signed the phone out. The next Sign out deletes the rows of
// every account whose Sign out failed, whoever has signed in since. From the moment Sign out starts until one finishes,
// and while any failed one's rows stay, nothing sends and
// nothing is added. That hold is in memory: a relaunch reads the rows again, and a sign-in to their account sends them.
//
// Every disk change runs in one queue. A change checks the outbox's lifetime, which Sign out moves on, after each
// wait, so a late answer can neither update another account's record nor bring back a deleted one.

/**
 * `queued`: never sent. `sending`: a request may have reached the server, and it's asked again until it settles.
 * `stalled`: the server has answered `pending` continuously for longer than the stall threshold; it may still be saved,
 * so it's asked again, more slowly. `saved` and `refused` are settled.
 */
type OutboxStage = "queued" | "sending" | "saved" | "stalled" | "refused";

/** How a record settled. `missing` is a target the server can't find or hides, as reads answer one. */
type OutboxResult =
  | { readonly kind: "saved"; readonly threadId: string | null; readonly messageId: string | null }
  | {
      readonly kind: "refused";
      readonly reason: RefusalReason;
      readonly threadId: string | null;
      readonly winnerMessageId: string | null;
    }
  | { readonly kind: "missing"; readonly reason: string };

/** The thread or stream a record waits its turn in. */
interface Target {
  readonly kind: "thread" | "stream";
  readonly id: string;
}

interface OutboxRecord {
  readonly origin: string;
  readonly accountId: string;
  readonly workspaceId: string;
  /** Minted once on the phone, and sent with every ask. */
  readonly operationId: string;
  /**
   * The message the write makes, as the relay derives it from the operation ID, or null for a reaction. A refused
   * answer's reply can still be published: a read finds it by this ID.
   */
  readonly messageId: string | null;
  readonly sequence: number;
  /** The operation ID of the outbox write this one waits for. */
  readonly dependsOn: string | null;
  /** Where it waits its turn. Null only for a reply until its outbox post or send names the thread. */
  readonly target: Target | null;
  readonly write: ChatWrite;
  readonly stage: OutboxStage;
  /**
   * A request may have reached the server. It's written before the first request goes, and never unset, so Sign out
   * can tell a message never sent from one that may still send.
   */
  readonly attempted: boolean;
  /**
   * Enqueue inserts the record withheld, and keeps it withheld when its sendable version couldn't be committed.
   * `discard` withholds a record before deleting it. A withheld record isn't sent until `retryEnqueue`.
   */
  readonly withheld: boolean;
  /** When the current run of `pending` answers began. A failed request ends the run. */
  readonly pendingSinceMs: number | null;
  readonly result: OutboxResult | null;
  /**
   * In memory only, never written: withheld here, but the disk may hold it sendable, so a relaunch may send it: a
   * commit that made it sendable failed and may still stand, or a failed Discard left it so. Its next committed version
   * ends this.
   */
  readonly maySendOnReopen?: true;
}

export interface OutboxState {
  /**
   * `locked`: iOS hasn't been unlocked since the phone started, so the records can't be read yet. `failed`: reading
   * them failed. Both try again at the next `wake`. `damaged`: kept.db is damaged. Nothing replaces it until the person
   * deletes it, through `deleteDamaged` or Sign out.
   */
  readonly status: "loading" | "locked" | "failed" | "damaged" | "ready";
  /** In sequence order. */
  readonly records: readonly OutboxRecord[];
  /**
   * A handle for each of the last signed-in account's rows that can't be read, for `discard`. The handles change each
   * time the records are read, and Sign out ends them. They say nothing of the row's workspace, which can't be known.
   */
  readonly unreadable: readonly string[];
  /**
   * `failed` once a Sign out's delete has failed, until a Sign out finishes. Meanwhile nothing sends and nothing is
   * added.
   */
  readonly deletion: "none" | "failed";
  /**
   * The operation IDs of saved reactions that a read since they were saved shows otherwise, as when another device
   * changed them. The server's state may differ from what the record shows, so it needs the person, who can discard
   * it. In memory only: after a relaunch, the next read of the message finds it again.
   */
  readonly unconfirmed: readonly string[];
}

/**
 * Why enqueue didn't resolve, when it isn't a disk error: no account signed in or records not read yet, a write the
 * route would refuse, or `indeterminate`: the record may be on disk, withheld under `operationId`, and `retryEnqueue`
 * sends it as that one operation. `not-deleted`: Sign out's delete didn't commit. `has-dependents`: a write
 * still waiting in the outbox needs the one `discard` was asked to delete. `withheld-in-memory`: `discard` made neither
 * the withheld record nor its delete durable, so the record under `operationId` sends only after `retryEnqueue` until
 * the app closes, but a relaunch may send it.
 */
export class OutboxError extends Error {
  constructor(
    readonly kind:
      | "closed"
      | "invalid"
      | "indeterminate"
      | "not-deleted"
      | "has-dependents"
      | "withheld-in-memory",
    readonly operationId: string | null = null,
  ) {
    super(MESSAGES[kind]);
    this.name = "OutboxError";
  }
}

const MESSAGES: Readonly<Record<OutboxError["kind"], string>> = {
  closed: "The outbox isn't open.",
  invalid: "The write isn't valid.",
  indeterminate: "The outbox couldn't confirm it kept the write.",
  "not-deleted": "The outbox couldn't delete its records.",
  "has-dependents": "A write waiting in the outbox needs this one.",
  "withheld-in-memory": "The outbox couldn't keep the write from sending after the app restarts.",
};

/** What `discard` deletes: the signed-in account's record, or an unreadable record by its handle from `state()`. */
export type DiscardTarget =
  | { readonly kind: "record"; readonly operationId: string }
  | { readonly kind: "unreadable"; readonly handle: string };

export interface Outbox {
  state(): OutboxState;
  /** Calls `listener` after each change to `state()`. Returns a stop. */
  subscribe(listener: () => void): () => void;
  /**
   * Adds a write for the signed-in account, and resolves once its record is durable. A reply whose `threadId` is null
   * names, in `dependsOn`, the outbox post or send it replies to. A reaction names its message's `thread`. Rejects with
   * a StoreError when nothing was kept, and as `indeterminate` when the record may be kept, withheld.
   */
  enqueue(input: {
    readonly workspaceId: string;
    readonly write: ChatWrite;
    readonly dependsOn?: string;
    readonly thread?: string;
  }): Promise<OutboxRecord>;
  /** Keeps a withheld record for sending, with its own operation ID and arguments, and resolves once that's durable. */
  retryEnqueue(operationId: string): Promise<OutboxRecord>;
  /**
   * Deletes one record from this phone, and resolves once the delete is durable. It doesn't stop a write the server
   * may already have. A record's sender stops, and a record that may still send is written withheld first. It stays
   * withheld in memory when that write or the delete fails, so this run sends it only after `retryEnqueue`. Rejects as
   * `closed` while the records aren't read, Sign out holds the outbox, or no account is signed in; as `invalid` for
   * another account's record or row, or a handle `state()` no longer gives; as `has-dependents` while a
   * waiting reply needs the record; as `withheld-in-memory` when neither the withheld record nor the delete is durable,
   * so a relaunch may send it; and otherwise as the StoreError when the delete didn't commit. A failed discard keeps
   * the record in `state()`.
   */
  discard(target: DiscardTarget): Promise<void>;
  /** Deletes a damaged kept.db, which the person was warned holds every message waiting on this phone, then reads. */
  deleteDamaged(): Promise<void>;
  /**
   * What Sign out would delete of the last signed-in account's: messages never sent, withheld or refused, and messages
   * that may still send. Null until the records are read, so a sheet never says nothing is lost when it can't know.
   */
  signOutCounts(): { readonly unsent: number; readonly maySend: number } | null;
  /** A read of the workspace showed these messages: saved records whose result they show are deleted. */
  handoff(
    account: Pick<SignIn, "origin" | "userId">,
    workspaceId: string,
    messages: readonly ChatMessage[],
  ): void;
  /**
   * Stops sending and deletes `account`'s rows, or the last signed-in account's, its Notice marks and list included, and
   * every other account's Notice list, or a damaged kept.db, in one commit. Then it runs a TRUNCATE checkpoint, calls
   * `leave` and resolves once it has. Rejects as `not-deleted`, without calling `leave`, when the commit or checkpoint
   * fails.
   */
  signOut(leave: () => Promise<void>, account?: AccountKey | null): Promise<void>;
  /**
   * Whether Sign out holds kept.db: one under way, or one whose delete failed. Meanwhile no Notice store adds a row or
   * saves a list. The list clear that `leave`'s sign-in change runs finds no list left, so it adds no text to the WAL.
   */
  holding(): boolean;
  /** Tries again what failed: reading, and dependency changes. Cuts every retry wait short. */
  wake(): void;
  /** Reads the records, then sends with each sign-in. A 401 only pauses. Returns a stop. */
  follow(account: {
    state(): AccountState;
    subscribe(listener: () => void): () => void;
  }): () => void;
}

const FORMAT = 1;
/** A record as a commit leaves it: what a row holds, with nothing left in doubt. */
const committed = ({ maySendOnReopen: _, ...record }: OutboxRecord): OutboxRecord => record;
/** A row's record, without its sequence, which is the row's own. */
const serialize = (record: OutboxRecord) => {
  const { sequence: _, ...row } = committed(record);
  return JSON.stringify({ format: FORMAT, ...row });
};
/** Writes the record's row, replacing any it has. */
const put = (sql: Sql, record: OutboxRecord) =>
  sql.run(
    "INSERT INTO outbox (sequence, origin, account_id, record) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (sequence) DO UPDATE SET record = excluded.record",
    [record.sequence, record.origin, record.accountId, serialize(record)],
  );
const DELETE_ROW = "DELETE FROM outbox WHERE sequence = ?";
/** A new row, at the given sequence or past every sequence SQLite has committed, whichever is later. */
const INSERT =
  "INSERT INTO outbox (sequence, origin, account_id, record) VALUES (max(?, " +
  "(SELECT ifnull(max(seq), 0) + 1 FROM sqlite_sequence WHERE name = 'outbox')), ?, ?, ?) RETURNING sequence";
const uncertain = (error: unknown) => error instanceof StoreError && error.kind === "uncertain";
const DEPENDENCY_REFUSED: RefusalReason = "The message it replies to wasn't sent";
const COULD_NOT_SEND: RefusalReason = "Couldn't send";

const RETRY_MS = 1000;
const RETRY_MAX_MS = 60_000;
/**
 * The wire never says stalled: the relay answers `pending` for any unfinished write. The phone calls a write stalled
 * once the server has answered `pending` continuously for 10 minutes. A write that publishes takes seconds.
 */
const STALLED_AFTER_MS = 10 * 60_000;
const STALLED_RETRY_MS = 5 * 60_000;
/** 404s in a row before a workspace's records wait for a read of it, or `wake`. */
const UNREACHABLE_AFTER = 3;
/** The most messages from reads the outbox keeps for handing off writes saved later. */
const OBSERVED_MAX = 1000;

const unfinished = (record: OutboxRecord) =>
  record.stage === "queued" || record.stage === "sending" || record.stage === "stalled";
/** A reply still waiting for the thread its outbox post or send will name. */
const needsThread = (record: OutboxRecord) =>
  record.write.operation === "reply" && record.write.args.threadId === null;
type AccountKey = Pick<SignIn, "origin" | "userId">;
const sameAccount = (a: AccountKey | null, b: AccountKey | null) =>
  a?.origin === b?.origin && a?.userId === b?.userId;
const ownedBy = (record: Pick<OutboxRecord, "origin" | "accountId">, account: AccountKey | null) =>
  account !== null && record.origin === account.origin && record.accountId === account.userId;
const scopeOf = (record: Pick<OutboxRecord, "origin" | "accountId" | "workspaceId">) =>
  JSON.stringify([record.origin, record.accountId, record.workspaceId]);
const savedThread = (record: OutboxRecord | undefined) =>
  record?.result?.kind === "saved" ? record.result.threadId : null;

/** 400 and 413: the route refused the write's form or size, so asking again can't help. Anything else may have saved it. */
const isTerminal = (error: unknown) =>
  error instanceof ServerError && (error.status === 400 || error.status === 413);
const isNotFound = (error: unknown) =>
  error instanceof ServerError && error.problem === "not-found";

/** Where a write waits its turn, or undefined for a reaction without its message's thread. */
function targetOf(write: ChatWrite, thread: string | undefined): Target | null | undefined {
  switch (write.operation) {
    case "post":
      return { kind: "stream", id: write.args.groupId };
    case "send":
      return { kind: "stream", id: write.args.streamId };
    case "reply":
      return write.args.threadId === null ? null : { kind: "thread", id: write.args.threadId };
    case "react":
      return thread === undefined ? undefined : { kind: "thread", id: thread };
  }
}

/** A reply given the thread (and server parent message ID) its saved outbox post or send named, or null while it named none. */
function withThread(
  write: ChatWrite,
  parent: OutboxRecord | undefined,
): { readonly write: ChatWrite; readonly target: Target } | null {
  const threadId = savedThread(parent);
  if (threadId === null || write.operation !== "reply") return null;
  const savedMessageId = parent?.result?.kind === "saved" ? parent.result.messageId : null;
  const parentMessageId =
    savedMessageId !== null && write.args.parentMessageId === parent?.messageId
      ? savedMessageId
      : write.args.parentMessageId;
  return {
    write: {
      operation: "reply",
      args: {
        ...write.args,
        threadId,
        ...(parentMessageId === undefined ? {} : { parentMessageId }),
      },
    },
    target: { kind: "thread", id: threadId },
  };
}

export function createOutbox(options: {
  readonly store: KeptStore;
  /**
   * Whether the outbox sends anything. Off, it still reads its records, discards and deletes them at Sign out, but no
   * record reaches the server, not even one an earlier build kept. Defaults to on.
   */
  readonly sends?: boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The wait before trying again after `failures` failed or pending answers, or failed changes, in a row. */
  readonly retryMs?: (failures: number) => number;
  readonly stalledAfterMs?: number;
  readonly stalledRetryMs?: number;
}): Outbox {
  const { store } = options;
  const sends = options.sends ?? true;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? timerSleep;
  const retryMs =
    options.retryMs ?? ((failures) => Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS));
  const stalledAfterMs = options.stalledAfterMs ?? STALLED_AFTER_MS;
  const stalledRetryMs = options.stalledRetryMs ?? STALLED_RETRY_MS;

  let status: OutboxState["status"] = "loading";
  const records = new Map<number, OutboxRecord>();
  /** Each unreadable row, by the handle `state()` gives for it. */
  let unreadable = new Map<string, Pick<OutboxRecord, "sequence" | "origin" | "accountId">>();
  /** The outbox's lifetime. Sign out moves it on. */
  let epoch = 0;
  let session: SignIn | null = null;
  /** The account of the latest sign-in in this run, whose rows Sign out deletes, also after a 401. */
  let lastAccount: AccountKey | null = null;
  /** A Sign out is under way, or its delete failed and none has finished since: nothing sends or is added. */
  let held = false;
  /**
   * Every account whose Sign out delete failed and no Sign out has deleted since. The next Sign out deletes all of
   * them, whoever has signed in since.
   */
  let owed: readonly (AccountKey | null)[] = [];
  /**
   * Records enqueue has inserted withheld and not yet confirmed, hidden from `state()`. With a function, the record may
   * start sending, and its sender's "sending" mark confirms it, calling it with whether that mark was committed.
   */
  const confirming = new Map<number, ((committed: boolean) => void) | null>();
  const listeners = new Set<() => void>();
  /** The sender of each record being sent, by sequence. */
  const running = new Map<number, AbortController>();
  /** Records whose dependency change is being written. */
  const changing = new Set<number>();
  /**
   * Records `discard` is deleting. Each holds its lane, and keeps its stopped sender from starting again, only while its
   * withheld version is written. Once withheld in memory, it no longer holds its lane, as any withheld record doesn't.
   */
  const discarding = new Set<number>();
  /** Workspaces, by scope, whose records wait after repeated 404s. */
  const unreachable = new Set<string>();
  /** The latest messages reads showed, for one account and workspace. */
  let observed: { readonly scope: string; readonly messages: Map<string, ChatMessage> } | null =
    null;
  /** Saved reactions, by sequence, that a read since they were saved shows otherwise. Kept in memory only. */
  const unconfirmed = new Set<number>();
  let changeFailures = 0;
  let retrying = false;
  /** Aborts to cut every retry wait short. */
  let nudge = new AbortController();
  let snapshot: OutboxState | null = null;

  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  }

  const changed = () => {
    snapshot = null;
    for (const listener of listeners) listener();
  };
  /** One transaction. A file found damaged shows as damaged, whenever that is found. */
  function transact<T>(body: (sql: Sql) => Promise<T>): Promise<T> {
    return store.transaction(body).catch((error: unknown) => {
      if (error instanceof StoreError && error.kind === "damaged" && status !== "damaged") {
        status = "damaged";
        changed();
      }
      throw error;
    });
  }
  const find = (operationId: string | null, scope: string) =>
    [...records.values()].find(
      (record) => record.operationId === operationId && scopeOf(record) === scope,
    );
  /** A reply still waiting for this saved write's thread needs the record. */
  const needed = (record: OutboxRecord) =>
    [...records.values()].some(
      (other) =>
        other.dependsOn === record.operationId &&
        scopeOf(other) === scopeOf(record) &&
        needsThread(other),
    );
  /**
   * A write still waiting in the outbox for this one: it waits while this one is unfinished, is refused because this
   * one was, and a reply waits for the thread this one's saved result names.
   */
  const waitedFor = (record: OutboxRecord) =>
    [...records.values()].some(
      (other) =>
        other.dependsOn === record.operationId &&
        scopeOf(other) === scopeOf(record) &&
        other.stage === "queued" &&
        (unfinished(record) || record.stage === "refused" || needsThread(other)),
    );

  /** Waits `ms`, or less: `wake` cuts it short, and so does `stop`. */
  async function pause(ms: number, stop: AbortSignal | null) {
    // A sender stopped during its last write ends now, so its lane is free for the next sign-in.
    if (stop?.aborted) return;
    const wait = new AbortController();
    const end = () => wait.abort();
    const woken = nudge.signal;
    stop?.addEventListener("abort", end);
    woken.addEventListener("abort", end);
    try {
      await sleep(ms, wait.signal);
    } catch {
      // Cut short.
    } finally {
      stop?.removeEventListener("abort", end);
      woken.removeEventListener("abort", end);
    }
  }

  /**
   * Writes the record's next version, worked out from the current one inside the queue, and keeps it once it's
   * committed. Resolves false when nothing changed: the record went, the outbox was deleted, `valid` failed, `change`
   * returned null, or the write failed. After an `uncertain` failure the disk may hold either version; the next change
   * writes over it.
   */
  function commit(
    sequence: number,
    change: (record: OutboxRecord) => OutboxRecord | null,
    valid = () => true,
  ): Promise<boolean> {
    const at = epoch;
    return serial(async () => {
      const current = records.get(sequence);
      const updated = epoch === at && valid() && current ? change(current) : null;
      if (!updated) return false;
      try {
        await transact((sql) => put(sql, updated));
      } catch (error) {
        // A failed commit that would have made a withheld record sendable may stand, so a relaunch may send it.
        if (uncertain(error) && epoch === at && current?.withheld && !updated.withheld) {
          records.set(sequence, { ...current, maySendOnReopen: true });
          changed();
        }
        return false;
      }
      // Signed out meanwhile: the delete queued behind this write removes it.
      if (epoch !== at) return false;
      records.set(sequence, committed(updated));
      changed();
      return true;
    });
  }

  /** A dependency change, tried again with backoff, and at `wake`, until it's written. */
  function change(sequence: number, update: (record: OutboxRecord) => OutboxRecord | null) {
    changing.add(sequence);
    const at = epoch;
    void commit(sequence, update).then((written) => {
      changing.delete(sequence);
      if (epoch !== at) return;
      if (!written) return later();
      changeFailures = 0;
      pump();
    });
  }

  function later() {
    if (retrying) return;
    retrying = true;
    changeFailures += 1;
    void pause(retryMs(changeFailures), null).then(() => {
      retrying = false;
      pump();
    });
  }

  /** Reads every row. */
  function load(): Promise<void> {
    const at = epoch;
    return serial(async () => {
      if (epoch !== at) return;
      let rows: readonly Row[];
      try {
        rows = await store.read(
          "SELECT sequence, origin, account_id, record FROM outbox ORDER BY sequence",
          [],
        );
      } catch (error) {
        if (epoch !== at) return;
        const kind = error instanceof StoreError ? error.kind : null;
        status = kind === "locked" || kind === "damaged" ? kind : "failed";
        changed();
        return;
      }
      if (epoch !== at) return;
      records.clear();
      unreadable = new Map();
      for (const { sequence, origin, account_id: accountId, record } of rows) {
        if (
          typeof sequence !== "number" ||
          typeof origin !== "string" ||
          typeof accountId !== "string"
        )
          continue;
        const read = readRecord(record, sequence);
        if (read) records.set(sequence, read);
        else unreadable.set(crypto.randomUUID(), { sequence, origin, accountId });
      }
      status = "ready";
      changed();
      reconcile();
      pump();
    });
  }

  /**
   * Deletes saved records whose result the latest reads show. For a reaction, it deletes the account's newest one to
   * the message and emoji that a read shows, with the earlier saved ones it replaced, oldest first, so an earlier one
   * never shows again over the server's state.
   */
  function reconcile() {
    if (status !== "ready" || !observed) return;
    const { scope, messages } = observed;
    const saved = [...records.values()]
      .filter((record) => record.stage === "saved" && scopeOf(record) === scope)
      .sort((a, b) => a.sequence - b.sequence);
    const newest = new Map<string, number>();
    for (const record of saved) {
      if (!shows(record, messages)) continue;
      const key = reactionKey(record);
      if (key === null) retire([record.sequence]);
      else newest.set(key, record.sequence);
    }
    for (const [key, last] of newest)
      retire(
        saved
          .filter((record) => record.sequence <= last && reactionKey(record) === key)
          .map((record) => record.sequence),
      );
  }

  /**
   * Deletes saved records in one commit, up to the first that can't go yet, so a record is never deleted without the
   * ones listed ahead of it.
   */
  function retire(sequences: readonly number[]) {
    const at = epoch;
    void serial(async () => {
      const going: number[] = [];
      for (const sequence of sequences) {
        const record = records.get(sequence);
        if (record === undefined) continue;
        // Checked here, after every change queued before it, such as a reply accepted meanwhile that needs its thread.
        if (record.stage !== "saved" || needed(record)) break;
        going.push(sequence);
      }
      if (epoch !== at || going.length === 0) return;
      await transact(async (sql) => {
        for (const sequence of going) await sql.run(DELETE_ROW, [sequence]);
      });
      if (epoch !== at) return;
      for (const sequence of going) records.delete(sequence);
      changed();
    }).catch(() => undefined);
  }

  /**
   * Settles what dependencies can, then starts each lane's oldest unfinished record, unless any record of that lane is
   * running. Every record's lane is worked out before anything starts, and a reply whose outbox post or send is saved
   * already belongs to that thread's lane.
   */
  function pump() {
    if (!sends || status !== "ready" || held) return;
    const ordered = [...records.values()].sort((a, b) => a.sequence - b.sequence);
    const heads = new Map<string, OutboxRecord>();
    const busy = new Set<string>();
    for (const record of ordered) {
      if (!unfinished(record) || (record.withheld && !confirming.get(record.sequence))) continue;
      const parentThread =
        record.target || record.dependsOn === null
          ? null
          : savedThread(find(record.dependsOn, scopeOf(record)));
      const waitsIn = record.target
        ? `${record.target.kind}:${record.target.id}`
        : parentThread !== null
          ? `thread:${parentThread}`
          : `after:${record.dependsOn}`;
      const lane = JSON.stringify([scopeOf(record), waitsIn]);
      if (running.has(record.sequence) || discarding.has(record.sequence)) busy.add(lane);
      if (!heads.has(lane)) heads.set(lane, record);
    }
    for (const [lane, record] of heads) {
      if (changing.has(record.sequence)) continue;
      if (record.stage === "queued" && record.dependsOn !== null) {
        const parent = find(record.dependsOn, scopeOf(record));
        if (parent && unfinished(parent)) continue;
        if (parent?.stage === "refused" || (!parent && needsThread(record))) {
          refuse(record.sequence, DEPENDENCY_REFUSED);
          continue;
        }
        if (parent && needsThread(record)) {
          const binding = withThread(record.write, parent);
          if (binding === null) refuse(record.sequence, COULD_NOT_SEND);
          else
            change(record.sequence, (current) =>
              current.stage === "queued" && needsThread(current)
                ? { ...current, ...binding }
                : null,
            );
          continue;
        }
      }
      if (running.has(record.sequence) || busy.has(lane) || unreachable.has(scopeOf(record)))
        continue;
      if (session?.isCurrent() && ownedBy(record, session)) void run(record.sequence, session);
    }
  }

  /** Refuses a record never sent, keeping its text. */
  function refuse(sequence: number, reason: RefusalReason) {
    change(sequence, (record) =>
      record.stage === "queued" && !record.attempted
        ? {
            ...record,
            stage: "refused",
            result: { kind: "refused", reason, threadId: null, winnerMessageId: null },
          }
        : null,
    );
  }

  /** Sends one record, and asks again until it settles or this sender has to stop. */
  async function run(sequence: number, signIn: SignIn) {
    const own = new AbortController();
    running.set(sequence, own);
    const at = epoch;
    const live = () =>
      !own.signal.aborted &&
      epoch === at &&
      session === signIn &&
      signIn.isCurrent() &&
      status !== "damaged";
    let failures = 0;
    let notFound = 0;
    /**
     * When this sender's current run of pending answers began. Kept here, not read from the record, so a failed request,
     * or a relaunch, starts a new run even when the record's reset couldn't be written.
     */
    let pendingSince: number | null = null;
    const rest = (stalled: boolean) => {
      failures += 1;
      return pause(stalled ? stalledRetryMs : retryMs(failures), own.signal);
    };
    try {
      while (live()) {
        const record = records.get(sequence);
        if (!record || !unfinished(record) || (record.withheld && !confirming.get(sequence)))
          return;
        if (record.stage === "queued") {
          // Written before the request goes, so a relaunch knows the server may have it. For a record enqueue hasn't
          // confirmed yet, it is also the commit that makes it sendable.
          const marked = await commit(
            sequence,
            (current) =>
              current.stage === "queued" && (!current.withheld || confirming.get(sequence))
                ? { ...current, stage: "sending", attempted: true, withheld: false }
                : null,
            live,
          );
          settleConfirm(sequence, marked);
          if (!live()) return;
          if (!marked) {
            await rest(false);
            continue;
          }
        }
        const sent = records.get(sequence);
        if (!sent || !unfinished(sent)) return;
        let answer: WriteAnswer;
        try {
          answer = await sendWrite(
            signIn.client,
            sent.workspaceId,
            sent.operationId,
            sent.write,
            own.signal,
          );
        } catch (error) {
          // A 401, or the sign-in ending, has already stopped this sender.
          if (!live()) return;
          if (isTerminal(error)) {
            if (
              (await settle(
                sequence,
                { kind: "refused", reason: COULD_NOT_SEND, threadId: null, winnerMessageId: null },
                live,
              )) ||
              !live()
            )
              return;
            await rest(sent.stage === "stalled");
            continue;
          }
          // The workspace may be gone from this phone. Its records wait, still uncertain, for a read of it or `wake`.
          notFound = isNotFound(error) ? notFound + 1 : 0;
          if (notFound >= UNREACHABLE_AFTER) {
            unreachable.add(scopeOf(sent));
            return;
          }
          // A failed request ends a run of pending answers: only continuous pending counts toward stalled.
          pendingSince = null;
          if (sent.stage === "sending" && sent.pendingSinceMs !== null) {
            await commit(
              sequence,
              (current) =>
                current.stage === "sending" && current.pendingSinceMs !== null
                  ? { ...current, pendingSinceMs: null }
                  : null,
              live,
            );
          }
          // Offline, a timeout, a dropped answer, or a server failure: the write may be saved. Ask again, the same.
          await rest(sent.stage === "stalled");
          continue;
        }
        notFound = 0;
        if (!live()) return;
        if (answer.kind === "pending") {
          pendingSince ??= now();
          const since = pendingSince;
          const stage =
            sent.stage === "stalled" || now() - since >= stalledAfterMs ? "stalled" : "sending";
          await commit(
            sequence,
            (current) =>
              unfinished(current) && (current.pendingSinceMs !== since || current.stage !== stage)
                ? { ...current, pendingSinceMs: since, stage }
                : null,
            live,
          );
          if (!live()) return;
          await rest(stage === "stalled");
          continue;
        }
        // A record whose answer couldn't be written is asked again; the server answers the same.
        if ((await settle(sequence, answer, live)) || !live()) return;
        await rest(sent.stage === "stalled");
      }
    } finally {
      if (running.get(sequence) === own) running.delete(sequence);
      settleConfirm(sequence, false);
      // The next record in its lane, or this one again for a sign-in that replaced this sender's.
      pump();
    }
  }

  /**
   * Tells enqueue whether a sender's "sending" mark confirmed its record, once. The record stops being hidden, so
   * `state()` shows it, as the mark's own change couldn't while it was still confirming.
   */
  function settleConfirm(sequence: number, marked: boolean) {
    const done = confirming.get(sequence);
    if (!done) return;
    confirming.delete(sequence);
    changed();
    done(marked);
  }

  async function settle(
    sequence: number,
    result: OutboxResult,
    valid: () => boolean,
  ): Promise<boolean> {
    const written = await commit(
      sequence,
      (record) =>
        unfinished(record)
          ? {
              ...record,
              stage: result.kind === "saved" ? "saved" : "refused",
              pendingSinceMs: null,
              result,
            }
          : null,
      valid,
    );
    // A read may have shown it before the answer came.
    if (written && result.kind === "saved") reconcile();
    return written;
  }

  function stopSending() {
    for (const sender of running.values()) sender.abort();
  }

  /**
   * Keeps a record withheld in memory after a commit that may not stand, and gives the error enqueue rejects with.
   * `error` is the failure of a commit that would have made it sendable: an uncertain one, or one already marked so,
   * means a relaunch may send it.
   */
  function keepWithheld(record: OutboxRecord, at: number, error: unknown = null): OutboxError {
    confirming.delete(record.sequence);
    // Signed out meanwhile: the delete queued behind this write removes it.
    if (epoch !== at) return new OutboxError("closed");
    const reopens = uncertain(error) || records.get(record.sequence)?.maySendOnReopen === true;
    records.set(record.sequence, {
      ...committed(record),
      withheld: true,
      ...(reopens ? { maySendOnReopen: true as const } : {}),
    });
    changed();
    return new OutboxError("indeterminate", record.operationId);
  }

  /** Makes a withheld record sendable in one commit, and keeps it once that commit has returned. Runs in the queue. */
  async function release(record: OutboxRecord, at: number): Promise<OutboxRecord> {
    const sendable = committed({ ...record, withheld: false });
    try {
      await transact((sql) => put(sql, sendable));
    } catch (error) {
      // A failed commit may still stand. The record then sends this run only after `retryEnqueue`.
      throw keepWithheld(record, at, error);
    }
    confirming.delete(record.sequence);
    if (epoch !== at) throw new OutboxError("closed");
    records.set(record.sequence, sendable);
    changed();
    pump();
    return sendable;
  }

  return {
    state() {
      snapshot ??= {
        status,
        records: [...records.values()]
          .filter((record) => !confirming.has(record.sequence))
          .sort((a, b) => a.sequence - b.sequence),
        unreadable: [...unreadable]
          .filter(([, row]) => ownedBy(row, lastAccount))
          .map(([handle]) => handle),
        deletion: owed.length > 0 ? "failed" : "none",
        unconfirmed: [...records.values()]
          .filter((record) => unconfirmed.has(record.sequence))
          .map((record) => record.operationId),
      };
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    enqueue(input) {
      const write = readChatWrite(input.write);
      const signIn = session;
      const dependsOn = input.dependsOn ?? null;
      if (status !== "ready" || held || !signIn || !signIn.isCurrent())
        return Promise.reject(new OutboxError("closed"));
      const { workspaceId } = input;
      const target = write ? targetOf(write, input.thread) : undefined;
      if (
        !write ||
        target === undefined ||
        (input.thread !== undefined && !text(input.thread, 256)) ||
        !text(workspaceId, 256) ||
        workspaceId === "." ||
        workspaceId === ".." ||
        (dependsOn !== null && !text(dependsOn, 128)) ||
        (target === null && dependsOn === null)
      ) {
        return Promise.reject(new OutboxError("invalid"));
      }
      const scope = scopeOf({ origin: signIn.origin, accountId: signIn.userId, workspaceId });
      // A reply to a saved outbox post or send takes its thread now, before a read can hand that write off.
      const early = target === null ? withThread(write, find(dependsOn, scope)) : null;
      const at = epoch;
      return serial(async () => {
        if (epoch !== at || status !== "ready" || held) throw new OutboxError("closed");
        let accepted = early?.write ?? write;
        let waitsIn = early?.target ?? target;
        if (waitsIn === null) {
          // Checked inside the queue, after every change queued before it, so the parent can't go between the check and
          // the write. A reply waiting for its thread needs the outbox post or send it replies to.
          const parent = find(dependsOn, scope);
          if (
            !parent ||
            parent.stage === "refused" ||
            (parent.write.operation !== "post" && parent.write.operation !== "send")
          )
            throw new OutboxError("invalid");
          const binding = withThread(accepted, parent);
          if (parent.stage === "saved" && binding === null) throw new OutboxError("invalid");
          if (binding) {
            accepted = binding.write;
            waitsIn = binding.target;
          }
        }
        const operationId = crypto.randomUUID();
        const draft: OutboxRecord = {
          origin: signIn.origin,
          accountId: signIn.userId,
          workspaceId,
          operationId,
          sequence: 0,
          dependsOn,
          target: waitsIn,
          write: accepted,
          messageId: await derivedMessageId(signIn.userId, workspaceId, operationId, accepted),
          stage: "queued",
          attempted: false,
          withheld: true,
          pendingSinceMs: null,
          result: null,
        };
        // A rolled-back insert's sequence comes back from SQLite, and this run may still hold its record, so the
        // sequence starts past every one held here.
        const floor = Math.max(0, ...records.keys()) + 1;
        const inserted = { sequence: null as number | null };
        let record: OutboxRecord;
        try {
          const sequence = await transact(async (sql) => {
            const [row] = await sql.all(INSERT, [
              floor,
              draft.origin,
              draft.accountId,
              serialize(draft),
            ]);
            if (typeof row?.sequence !== "number")
              throw new StoreError("failed", "The insert gave no sequence.");
            inserted.sequence = row.sequence;
            return row.sequence;
          });
          record = { ...draft, sequence };
        } catch (error) {
          // A failed commit may still stand, withheld, so only `retryEnqueue` sends it.
          if (inserted.sequence === null || !uncertain(error)) throw error;
          throw keepWithheld({ ...draft, sequence: inserted.sequence }, at);
        }
        if (epoch !== at) throw new OutboxError("closed");
        records.set(record.sequence, record);
        const marked = new Promise<boolean>((resolve) => confirming.set(record.sequence, resolve));
        pump();
        if (running.has(record.sequence)) return { record, marked };
        confirming.set(record.sequence, null);
        return { record: await release(record, at), marked: null };
      }).then(async ({ record, marked }) => {
        // Its sender's "sending" mark, committed after this queued change, made it sendable.
        if (marked === null) return record;
        if (await marked) return records.get(record.sequence) ?? record;
        throw keepWithheld(record, at);
      });
    },

    retryEnqueue(operationId) {
      const at = epoch;
      return serial(async () => {
        const signIn = session;
        if (epoch !== at || status !== "ready" || held || !signIn) throw new OutboxError("closed");
        const record = [...records.values()].find(
          (entry) => entry.operationId === operationId && entry.withheld && ownedBy(entry, signIn),
        );
        if (!record) throw new OutboxError("invalid");
        // Kept only once a sendable row is committed, which also gives a record whose insert never stood its row.
        return release(record, at);
      });
    },

    discard(target) {
      const at = epoch;
      return serial(async () => {
        const signIn = session;
        if (epoch !== at || status !== "ready" || held || !signIn?.isCurrent())
          throw new OutboxError("closed");
        if (target.kind === "unreadable") {
          const row = unreadable.get(target.handle);
          if (row === undefined || !ownedBy(row, signIn)) throw new OutboxError("invalid");
          await transact((sql) => sql.run(DELETE_ROW, [row.sequence]));
          if (epoch !== at) throw new OutboxError("closed");
          unreadable.delete(target.handle);
          changed();
          return;
        }
        const record = [...records.values()].find(
          (entry) => entry.operationId === target.operationId && ownedBy(entry, signIn),
        );
        if (!record) throw new OutboxError("invalid");
        if (waitedFor(record)) throw new OutboxError("has-dependents");
        const { sequence } = record;
        discarding.add(sequence);
        // Its sender stops now, so no answer that comes later is written.
        running.get(sequence)?.abort();
        // Whether the disk can't hold the record sendable, even after a power loss.
        let safe = !unfinished(record);
        try {
          if (unfinished(record)) {
            // Written even when withheld in memory: a failed discard leaves it so with the sendable version on disk.
            const withheld = { ...record, withheld: true };
            let written: "committed" | "uncertain" | "failed" = "committed";
            try {
              await transact((sql) => put(sql, withheld));
            } catch (error) {
              written = uncertain(error) ? "uncertain" : "failed";
            }
            if (epoch !== at) throw new OutboxError("closed");
            // Unless this write committed, a row that was or may be sendable may still be, whatever the delete does:
            // the record keeps saying a relaunch may send it, after the discard's own problem is gone from the screen.
            const doubted =
              written !== "committed" && (!record.withheld || record.maySendOnReopen === true);
            records.set(
              sequence,
              written === "committed"
                ? committed(withheld)
                : doubted
                  ? { ...withheld, maySendOnReopen: true }
                  : withheld,
            );
            changed();
            // Any failure but `uncertain` left the sendable version.
            if (written === "failed")
              throw new OutboxError("withheld-in-memory", record.operationId);
            safe = written === "committed";
          }
          try {
            await transact((sql) => sql.run(DELETE_ROW, [sequence]));
          } catch (error) {
            if (epoch !== at) throw new OutboxError("closed");
            // The withheld version's commit may not stand, leaving the sendable one.
            throw safe ? error : new OutboxError("withheld-in-memory", record.operationId);
          }
          if (epoch !== at) throw new OutboxError("closed");
          records.delete(sequence);
          changed();
        } finally {
          discarding.delete(sequence);
          pump();
        }
      });
    },

    deleteDamaged() {
      const at = epoch;
      return serial(async () => {
        if (epoch !== at || status !== "damaged") throw new OutboxError("closed");
        await store.destroy();
      }).then(() => load());
    },

    signOutCounts() {
      if (status !== "ready" || held) return null;
      let unsent = [...unreadable.values()].filter((row) => ownedBy(row, lastAccount)).length;
      let maySend = 0;
      for (const record of records.values()) {
        if (!ownedBy(record, lastAccount)) continue;
        // An answer refused as already answered still published its reply.
        if (record.stage === "refused")
          unsent +=
            record.result?.kind === "refused" && record.result.reason === "already answered"
              ? 0
              : 1;
        else if (!unfinished(record)) continue;
        // A request may have reached the server, even for a record a failed discard withheld.
        else if (record.attempted) maySend += 1;
        else unsent += 1;
      }
      return { unsent, maySend };
    },

    handoff(account, workspaceId, messages) {
      const scope = scopeOf({ origin: account.origin, accountId: account.userId, workspaceId });
      // A read of the workspace answered, so its records can go again.
      unreachable.delete(scope);
      if (observed?.scope !== scope) observed = { scope, messages: new Map() };
      for (const message of messages) {
        observed.messages.delete(message.id);
        observed.messages.set(message.id, message);
      }
      for (const id of observed.messages.keys()) {
        if (observed.messages.size <= OBSERVED_MAX) break;
        observed.messages.delete(id);
      }
      // A saved reaction this read shows otherwise may have changed on another device since. It needs the person.
      // The latest read of its message decides, whether or not its record can be deleted yet.
      const read = new Set(messages.map((message) => message.id));
      let flagged = false;
      for (const record of records.values()) {
        if (
          record.stage !== "saved" ||
          record.write.operation !== "react" ||
          scopeOf(record) !== scope ||
          !read.has(record.write.args.messageId)
        )
          continue;
        const contradicts = !shows(record, observed.messages);
        if (contradicts === unconfirmed.has(record.sequence)) continue;
        if (contradicts) unconfirmed.add(record.sequence);
        else unconfirmed.delete(record.sequence);
        flagged = true;
      }
      if (flagged) changed();
      reconcile();
      pump();
    },

    signOut(leave, account) {
      epoch += 1;
      const at = epoch;
      // After failed Sign outs, Try again deletes each of their accounts' rows, and those of any account signed in since.
      const ending = account ?? lastAccount;
      const accounts = owed.some((left) => sameAccount(left, ending)) ? owed : [...owed, ending];
      const damaged = status === "damaged";
      stopSending();
      held = true;
      for (const [sequence, record] of records)
        if (accounts.some((account) => ownedBy(record, account))) records.delete(sequence);
      observed = null;
      unreachable.clear();
      unconfirmed.clear();
      status = "loading";
      changed();
      return serial(async () => {
        // A damaged file can't be read for its rows. The sheet warned that Sign out deletes any it has.
        if (damaged) await store.destroy();
        else if (accounts.some((account) => account !== null)) {
          await transact(async (sql) => {
            for (const account of accounts) if (account) await deleteAccountRows(sql, account);
            // Every account's Notice list is a read copy the sign-in change deletes anyway. Deleting it here puts it
            // before the checkpoint, which then empties its text from the WAL too.
            await sql.run("DELETE FROM notice_lists", []);
          });
          // The WAL's older frames still hold the deleted text, so Sign out fails until the checkpoint empties it.
          await store.checkpoint();
        }
      }).then(
        async () => {
          // A Sign out ends only the failures whose accounts it deleted.
          owed = damaged
            ? []
            : owed.filter((left) => !accounts.some((account) => sameAccount(left, account)));
          await leave();
          // Held until the sign-in has ended, so nothing is added for the account meanwhile, and while a failed Sign
          // out's rows stay.
          if (epoch !== at) return;
          held = owed.length > 0;
          await load();
        },
        () => {
          // Recorded whatever Sign out has started since: the queue runs each Sign out's delete in order, so none
          // later can have deleted these rows yet, and one that does ends this.
          owed = [
            ...owed,
            ...accounts.filter((account) => !owed.some((left) => sameAccount(left, account))),
          ];
          held = true;
          if (epoch === at) void load();
          else changed();
          throw new OutboxError("not-deleted");
        },
      );
    },

    holding: () => held,

    wake() {
      nudge.abort();
      nudge = new AbortController();
      unreachable.clear();
      if (status === "locked" || status === "failed") void load();
      else pump();
    },

    follow(account) {
      const take = () => {
        const state = account.state();
        const signIn = state.status === "signed-in" ? state.signIn : null;
        if (signIn === session) return;
        session = signIn;
        if (signIn) lastAccount = { origin: signIn.origin, userId: signIn.userId };
        observed = null;
        unreachable.clear();
        stopSending();
        changed();
        pump();
      };
      take();
      void load();
      const unsubscribe = account.subscribe(take);
      return () => {
        unsubscribe();
        session = null;
        stopSending();
      };
    },
  };
}

/** The relay stores a reaction's emoji trimmed and in NFC. */
export const emojiKey = (emoji: string) => emoji.trim().normalize("NFC");

/** The message and emoji a reaction is on, or null for another write. */
const reactionKey = ({ write }: OutboxRecord) =>
  write.operation === "react"
    ? JSON.stringify([write.args.messageId, emojiKey(write.args.emoji)])
    : null;

/** Whether a read shows a saved record's result: its message by ID, its answer resolved, or its reaction as sent. */
function shows(record: OutboxRecord, shown: ReadonlyMap<string, ChatMessage>): boolean {
  const { write, result } = record;
  if (write.operation === "react") {
    const target = shown.get(write.args.messageId);
    if (!target) return false;
    const emoji = emojiKey(write.args.emoji);
    const has = target.reactions.some(
      (reaction) =>
        emojiKey(reaction.emoji) === emoji &&
        reaction.authorKind === "human" &&
        reaction.authorId === record.accountId,
    );
    return has === (write.args.state === "added");
  }
  const returned = result?.kind === "saved" ? result.messageId : null;
  if (
    !(record.messageId !== null && shown.has(record.messageId)) &&
    !(returned !== null && shown.has(returned))
  )
    return false;
  // An answer's question, when the read shows it, shows it answered.
  const question =
    write.operation === "reply" && write.args.resolves
      ? shown.get(write.args.resolves.messageId)
      : undefined;
  return question === undefined || question.decisionState === "resolved";
}

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const STAGES: ReadonlySet<string> = new Set<OutboxStage>([
  "queued",
  "sending",
  "saved",
  "stalled",
  "refused",
]);
const isStage = (value: unknown): value is OutboxStage =>
  typeof value === "string" && STAGES.has(value);
const id = (value: unknown): value is string => text(value, 256);
const idOrNull = (value: unknown): value is string | null => value === null || id(value);

function readResult(value: unknown): OutboxResult | null | undefined {
  if (value === null) return null;
  if (!isFields(value)) return undefined;
  if (value.kind === "saved" && idOrNull(value.threadId) && idOrNull(value.messageId)) {
    return { kind: "saved", threadId: value.threadId, messageId: value.messageId };
  }
  if (
    value.kind === "refused" &&
    isRefusalReason(value.reason) &&
    idOrNull(value.threadId) &&
    idOrNull(value.winnerMessageId)
  ) {
    return {
      kind: "refused",
      reason: value.reason,
      threadId: value.threadId,
      winnerMessageId: value.winnerMessageId,
    };
  }
  if (value.kind === "missing" && text(value.reason))
    return { kind: "missing", reason: value.reason };
  return undefined;
}

function readTarget(value: unknown): Target | null | undefined {
  if (value === null) return null;
  return isFields(value) && (value.kind === "thread" || value.kind === "stream") && id(value.id)
    ? { kind: value.kind, id: value.id }
    : undefined;
}

/** A row's record as this build writes it, or null for anything else, which is kept as unreadable. */
function readRecord(saved: unknown, sequence: number): OutboxRecord | null {
  let value: unknown;
  try {
    value = typeof saved === "string" ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
  if (!isFields(value) || value.format !== FORMAT) return null;
  const write = readChatWrite(value.write);
  const result = readResult(value.result);
  const target = readTarget(value.target);
  const {
    origin,
    accountId,
    workspaceId,
    operationId,
    messageId,
    dependsOn,
    stage,
    attempted,
    withheld,
    pendingSinceMs,
  } = value;
  if (
    !write ||
    result === undefined ||
    target === undefined ||
    !text(origin) ||
    !id(accountId) ||
    !id(workspaceId) ||
    !text(operationId, 128) ||
    !idOrNull(messageId) ||
    !(dependsOn === null || text(dependsOn, 128)) ||
    !isStage(stage) ||
    typeof attempted !== "boolean" ||
    typeof withheld !== "boolean" ||
    !(pendingSinceMs === null || count(pendingSinceMs))
  )
    return null;
  // The stage and the result agree, and only a reply waiting for a write it names lacks a target.
  if ((stage === "saved") !== (result?.kind === "saved")) return null;
  if ((stage === "refused") !== (result?.kind === "refused" || result?.kind === "missing"))
    return null;
  const waiting = write.operation === "reply" && write.args.threadId === null;
  if ((target === null) !== waiting || (waiting && dependsOn === null)) return null;
  return {
    origin,
    accountId,
    workspaceId,
    operationId,
    messageId,
    sequence,
    dependsOn,
    target,
    write,
    stage,
    attempted,
    withheld,
    pendingSinceMs,
    result,
  };
}
