import type { AccountState, SignIn } from "./account";
import { isFields, text } from "./api";
import { isRefusalReason, readChatWrite, sendWrite, type ChatWrite, type RefusalReason, type WriteAnswer } from "./chatWrites";
import { ServerError } from "./client";
import { sleep as timerSleep } from "./deviceFlow";
import { DurableFileError, type DurableFiles } from "./durableFiles";
import type { ChatMessage } from "./workspaceReads";

// The phone's outbox: chat writes the person made, kept on disk until the server has them and a read shows them.
// It is one account-level store beside the read cache, never inside a workspace's store, so switching workspace
// doesn't touch it.
//
// Each write is one record file, named by its sequence number, written through the durable-file module
// (durableFiles.ts). Enqueue resolves only once the record would survive a crash or power loss. A counter file, written
// first, gives each record the next sequence, so order survives a relaunch. Nothing here deletes a record except a read
// that shows its result, and Sign out. A record that can't be read, and any other file in the folder, is kept aside.
//
// Only a sign-in with the record's own server and account sends it. Within each account, workspace, and thread or
// stream, only the oldest unfinished record is sent. A reply to a post or send still in the outbox waits until that
// write is saved, then takes the thread its result names. A record that may have reached the server is asked again
// with the same operation ID and arguments until it's saved or refused, so it is written at most once. A 401 pauses
// sending and keeps every record. Sign out stops sending, then deletes the folder.
//
// Every disk change runs in one queue. A change checks the outbox's lifetime, which Sign out moves on, after each
// wait, so a late answer can neither update another account's record nor bring back a deleted one.

/**
 * `queued`: never sent. `sending`: a request may have reached the server, and it's asked again until it settles.
 * `stalled`: the server has answered `pending` for longer than the stall threshold; it may still be saved, so it's
 * asked again, more slowly. `saved` and `refused` are settled.
 */
type OutboxStage = "queued" | "sending" | "saved" | "stalled" | "refused";

/** How a record settled. `missing` is a target the server can't find or hides, as reads answer one. */
type OutboxResult =
  | { readonly kind: "saved"; readonly threadId: string | null; readonly messageId: string | null }
  | { readonly kind: "refused"; readonly reason: RefusalReason; readonly threadId: string | null; readonly winnerMessageId: string | null }
  | { readonly kind: "missing"; readonly reason: string };

interface OutboxRecord {
  readonly origin: string;
  readonly accountId: string;
  readonly workspaceId: string;
  /** Minted once on the phone, and sent with every ask. */
  readonly operationId: string;
  readonly sequence: number;
  /** The operation ID of the outbox write this one waits for. */
  readonly dependsOn: string | null;
  /** The write's target is in its arguments: the group, stream, thread or message. */
  readonly write: ChatWrite;
  readonly stage: OutboxStage;
  /**
   * A request may have reached the server. It's written before the first request goes, and never unset, so Sign out
   * can tell a message never sent from one that may still send.
   */
  readonly attempted: boolean;
  /** When the server first answered `pending`, until the write settles. */
  readonly pendingSinceMs: number | null;
  readonly result: OutboxResult | null;
}

interface OutboxState {
  /**
   * `locked`: iOS hasn't been unlocked since the phone started, so the records can't be read yet. `failed`: reading
   * them failed. Both read again at the next app-state change.
   */
  readonly status: "loading" | "locked" | "failed" | "ready";
  /** In sequence order. */
  readonly records: readonly OutboxRecord[];
  /** Files kept aside: records that can't be read, and anything else in the folder. */
  readonly aside: readonly string[];
}

/** Why enqueue refused before writing anything: no account signed in or records not read yet, or a write the route would refuse. */
export class OutboxError extends Error {
  constructor(readonly kind: "closed" | "invalid") {
    super(kind === "closed" ? "The outbox isn't open." : "The write isn't valid.");
    this.name = "OutboxError";
  }
}

export interface Outbox {
  state(): OutboxState;
  /**
   * Adds a write for the signed-in account, and resolves once its record is durable. A reply whose `threadId` is null
   * names, in `dependsOn`, the outbox post or send it replies to. Rejects, keeping nothing, when the record isn't
   * durable, including a write that landed but whose folder sync failed.
   */
  enqueue(input: { readonly workspaceId: string; readonly write: ChatWrite; readonly dependsOn?: string }): Promise<OutboxRecord>;
  /** What Sign out would delete: messages never sent, or refused, and messages that may still send. */
  signOutCounts(): { readonly unsent: number; readonly maySend: number };
  /** A read of the workspace showed these messages: saved records whose result they show are deleted. */
  handoff(account: Pick<SignIn, "origin" | "userId">, workspaceId: string, messages: readonly ChatMessage[]): void;
  /** Reads the records again if that failed, and cuts every retry wait short. Call it at each app-state change. */
  wake(): void;
  /** Reads the records, then sends with each sign-in. Sign out deletes them; a 401 only pauses. Returns a stop. */
  follow(account: { state(): AccountState; subscribe(listener: () => void): () => void }): () => void;
}

const FORMAT = 1;
const COUNTER = "counter";
const RECORD_NAME = /^m-(\d{12})$/;
const nameOf = (sequence: number) => `m-${String(sequence).padStart(12, "0")}`;
const DEPENDENCY_REFUSED: RefusalReason = "The message it replies to wasn't sent";
const COULD_NOT_SEND: RefusalReason = "Couldn't send";

const RETRY_MS = 1000;
const RETRY_MAX_MS = 60_000;
/**
 * The wire never says stalled: the relay answers `pending` for any unfinished write. The phone calls a write stalled
 * once the server has answered `pending` for 10 minutes. A write that publishes takes seconds, so by then it's held up.
 */
const STALLED_AFTER_MS = 10 * 60_000;
const STALLED_RETRY_MS = 5 * 60_000;

const unfinished = (record: OutboxRecord) => record.stage === "queued" || record.stage === "sending" || record.stage === "stalled";
/** A reply still waiting for the thread its outbox post or send will name. */
const needsThread = (record: OutboxRecord) => record.write.operation === "reply" && record.write.args.threadId === null;
const ownedBy = (record: OutboxRecord, account: Pick<SignIn, "origin" | "userId">) =>
  record.origin === account.origin && record.accountId === account.userId;
const sameScope = (a: OutboxRecord, b: OutboxRecord) =>
  a.origin === b.origin && a.accountId === b.accountId && a.workspaceId === b.workspaceId;

/** One unfinished record at a time per lane: its account and workspace, and the thread or stream it writes to. */
function laneOf(record: OutboxRecord): string {
  const { write } = record;
  const target = write.operation === "post" ? `stream:${write.args.groupId}`
    : write.operation === "send" ? `stream:${write.args.streamId}`
    : write.operation === "reply" ? (write.args.threadId === null ? `after:${record.dependsOn}` : `thread:${write.args.threadId}`)
    : `message:${write.args.messageId}`;
  return JSON.stringify([record.origin, record.accountId, record.workspaceId, target]);
}

/** 400 and 413: the route refused the write's form or size, so asking again can't help. Anything else may have saved it. */
const isTerminal = (error: unknown) => error instanceof ServerError && (error.status === 400 || error.status === 413);

export function createOutbox(options: {
  readonly files: DurableFiles;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The wait before asking again after `failures` failed or pending answers in a row. */
  readonly retryMs?: (failures: number) => number;
  readonly stalledAfterMs?: number;
  readonly stalledRetryMs?: number;
}): Outbox {
  const { files } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? timerSleep;
  const retryMs = options.retryMs ?? (failures => Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS));
  const stalledAfterMs = options.stalledAfterMs ?? STALLED_AFTER_MS;
  const stalledRetryMs = options.stalledRetryMs ?? STALLED_RETRY_MS;

  let status: OutboxState["status"] = "loading";
  const records = new Map<number, OutboxRecord>();
  let aside: readonly string[] = [];
  let next = 1;
  /** The outbox's lifetime. Sign out moves it on. */
  let epoch = 0;
  let session: SignIn | null = null;
  /** The sender of each record being sent, by sequence. */
  const running = new Map<number, AbortController>();
  /** Aborts to cut every retry wait short. */
  let nudge = new AbortController();
  let snapshot: OutboxState | null = null;

  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  }

  const changed = () => { snapshot = null; };

  /**
   * Writes the record's next version, worked out from the current one inside the queue, and keeps it once it's
   * durable. Resolves false when nothing changed: the record went, the outbox was deleted, `valid` failed, `change`
   * returned null, or the write failed. After an `unsynced` failure the disk may hold either version; the next change
   * writes over it.
   */
  function commit(sequence: number, change: (record: OutboxRecord) => OutboxRecord | null, valid = () => true): Promise<boolean> {
    const at = epoch;
    return serial(async () => {
      const current = records.get(sequence);
      const updated = epoch === at && valid() && current ? change(current) : null;
      if (!updated) return false;
      try {
        await files.write(nameOf(sequence), JSON.stringify({ format: FORMAT, ...updated }));
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

  /** Reads every record and the counter. A locked phone or a failed read leaves it closed until `wake`. */
  function load(): Promise<void> {
    const at = epoch;
    return serial(async () => {
      if (epoch !== at) return;
      const found = new Map<number, OutboxRecord>();
      const kept: string[] = [];
      let counter = 1;
      try {
        const recovery = await files.recover();
        const unreadable = new Set(recovery.unreadable);
        kept.push(...recovery.leftovers);
        const readable = (name: string) => unreadable.has(name) ? Promise.resolve(null) : files.read(name).catch((error: unknown) => {
          if (error instanceof DurableFileError && error.kind === "unreadable") return null;
          throw error;
        });
        for (const name of await files.list()) {
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
      pump();
    });
  }

  /** Starts each lane's oldest unfinished record that can go, and settles the dependencies that are known. */
  function pump() {
    if (status !== "ready") return;
    const ordered = [...records.values()].sort((a, b) => a.sequence - b.sequence);
    const lanes = new Set<string>();
    for (const record of ordered) {
      if (!unfinished(record)) continue;
      const lane = laneOf(record);
      if (lanes.has(lane)) continue;
      lanes.add(lane);
      if (record.stage === "queued" && record.dependsOn !== null) {
        const parent = ordered.find(other => other.operationId === record.dependsOn && sameScope(other, record));
        if (parent && parent.stage !== "saved" && parent.stage !== "refused") continue;
        if (parent?.stage === "refused" || (!parent && needsThread(record))) {
          refuse(record.sequence, DEPENDENCY_REFUSED);
          continue;
        }
        if (parent && needsThread(record)) {
          takeThread(record.sequence, parent.result?.kind === "saved" ? parent.result.threadId : null);
          continue;
        }
      }
      if (session?.isCurrent() && ownedBy(record, session) && !running.has(record.sequence)) void run(record.sequence, session);
    }
  }

  /** Refuses a record never sent, keeping its text. */
  function refuse(sequence: number, reason: RefusalReason) {
    void commit(sequence, record => record.stage === "queued" && !record.attempted
      ? { ...record, stage: "refused", result: { kind: "refused", reason, threadId: null, winnerMessageId: null } }
      : null).then(done => done && pump());
  }

  /** Gives a waiting reply the thread its saved post or send named. */
  function takeThread(sequence: number, threadId: string | null) {
    if (threadId === null) return refuse(sequence, COULD_NOT_SEND);
    void commit(sequence, record => record.stage === "queued" && record.write.operation === "reply" && record.write.args.threadId === null
      ? { ...record, write: { operation: "reply", args: { ...record.write.args, threadId } } }
      : null).then(done => done && pump());
  }

  /** Sends one record, and asks again until it settles or this sender has to stop. */
  async function run(sequence: number, signIn: SignIn) {
    const own = new AbortController();
    running.set(sequence, own);
    const at = epoch;
    const live = () => !own.signal.aborted && epoch === at && session === signIn && signIn.isCurrent();
    let failures = 0;
    /** Waits before the next ask. `wake` cuts it short; a stop ends it. */
    const rest = async (stalled: boolean) => {
      failures += 1;
      const wait = new AbortController();
      const end = () => wait.abort();
      const woken = nudge.signal;
      own.signal.addEventListener("abort", end);
      woken.addEventListener("abort", end);
      try {
        await sleep(stalled ? stalledRetryMs : retryMs(failures), wait.signal);
      } catch {
        // Cut short.
      } finally {
        own.signal.removeEventListener("abort", end);
        woken.removeEventListener("abort", end);
      }
    };
    try {
      while (live()) {
        const record = records.get(sequence);
        if (!record || !unfinished(record)) return;
        if (record.stage === "queued") {
          // Written before the request goes, so a relaunch knows the server may have it.
          const marked = await commit(sequence, current => current.stage === "queued" ? { ...current, stage: "sending", attempted: true } : null, live);
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
          answer = await sendWrite(signIn.client, sent.workspaceId, sent.operationId, sent.write, own.signal);
        } catch (error) {
          // A 401, or the sign-in ending, has already stopped this sender.
          if (!live()) return;
          if (isTerminal(error)) {
            if (await settle(sequence, { kind: "refused", reason: COULD_NOT_SEND, threadId: null, winnerMessageId: null }, live) || !live()) return;
            await rest(sent.stage === "stalled");
            continue;
          }
          // Offline, a timeout, a dropped answer, or a server failure: the write may be saved. Ask again, the same.
          await rest(sent.stage === "stalled");
          continue;
        }
        if (!live()) return;
        if (answer.kind === "pending") {
          const since = sent.pendingSinceMs ?? now();
          const stage = sent.stage === "stalled" || now() - since >= stalledAfterMs ? "stalled" : "sending";
          await commit(sequence, current => unfinished(current) && (current.pendingSinceMs !== since || current.stage !== stage)
            ? { ...current, pendingSinceMs: since, stage }
            : null, live);
          if (!live()) return;
          await rest(stage === "stalled");
          continue;
        }
        // A record whose answer couldn't be written is asked again; the server answers the same.
        if (await settle(sequence, answer, live) || !live()) return;
        await rest(sent.stage === "stalled");
      }
    } finally {
      if (running.get(sequence) === own) running.delete(sequence);
      // The next record in its lane, or this one again for a sign-in that replaced this sender's.
      pump();
    }
  }

  function settle(sequence: number, result: OutboxResult, valid: () => boolean): Promise<boolean> {
    return commit(sequence, record => unfinished(record)
      ? { ...record, stage: result.kind === "saved" ? "saved" : "refused", pendingSinceMs: null, result }
      : null, valid);
  }

  function stopSending() {
    for (const sender of running.values()) sender.abort();
  }

  /** Sign out: stops sending, then deletes every file the folder holds, then reads what's left. */
  function deleteAll() {
    epoch += 1;
    stopSending();
    const at = epoch;
    records.clear();
    aside = [];
    status = "loading";
    changed();
    void serial(async () => {
      const names = await files.list().catch(() => []);
      const leftovers = (await files.recover().catch(() => ({ leftovers: [] }))).leftovers;
      for (const name of names) await files.remove(name).catch(() => undefined);
      // Only temporary files go this way. Anything else the module won't delete stays aside.
      for (const name of leftovers) await files.removeLeftover(name).catch(() => undefined);
    }).then(() => {
      if (epoch === at) void load();
    });
  }

  return {
    state() {
      snapshot ??= { status, records: [...records.values()].sort((a, b) => a.sequence - b.sequence), aside };
      return snapshot;
    },

    enqueue(input) {
      const write = readChatWrite(input.write);
      const signIn = session;
      const dependsOn = input.dependsOn ?? null;
      if (status !== "ready" || !signIn || !signIn.isCurrent()) return Promise.reject(new OutboxError("closed"));
      const { workspaceId } = input;
      if (!write || !text(workspaceId, 256) || workspaceId === "." || workspaceId === ".." || (dependsOn !== null && !text(dependsOn, 128))) {
        return Promise.reject(new OutboxError("invalid"));
      }
      // A reply waiting for its thread needs the outbox post or send it replies to.
      if (write.operation === "reply" && write.args.threadId === null && ![...records.values()].some(record =>
        record.operationId === dependsOn && ownedBy(record, signIn) && record.workspaceId === workspaceId &&
        (record.write.operation === "post" || record.write.operation === "send") && record.stage !== "refused")) {
        return Promise.reject(new OutboxError("invalid"));
      }
      const at = epoch;
      return serial(async () => {
        if (epoch !== at || status !== "ready") throw new OutboxError("closed");
        // A sequence is never reused, even when a write below fails: a gap keeps the order.
        const sequence = next;
        next += 1;
        await files.write(COUNTER, JSON.stringify({ format: FORMAT, next }));
        if (epoch !== at) throw new OutboxError("closed");
        const record: OutboxRecord = {
          origin: signIn.origin, accountId: signIn.userId, workspaceId, operationId: crypto.randomUUID(), sequence, dependsOn, write,
          stage: "queued", attempted: false, pendingSinceMs: null, result: null,
        };
        try {
          await files.write(nameOf(sequence), JSON.stringify({ format: FORMAT, ...record }));
        } catch (error) {
          // The record may stand, though it isn't known to survive power loss. It goes, so a relaunch never sends a
          // message the person was told wasn't kept.
          if (error instanceof DurableFileError && error.kind === "unsynced") await files.remove(nameOf(sequence)).catch(() => undefined);
          throw error;
        }
        // Signed out meanwhile: the delete queued behind this write removes it.
        if (epoch !== at) throw new OutboxError("closed");
        records.set(sequence, record);
        changed();
        pump();
        return record;
      });
    },

    signOutCounts() {
      let unsent = aside.filter(name => RECORD_NAME.test(name)).length;
      let maySend = 0;
      for (const record of records.values()) {
        if (record.stage === "refused" || (unfinished(record) && !record.attempted)) unsent += 1;
        else if (unfinished(record)) maySend += 1;
      }
      return { unsent, maySend };
    },

    handoff(account, workspaceId, messages) {
      const shown = new Map(messages.map(message => [message.id, message]));
      const all = [...records.values()];
      for (const record of all) {
        if (record.stage !== "saved" || !ownedBy(record, account) || record.workspaceId !== workspaceId || !shows(record, shown)) continue;
        // A reply still waiting for this write's thread reads it from this record.
        if (all.some(other => other.dependsOn === record.operationId && sameScope(other, record) && needsThread(other))) continue;
        const at = epoch;
        const { sequence } = record;
        void serial(async () => {
          if (epoch !== at || records.get(sequence)?.stage !== "saved") return;
          await files.remove(nameOf(sequence));
          if (epoch !== at) return;
          records.delete(sequence);
          changed();
        }).catch(() => undefined);
      }
    },

    wake() {
      nudge.abort();
      nudge = new AbortController();
      if (status === "locked" || status === "failed") void load();
    },

    follow(account) {
      let serving = account.state();
      const take = (state: AccountState) => {
        const signIn = state.status === "signed-in" ? state.signIn : null;
        if (signIn === session) return;
        session = signIn;
        stopSending();
        pump();
      };
      take(serving);
      void load();
      const unsubscribe = account.subscribe(() => {
        const last = serving;
        serving = account.state();
        take(serving);
        // Only Sign out deletes: a 401, or a launch with no sign-in, keeps every record.
        if (last.status === "signed-in" && serving.status === "signed-out" && !serving.ended) deleteAll();
      });
      return () => {
        unsubscribe();
        session = null;
        stopSending();
      };
    },
  };
}

/** Whether a read shows a saved record's result: its message by ID, its answer resolved, or its reaction as sent. */
function shows(record: OutboxRecord, shown: ReadonlyMap<string, ChatMessage>): boolean {
  const { write, result } = record;
  if (write.operation === "react") {
    const target = shown.get(write.args.messageId);
    if (!target) return false;
    const has = target.reactions.some(reaction =>
      reaction.emoji === write.args.emoji && reaction.authorKind === "human" && reaction.authorId === record.accountId);
    return has === (write.args.state === "added");
  }
  const messageId = result?.kind === "saved" ? result.messageId : null;
  if (messageId === null || !shown.has(messageId)) return false;
  // An answer's question, when the read shows it, shows it answered.
  const question = write.operation === "reply" && write.args.resolves ? shown.get(write.args.resolves.messageId) : undefined;
  return question === undefined || question.decisionState === "resolved";
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function readCounter(saved: string | null): number {
  try {
    const value: unknown = saved === null ? null : JSON.parse(saved);
    return isFields(value) && value.format === FORMAT && count(value.next) ? value.next : 1;
  } catch {
    return 1;
  }
}

const STAGES: ReadonlySet<string> = new Set<OutboxStage>(["queued", "sending", "saved", "stalled", "refused"]);
const isStage = (value: unknown): value is OutboxStage => typeof value === "string" && STAGES.has(value);
const id = (value: unknown): value is string => text(value, 256);
const idOrNull = (value: unknown): value is string | null => value === null || id(value);

function readResult(value: unknown): OutboxResult | null | undefined {
  if (value === null) return null;
  if (!isFields(value)) return undefined;
  if (value.kind === "saved" && idOrNull(value.threadId) && idOrNull(value.messageId)) {
    return { kind: "saved", threadId: value.threadId, messageId: value.messageId };
  }
  if (value.kind === "refused" && isRefusalReason(value.reason) && idOrNull(value.threadId) && idOrNull(value.winnerMessageId)) {
    return { kind: "refused", reason: value.reason, threadId: value.threadId, winnerMessageId: value.winnerMessageId };
  }
  if (value.kind === "missing" && text(value.reason)) return { kind: "missing", reason: value.reason };
  return undefined;
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
  const { origin, accountId, workspaceId, operationId, dependsOn, stage, attempted, pendingSinceMs } = value;
  if (!write || result === undefined || !text(origin) || !id(accountId) || !id(workspaceId) || !text(operationId, 128) ||
    !(dependsOn === null || text(dependsOn, 128)) || !isStage(stage) || typeof attempted !== "boolean" ||
    !(pendingSinceMs === null || count(pendingSinceMs))) return null;
  // The stage and the result agree, and a reply without its thread waits for a write it names.
  if ((stage === "saved") !== (result?.kind === "saved")) return null;
  if ((stage === "refused") !== (result?.kind === "refused" || result?.kind === "missing")) return null;
  if (write.operation === "reply" && write.args.threadId === null && dependsOn === null) return null;
  return { origin, accountId, workspaceId, operationId, sequence, dependsOn, write, stage, attempted, pendingSinceMs, result };
}
