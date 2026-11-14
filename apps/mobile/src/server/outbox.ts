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
import { DurableFileError, type DurableFiles } from "./durableFiles";
import type { ChatMessage } from "./workspaceReads";

// The phone's outbox: chat writes the person made, kept on disk until the server has them and a read shows them.
// It is one account-level store beside the read cache, never inside a workspace's store, so switching workspace
// doesn't touch it.
//
// Each write is one record file, named by its sequence number, written through the durable-file module
// (durableFiles.ts). A counter file, written first, gives each record the next sequence, so order survives a relaunch.
// Enqueue writes the record withheld, then sendable, and resolves only once the record would survive a crash or power
// loss. A record whose sendable version couldn't be written stays withheld, on disk and in memory, and is sent only
// after `retryEnqueue` with the same operation ID, so a relaunch never sends a write the person may have given up on.
// Nothing here deletes a record except a read that shows its result, and Sign out. A record that can't be read, and any
// other file, is kept aside.
//
// Only a sign-in with the record's own server and account sends it. Within each account, workspace, and thread or
// stream, only the oldest unfinished record runs, and none while another of that lane's records is running. A reaction
// waits its turn in its message's thread. A reply to a post or send still in the outbox waits until that write is
// saved, then takes the thread its result names. A record that may have reached the server is asked again with the
// same operation ID and arguments until it's saved or refused, so it is written at most once. A 401 pauses sending and
// keeps every record.
//
// Sign out, through `signOut`, stops sending and writes a marker. Only then does the account end the sign-in and
// delete its token; once that has settled, every file goes, and the marker last. A launch that finds the marker
// finishes the delete before it reads anything, even if the app closed before the token went. If the marker can't be
// written, every file must go at once, before the token, or Sign out fails, and a phone still signed in stays signed
// in. From the moment Sign out starts, the delete is owed: nothing sends and nothing is added, whoever signs in, until
// a try finishes it. `wake` and each sign-in try again once Sign out's own try has ended, and `state()` shows a failed
// try, so Connect can say so after a 401 has already signed the phone out.
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
   * Enqueue writes the record withheld before sendable, and keeps it withheld when the sendable version couldn't be
   * written. A withheld record isn't sent until `retryEnqueue`.
   */
  readonly withheld: boolean;
  /** When the current run of `pending` answers began. A failed request ends the run. */
  readonly pendingSinceMs: number | null;
  readonly result: OutboxResult | null;
}

interface OutboxState {
  /**
   * `locked`: iOS hasn't been unlocked since the phone started, so the records can't be read yet. `failed`: reading
   * them, or finishing a Sign out's delete, failed. Both try again at the next `wake`.
   */
  readonly status: "loading" | "locked" | "failed" | "ready";
  /** In sequence order. */
  readonly records: readonly OutboxRecord[];
  /** Files kept aside: records that can't be read, and anything else in the folder. */
  readonly aside: readonly string[];
  /**
   * A Sign out's delete: `none` when none is owed. While one is owed, nothing sends and nothing is added. `failed` once
   * a try has failed, until one finishes it; `failed-unmarked` when its marker isn't on disk either, so a relaunch
   * would read the records instead of deleting them.
   */
  readonly deletion: "none" | "owed" | "failed" | "failed-unmarked";
}

/**
 * Why enqueue didn't resolve, when it isn't a disk error: no account signed in or records not read yet, a write the
 * route would refuse, or `indeterminate`: the record may be on disk, withheld under `operationId`, and `retryEnqueue`
 * sends it as that one operation. `not-deleted`: Sign out couldn't make its delete safe.
 */
export class OutboxError extends Error {
  constructor(
    readonly kind: "closed" | "invalid" | "indeterminate" | "not-deleted",
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
};

export interface Outbox {
  state(): OutboxState;
  /** Calls `listener` after each change to `state()`. Returns a stop. */
  subscribe(listener: () => void): () => void;
  /**
   * Adds a write for the signed-in account, and resolves once its record is durable. A reply whose `threadId` is null
   * names, in `dependsOn`, the outbox post or send it replies to. A reaction names its message's `thread`. Rejects with
   * a disk error when nothing was kept, and as `indeterminate` when the record may be kept, withheld.
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
   * What Sign out would delete: messages never sent, withheld or refused, and messages that may still send. Null until
   * the records are read, so a sheet never says nothing is lost when it can't know.
   */
  signOutCounts(): { readonly unsent: number; readonly maySend: number } | null;
  /** A read of the workspace showed these messages: saved records whose result they show are deleted. */
  handoff(
    account: Pick<SignIn, "origin" | "userId">,
    workspaceId: string,
    messages: readonly ChatMessage[],
  ): void;
  /**
   * Stops sending and deletes every record, calling `leave` once the delete can't be lost: after the marker lands, or
   * after the folder is empty. Resolves once the delete is done, or has failed after `leave`. Rejects as
   * `not-deleted`, without calling `leave`, when neither happened. Either way a delete not done stays owed, and the
   * outbox closed, until `wake` or a sign-in finishes it.
   */
  signOut(leave: () => Promise<void>): Promise<void>;
  /** Tries again what failed: reading, a Sign out's delete, and dependency changes. Cuts every retry wait short. */
  wake(): void;
  /**
   * Reads the records, then sends with each sign-in, once any delete Sign out owes has finished. A 401 only pauses.
   * Returns a stop.
   */
  follow(account: {
    state(): AccountState;
    subscribe(listener: () => void): () => void;
  }): () => void;
}

const FORMAT = 1;
const COUNTER = "counter";
/** Written first and deleted last by Sign out's delete. */
const SIGNING_OUT = "signing-out";
const RECORD_NAME = /^m-(\d{12})$/;
const TEMPORARY_NAME = /^[A-Za-z0-9_-]{1,100}\.[0-9a-f]{32}\.tmp$/;
const nameOf = (sequence: number) => `m-${String(sequence).padStart(12, "0")}`;
const serialize = (record: OutboxRecord) => JSON.stringify({ format: FORMAT, ...record });
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
const ownedBy = (record: OutboxRecord, account: Pick<SignIn, "origin" | "userId">) =>
  record.origin === account.origin && record.accountId === account.userId;
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

/** A reply given the thread its saved outbox post or send named, or null while it named none. */
function withThread(
  write: ChatWrite,
  parent: OutboxRecord | undefined,
): { readonly write: ChatWrite; readonly target: Target } | null {
  const threadId = savedThread(parent);
  if (threadId === null || write.operation !== "reply") return null;
  return {
    write: { operation: "reply", args: { ...write.args, threadId } },
    target: { kind: "thread", id: threadId },
  };
}

export function createOutbox(options: {
  readonly files: DurableFiles;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The wait before trying again after `failures` failed or pending answers, or failed changes, in a row. */
  readonly retryMs?: (failures: number) => number;
  readonly stalledAfterMs?: number;
  readonly stalledRetryMs?: number;
}): Outbox {
  const { files } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? timerSleep;
  const retryMs =
    options.retryMs ?? ((failures) => Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS));
  const stalledAfterMs = options.stalledAfterMs ?? STALLED_AFTER_MS;
  const stalledRetryMs = options.stalledRetryMs ?? STALLED_RETRY_MS;

  let status: OutboxState["status"] = "loading";
  const records = new Map<number, OutboxRecord>();
  let aside: readonly string[] = [];
  let next = 1;
  /** The outbox's lifetime. Sign out moves it on. */
  let epoch = 0;
  let session: SignIn | null = null;
  /**
   * A Sign out's delete hasn't finished, so nothing sends and nothing is added. It's kept in memory, and on disk only
   * once the marker lands. The limit: if neither the marker nor the delete reached the disk and the app closes, a
   * relaunch can't tell the records left from ones a 401 kept. It reads them, and a later sign-in to their account
   * sends them.
   */
  let owed = false;
  /** The owed delete's marker is on disk: its write resolved, or a launch found it. */
  let marked = false;
  /** A try at the owed delete failed, and none has finished it since. */
  let deleteFailed = false;
  /** The try at the owed delete running now, shared by every call in the same lifetime. */
  let deleting: { readonly at: number; readonly done: Promise<void> } | null = null;
  const listeners = new Set<() => void>();
  /** The sender of each record being sent, by sequence. */
  const running = new Map<number, AbortController>();
  /** Records whose dependency change is being written. */
  const changing = new Set<number>();
  /** Workspaces, by scope, whose records wait after repeated 404s. */
  const unreachable = new Set<string>();
  /** The latest messages reads showed, for one account and workspace. */
  let observed: { readonly scope: string; readonly messages: Map<string, ChatMessage> } | null =
    null;
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
   * durable. Resolves false when nothing changed: the record went, the outbox was deleted, `valid` failed, `change`
   * returned null, or the write failed. After an `unsynced` failure the disk may hold either version; the next change
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
        await files.write(nameOf(sequence), serialize(updated));
      } catch {
        return false;
      }
      // Signed out meanwhile: the delete queued behind this write removes it.
      if (epoch !== at) return false;
      records.set(sequence, updated);
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

  /** Reads every record and the counter, unless a Sign out's delete is owed, which it finishes first. */
  function load(): Promise<void> {
    const at = epoch;
    return serial(async () => {
      if (epoch !== at || owed) return;
      const found = new Map<number, OutboxRecord>();
      const kept: string[] = [];
      let counter = 1;
      try {
        const listed = await files.list();
        if (listed.includes(SIGNING_OUT)) {
          owed = true;
          marked = true;
          changed();
          return;
        }
        const recovery = await files.recover();
        const unreadable = new Set(recovery.unreadable);
        kept.push(...recovery.leftovers);
        const readable = (name: string) =>
          unreadable.has(name)
            ? Promise.resolve(null)
            : files.read(name).catch((error: unknown) => {
                if (error instanceof DurableFileError && error.kind === "unreadable") return null;
                throw error;
              });
        for (const name of listed) {
          if (name === COUNTER) {
            // A counter that can't be read is only a number: the records' names give it again.
            counter = Math.max(counter, readCounter(await readable(name)));
            continue;
          }
          const match = RECORD_NAME.exec(name);
          if (!match) {
            kept.push(name);
            continue;
          }
          const sequence = Number(match[1]);
          counter = Math.max(counter, sequence + 1);
          const record = readRecord(await readable(name), sequence);
          if (record) found.set(sequence, record);
          else kept.push(name);
        }
      } catch (error) {
        if (epoch !== at) return;
        status = error instanceof DurableFileError && error.kind === "locked" ? "locked" : "failed";
        changed();
        return;
      }
      if (epoch !== at) return;
      records.clear();
      for (const [sequence, record] of found) records.set(sequence, record);
      aside = kept.sort();
      next = counter;
      status = "ready";
      changed();
      reconcile();
      pump();
    }).then(() => {
      if (owed && epoch === at) return finishDelete();
    });
  }

  /**
   * Removes every file the folder lists except `keep`, and every temporary leftover, trying each even after one fails.
   * Resolves whether the folder now holds nothing else.
   */
  async function clearFolder(keep: string | null): Promise<boolean> {
    let failed = false;
    const attempt = (run: () => Promise<void>) =>
      run().catch(() => {
        failed = true;
      });
    try {
      for (const name of await files.list())
        if (name !== keep) await attempt(() => files.remove(name));
      for (const name of (await files.recover()).leftovers)
        if (TEMPORARY_NAME.test(name)) await attempt(() => files.removeLeftover(name));
      return !failed && (await files.list()).every((name) => name === keep);
    } catch {
      return false;
    }
  }

  /** Removes `name`, present or not, and resolves whether the folder synced after it. */
  const removed = (name: string) =>
    files.remove(name).then(
      () => true,
      () => false,
    );

  /**
   * Makes the owed delete safe to finish later: writes the marker, unless it's on disk already. Without it, a kill would
   * lose the delete, so every file must go now. Runs in the queue.
   */
  async function secure(): Promise<"marked" | "deleted" | "kept"> {
    if (!marked) {
      marked = await files.write(SIGNING_OUT, "{}").then(
        () => true,
        () => false,
      );
      changed();
    }
    if (marked) return "marked";
    // An empty folder may hold deletes an earlier try couldn't sync. Removing the absent marker syncs the folder.
    return (await clearFolder(null)) && (await removed(SIGNING_OUT)) ? "deleted" : "kept";
  }

  /** Deletes every file but the marker, then the marker. Runs in the queue. */
  async function eraseMarked(): Promise<boolean> {
    if (!(await clearFolder(SIGNING_OUT)) || !(await removed(SIGNING_OUT))) return false;
    marked = false;
    return true;
  }

  function failDelete() {
    status = "failed";
    deleteFailed = true;
    changed();
  }

  function deleteDone() {
    owed = false;
    marked = false;
    deleteFailed = false;
    changed();
  }

  /**
   * Tries the owed delete in the queue: the marker if it isn't on disk, then every other file, then the marker; or, if
   * the marker still can't be written, every file at once. Resolves whether it finished. A failure keeps the outbox
   * closed until the next try.
   */
  function erase(at: number): Promise<boolean> {
    return serial(async () => {
      if (!owed) return false;
      const outcome = await secure();
      if (outcome === "kept" || (outcome === "marked" && !(await eraseMarked()))) {
        failDelete();
        return false;
      }
      if (epoch !== at) return false;
      deleteDone();
      return true;
    }).catch(() => false);
  }

  /**
   * Makes `run` the try at the owed delete that every call in lifetime `at` shares, and reads the empty folder once it
   * finishes. `run` resolves whether it finished.
   */
  function track(at: number, run: Promise<boolean>): Promise<void> {
    const done: Promise<void> = run
      .catch(() => false)
      .then((finished) => {
        if (deleting?.done === done) deleting = null;
        if (finished) return load();
      });
    deleting = { at, done };
    return done;
  }

  /** Tries the owed delete, or shares the try under way. A Sign out that starts meanwhile owns the delete from then. */
  function finishDelete(): Promise<void> {
    if (deleting?.at === epoch) return deleting.done;
    return track(epoch, erase(epoch));
  }

  /** Deletes saved records whose result the latest reads show. */
  function reconcile() {
    if (status !== "ready" || !observed) return;
    const { scope, messages } = observed;
    for (const record of records.values())
      if (record.stage === "saved" && scopeOf(record) === scope && shows(record, messages))
        forget(record.sequence);
  }

  function forget(sequence: number) {
    const at = epoch;
    void serial(async () => {
      const record = records.get(sequence);
      // Checked here, after every change queued before it, such as a reply accepted meanwhile that needs its thread.
      if (epoch !== at || record?.stage !== "saved" || needed(record)) return;
      await files.remove(nameOf(sequence));
      if (epoch !== at) return;
      records.delete(sequence);
      changed();
    }).catch(() => undefined);
  }

  /**
   * Settles what dependencies can, then starts each lane's oldest unfinished record, unless any record of that lane is
   * running. Every record's lane is worked out before anything starts, and a reply whose outbox post or send is saved
   * already belongs to that thread's lane.
   */
  function pump() {
    if (status !== "ready" || owed) return;
    const ordered = [...records.values()].sort((a, b) => a.sequence - b.sequence);
    const heads = new Map<string, OutboxRecord>();
    const busy = new Set<string>();
    for (const record of ordered) {
      if (!unfinished(record) || record.withheld) continue;
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
      if (running.has(record.sequence)) busy.add(lane);
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
      !own.signal.aborted && epoch === at && session === signIn && signIn.isCurrent();
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
        if (!record || !unfinished(record) || record.withheld) return;
        if (record.stage === "queued") {
          // Written before the request goes, so a relaunch knows the server may have it.
          const marked = await commit(
            sequence,
            (current) =>
              current.stage === "queued" ? { ...current, stage: "sending", attempted: true } : null,
            live,
          );
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
      // The next record in its lane, or this one again for a sign-in that replaced this sender's.
      pump();
    }
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
   * Writes a new or retried record withheld, then sendable, so the disk never holds it sendable before enqueue can say
   * it was kept. A failed withheld write rejects as the disk error, or as `indeterminate` once its rename may stand. A
   * failed sendable write leaves the withheld record and rejects as `indeterminate`.
   */
  async function place(record: OutboxRecord, at: number): Promise<OutboxRecord> {
    const name = nameOf(record.sequence);
    const withheld = { ...record, withheld: true };
    const sendable = { ...record, withheld: false };
    const unsynced = (error: unknown) =>
      error instanceof DurableFileError && error.kind === "unsynced";
    const keepWithheld = () => {
      // Signed out meanwhile: the delete queued behind this write removes it.
      if (epoch !== at) return new OutboxError("closed");
      records.set(record.sequence, withheld);
      changed();
      return new OutboxError("indeterminate", record.operationId);
    };
    try {
      await files.write(name, serialize(withheld));
    } catch (error) {
      if (!unsynced(error)) throw error;
      throw keepWithheld();
    }
    if (epoch !== at) throw new OutboxError("closed");
    try {
      await files.write(name, serialize(sendable));
    } catch (error) {
      // An unsynced write was renamed: the disk holds the sendable record, or the withheld one if a crash reverts it.
      if (!unsynced(error)) throw keepWithheld();
    }
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
        records: [...records.values()].sort((a, b) => a.sequence - b.sequence),
        aside,
        deletion: !owed ? "none" : !deleteFailed ? "owed" : marked ? "failed" : "failed-unmarked",
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
      if (status !== "ready" || owed || !signIn || !signIn.isCurrent())
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
        if (epoch !== at || status !== "ready" || owed) throw new OutboxError("closed");
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
        // A sequence is never reused, even when a write below fails: a gap keeps the order.
        const sequence = next;
        next += 1;
        await files.write(COUNTER, JSON.stringify({ format: FORMAT, next }));
        if (epoch !== at) throw new OutboxError("closed");
        const operationId = crypto.randomUUID();
        return place(
          {
            origin: signIn.origin,
            accountId: signIn.userId,
            workspaceId,
            operationId,
            sequence,
            dependsOn,
            target: waitsIn,
            write: accepted,
            messageId: await derivedMessageId(signIn.userId, workspaceId, operationId, accepted),
            stage: "queued",
            attempted: false,
            withheld: false,
            pendingSinceMs: null,
            result: null,
          },
          at,
        );
      });
    },

    retryEnqueue(operationId) {
      const at = epoch;
      return serial(async () => {
        const signIn = session;
        if (epoch !== at || status !== "ready" || owed || !signIn) throw new OutboxError("closed");
        const record = [...records.values()].find(
          (entry) => entry.operationId === operationId && entry.withheld && ownedBy(entry, signIn),
        );
        if (!record) throw new OutboxError("invalid");
        return place(record, at);
      });
    },

    signOutCounts() {
      if (status !== "ready" || owed) return null;
      let unsent = aside.filter((name) => RECORD_NAME.test(name)).length;
      let maySend = 0;
      for (const record of records.values()) {
        // An answer refused as already answered still published its reply.
        if (record.stage === "refused")
          unsent +=
            record.result?.kind === "refused" && record.result.reason === "already answered"
              ? 0
              : 1;
        else if (!unfinished(record)) continue;
        else if (record.attempted && !record.withheld) maySend += 1;
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
      reconcile();
      pump();
    },

    signOut(leave) {
      epoch += 1;
      const at = epoch;
      stopSending();
      records.clear();
      aside = [];
      observed = null;
      unreachable.clear();
      owed = true;
      status = "loading";
      changed();
      const left = serial(async () => {
        const outcome = await secure();
        // The records stay on disk, unread, until a later try deletes them.
        if (outcome === "kept") failDelete();
        else if (outcome === "deleted" && epoch === at) deleteDone();
        return outcome;
      }).then(async (outcome) => {
        if (outcome === "kept") throw new OutboxError("not-deleted");
        await leave();
        return outcome;
      });
      // This is the try every call shares until it ends, so the signed-out notice `leave` sends, a sign-in or `wake`
      // can't delete the records before `leave` has deleted the token.
      const done = track(
        at,
        left.then((outcome) => (outcome === "marked" ? erase(at) : epoch === at)),
      );
      // Settles after the try has ended, so a `wake` the caller makes next starts a new one.
      return done.then(() => left).then(() => undefined);
    },

    wake() {
      nudge.abort();
      nudge = new AbortController();
      unreachable.clear();
      if (owed) void finishDelete();
      else if (status === "locked" || status === "failed") void load();
      else pump();
    },

    follow(account) {
      const take = () => {
        const state = account.state();
        const signIn = state.status === "signed-in" ? state.signIn : null;
        if (signIn === session) return;
        session = signIn;
        observed = null;
        unreachable.clear();
        stopSending();
        // A delete Sign out owes finishes before anything sends with this sign-in.
        if (owed) void finishDelete();
        else pump();
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
const emojiKey = (emoji: string) => emoji.trim().normalize("NFC");

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

function readCounter(saved: string | null): number {
  try {
    const value: unknown = saved === null ? null : JSON.parse(saved);
    return isFields(value) && value.format === FORMAT && count(value.next) ? value.next : 1;
  } catch {
    return 1;
  }
}

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

/** A record as this build writes it, or null for anything else, which is kept aside. */
function readRecord(saved: string | null, sequence: number): OutboxRecord | null {
  let value: unknown;
  try {
    value = saved === null ? null : JSON.parse(saved);
  } catch {
    return null;
  }
  if (!isFields(value) || value.format !== FORMAT || value.sequence !== sequence) return null;
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
