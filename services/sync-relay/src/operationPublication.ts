import { setTimeout as sleep } from "node:timers/promises";
import { asRecord } from "@dohc/workspace-core";
import {
  MAX_PUBLICATION_STAGE_KEYS,
  readOrdinaryPublicationState,
  type JsonValue,
  type OrdinaryPublicationState,
  type WorkspaceDaemonRequester,
} from "@dohc/workspace-engine-client";
import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import type { AutomationReplica } from "./automationReplicas";
import { stableJsonStringify } from "./canonicalJson";
import type { SyncRelayStorage } from "./storage";
import { OPERATION_TOMBSTONE_BATCH, type OperationRecord } from "./storage/operationRecords";
import { REFUSED_OP_KIND } from "./storage/relayAdmission";

// A phone write is saved only once the relay holds every record it made, as
// the relay accepted them. The engine writes a receipt for each stage of the
// write, naming the journal rows the stage added; the copy pushes them; the
// relay's row at each of those coordinates is then checked against what the
// write's stored command expects. Until then the write is pending. One whose
// folder goes first settles from what the relay holds then.

/** The answers a refused write gives the phone. No relay or engine text reaches it. */
export type RefusalReason =
  | "already answered"
  | "The message it replies to wasn't sent"
  | "This workspace changed on your server"
  | "Couldn't send"
  | "too old";
export const COULD_NOT_SEND: RefusalReason = "Couldn't send";
export const WORKSPACE_CHANGED: RefusalReason = "This workspace changed on your server";
export const TOO_OLD: RefusalReason = "too old";
const ALREADY_ANSWERED: RefusalReason = "already answered";
const REFUSAL_REASONS: ReadonlySet<string> = new Set<RefusalReason>([
  ALREADY_ANSWERED, "The message it replies to wasn't sent", WORKSPACE_CHANGED, COULD_NOT_SEND, TOO_OLD,
]);

/** Whether `reason` is one of the answers a refused write may give the phone. */
export function isRefusalReason(reason: string): reason is RefusalReason {
  return REFUSAL_REASONS.has(reason);
}

/** How long a request waits for its write to publish before it answers pending. */
export const PUBLICATION_DEADLINE_MS = 20_000;
// The wait between a request's attempts, doubling up to the most.
const FIRST_POLL_MS = 100;
const MAX_POLL_MS = 2_000;
const RECEIPT_DEADLINE_MS = 30_000;
// Whole-push relay rejections. They name no write, so they refuse none.
const WHOLE_PUSH_REJECTIONS = new Set<string>(["AUTHORSHIP_MISMATCH", "UNKNOWN_CHAT_OPERATION"]);

/**
 * What the write host keeps in an operation's command for its publication:
 * each engine stage the operation must commit, by its stage key, with the
 * records the relay must accept for it. Receipts list coordinates and no
 * payload, so these are what each accepted row is checked against.
 */
export type PublicationCommand = { stages: PublicationStage[] };
export type PublicationStage = {
  key: string;
  /** A `post` or `reply` stage writes the operation's message. */
  role: "post" | "reply" | "decision" | "reaction";
  records: ExpectedRecord[];
  /**
   * The thread a stage proposed when the engine may write to a running
   * conversation instead. Each expected field equal to it is compared with
   * the thread the stage's receipt names.
   */
  engineThread?: string;
};
export type ExpectedRecord = {
  /** The relay row's op kind, such as `chat.message.append`. */
  kind: string;
  /** Payload fields the accepted row holds, exactly. */
  fields: { [field: string]: JsonValue };
  /** A record the stage may not add, such as the follow a person's first message adds. */
  optional?: boolean;
};

/** What a settled write keeps as its result. */
export type OperationResult = { threadId: string | null; reason?: RefusalReason; winnerMessageId?: string };

export type Verdict =
  | { stage: "pending"; messagePublished: boolean }
  | { stage: "saved" | "refused"; messagePublished: boolean; result: OperationResult };

export type PublicationAnswer = { state: "saved" | "refused" | "pending"; record: OperationRecord | null };

/** Reads the receipts of these stage keys, in one engine snapshot. */
export type ReceiptReader = (stageKeys: readonly string[]) => Promise<OrdinaryPublicationState>;

type StageState = OrdinaryPublicationState["stages"][number];
type Coordinate = Extract<StageState, { state: "present" }>["coordinates"][number];
type PublicationStorage = Pick<SyncRelayStorage, "fetchAccountOperationLogRow" | "advanceAccountOperation">;
/** What publication needs of an open copy. */
export type PublicationCopy = Pick<AutomationReplica, "workspaceId" | "incarnation" | "client" | "workspace" | "signal" | "nextRequestId" | "step">;

const ROLES: ReadonlySet<string> = new Set(["post", "reply", "decision", "reaction"]);
const isRole = (role: string): role is PublicationStage["role"] => ROLES.has(role);

/** The stages a stored command requires, or null when it names none a write can be checked by. */
export function commandStages(command: JsonValue): PublicationStage[] | null {
  const stages = asRecord(command)?.stages;
  if (!Array.isArray(stages) || stages.length === 0) return null;
  const decoded: PublicationStage[] = [];
  for (const value of stages as unknown[]) {
    const stage = asRecord(value);
    const key = stage?.key, role = stage?.role, records = stage?.records, engineThread = stage?.engineThread;
    if (typeof key !== "string" || !key || typeof role !== "string" || !isRole(role) || !Array.isArray(records)) return null;
    if (engineThread !== undefined && (typeof engineThread !== "string" || !engineThread)) return null;
    const expected: ExpectedRecord[] = [];
    for (const item of records as unknown[]) {
      const record = asRecord(item);
      const kind = record?.kind, fields = asRecord(record?.fields), optional = record?.optional;
      if (typeof kind !== "string" || fields === null || (optional !== undefined && typeof optional !== "boolean")) return null;
      // Parsed from the stored JSON, so every field is JSON.
      expected.push({ kind, fields: fields as { [field: string]: JsonValue }, ...(optional === true ? { optional } : {}) });
    }
    decoded.push({ key, role, records: expected, ...(engineThread === undefined ? {} : { engineThread }) });
  }
  return decoded;
}

/**
 * Judges a write by its receipts and the relay's rows at the coordinates
 * they list. The required stages come from the stored command, never from
 * the receipts found. A stage with no receipt, or a coordinate not yet
 * accepted, leaves the write pending; when `settling` names a reason, its
 * folder is closed and going, and nothing can publish from it again, so the
 * write is refused for that reason instead. Settling looks at the relay's
 * row for a coordinate the copy never saw pushed too, since a push whose
 * answer was lost may still have reached the relay. A lost decision answers
 * "already answered", and a message whose own records were accepted is
 * published whatever the rest does.
 */
export function judgeOperation(
  storage: Pick<SyncRelayStorage, "fetchAccountOperationLogRow">,
  record: OperationRecord,
  receipts: ReadonlyMap<string, StageState>,
  settling: RefusalReason | null,
): Verdict {
  const stages = commandStages(record.command);
  let threadId: string | null = null, unresolved = stages === null, refused = false, messagePublished = false;
  let lost: { winnerMessageId?: string } | null = null;
  for (const stage of stages ?? []) {
    const receipt = receipts.get(stage.key);
    if (receipt === undefined || receipt.state === "absent") {
      unresolved = true;
      continue;
    }
    threadId ??= receipt.threadId;
    if (receipt.outcome === "lost") {
      lost = receipt.winnerMessageId === undefined ? {} : { winnerMessageId: receipt.winnerMessageId };
      continue;
    }
    // A stage that wrote nothing has nothing to publish.
    if (receipt.outcome === "no-op") continue;
    const accepted = accepts(storage, record, receipt.coordinates, expectedRecords(stage, receipt.threadId), settling !== null);
    if (accepted === "refused") refused = true;
    else if (accepted === "unresolved") unresolved = true;
    else if (stage.role === "post" || stage.role === "reply") messagePublished = true;
  }
  if (unresolved && settling === null) return { stage: "pending", messagePublished };
  const refuse = (reason: RefusalReason, extra: { winnerMessageId?: string } = {}): Verdict =>
    ({ stage: "refused", messagePublished, result: { threadId, reason, ...extra } });
  if (lost !== null) return refuse(ALREADY_ANSWERED, lost);
  if (unresolved) return refuse(settling ?? COULD_NOT_SEND);
  if (refused) return refuse(COULD_NOT_SEND);
  return { stage: "saved", messagePublished, result: { threadId } };
}

// The records a stage must have made, with the thread its receipt names
// wherever the stage proposed one the engine could replace.
function expectedRecords(stage: PublicationStage, threadId: string): readonly ExpectedRecord[] {
  const proposed = stage.engineThread;
  if (proposed === undefined || proposed === threadId) return stage.records;
  return stage.records.map((record) => ({
    ...record,
    fields: Object.fromEntries(Object.entries(record.fields)
      .map(([field, value]): [string, JsonValue] => [field, value === proposed ? threadId : value])),
  }));
}

// Whether the relay accepted every record a stage's coordinates name, each
// as the command expects it. A refusal at any coordinate is final. A row not
// there yet, one outside the log rows the write's own epoch and stream could
// make, or one that isn't what the write made, stays unresolved.
function accepts(
  storage: Pick<SyncRelayStorage, "fetchAccountOperationLogRow">,
  record: OperationRecord,
  coordinates: readonly Coordinate[],
  records: readonly ExpectedRecord[],
  settling: boolean,
): "accepted" | "refused" | "unresolved" {
  const matched = new Set<ExpectedRecord>();
  let unresolved = false;
  for (const coordinate of coordinates) {
    if (coordinate.state === "refused") return "refused";
    if (coordinate.state === "pending" && !settling) {
      unresolved = true;
      continue;
    }
    // The stored epoch and stream, never the copy's current ones.
    const row = storage.fetchAccountOperationLogRow({
      accountId: record.accountId, operationId: record.operationId, workspaceId: record.workspaceId,
      replicationEpoch: record.replicationEpoch, streamIdentity: record.streamIdentity,
      originId: coordinate.originId, originSeq: coordinate.originSeq,
    });
    if (row === null) {
      unresolved = true;
      continue;
    }
    if (row.relayAdmission === "refused" || row.opKind === REFUSED_OP_KIND) return "refused";
    const expected = row.relayAdmission === undefined
      ? records.find((record) => record.kind === row.opKind && holds(row.payloadJson, record.fields))
      : undefined;
    if (expected === undefined) unresolved = true;
    else matched.add(expected);
  }
  return unresolved || !records.every((record) => record.optional === true || matched.has(record)) ? "unresolved" : "accepted";
}

function parseObject(json: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(json));
  } catch {
    return null;
  }
}

function holds(payloadJson: string, fields: { readonly [field: string]: JsonValue }): boolean {
  const payload = parseObject(payloadJson);
  return payload !== null && Object.entries(fields).every(([field, value]) =>
    Object.hasOwn(payload, field) && stableJsonStringify(payload[field]) === stableJsonStringify(value));
}

/**
 * Records what a verdict settled, and a message published on its own. A
 * pending write past its active time is stalled. Answers the row as it is
 * now, or null once nothing but a tombstone is left.
 */
export function recordVerdict(
  storage: Pick<SyncRelayStorage, "advanceAccountOperation">,
  record: OperationRecord,
  verdict: Verdict,
  nowMs: number,
): OperationRecord | null {
  const stage = verdict.stage !== "pending" ? verdict.stage : nowMs >= record.activeUntilMs ? "stalled" : undefined;
  return storage.advanceAccountOperation({
    accountId: record.accountId, operationId: record.operationId, nowMs,
    ...(stage === undefined ? {} : { stage }),
    ...(verdict.messagePublished && record.messageState !== null ? { message: "published" as const } : {}),
    ...(verdict.stage === "pending" ? {} : { result: verdict.result }),
  })?.record ?? null;
}

/** Writes whose outcome stays unknown stall. They keep their reason, at a slower rate, and can still be saved. */
export function stallOperations(
  storage: Pick<SyncRelayStorage, "advanceAccountOperation">,
  records: readonly OperationRecord[],
  nowMs: number,
): void {
  for (const record of records) {
    storage.advanceAccountOperation({ accountId: record.accountId, operationId: record.operationId, stage: "stalled", nowMs });
  }
}

/** Writes past their active time stall. */
export function stallExpired(
  storage: Pick<SyncRelayStorage, "advanceAccountOperation">,
  records: readonly OperationRecord[],
  nowMs: number,
): void {
  stallOperations(storage, records.filter((record) => nowMs >= record.activeUntilMs), nowMs);
}

/**
 * Reads receipts from a workspace open in a copy's engine, with the copy's
 * own request IDs. `signal` ends a read still waiting for its answer.
 */
export function receiptReader(engine: Pick<AutomationReplica, "client" | "nextRequestId">, workspace: string, signal?: AbortSignal): ReceiptReader {
  const requester: Pick<WorkspaceDaemonRequester, "request"> = {
    request: async (method, params, options) => (await engine.client.sendRequest({
      id: engine.nextRequestId(), method, params,
      ...(options?.workspace === undefined ? {} : { workspace: options.workspace }),
      ...(options?.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    }, signal)).result,
  };
  return (stageKeys) => readOrdinaryPublicationState(requester, workspace, stageKeys, { deadlineMs: RECEIPT_DEADLINE_MS });
}

// Every stage the records name, at most MAX_PUBLICATION_STAGE_KEYS a request.
async function readStages(read: ReceiptReader, records: readonly OperationRecord[]): Promise<Map<string, StageState>> {
  const keys = [...new Set(records.flatMap((record) => commandStages(record.command)?.map((stage) => stage.key) ?? []))];
  const stages = new Map<string, StageState>();
  for (let start = 0; start < keys.length; start += MAX_PUBLICATION_STAGE_KEYS) {
    for (const stage of (await read(keys.slice(start, start + MAX_PUBLICATION_STAGE_KEYS))).stages) stages.set(stage.stageKey, stage);
  }
  return stages;
}

function wholePushRejection(error: unknown): string | null {
  const code = error instanceof EngineRequestError ? error.wireError?.code : undefined;
  return code !== undefined && WHOLE_PUSH_REJECTIONS.has(code) ? code : null;
}

/**
 * Judges unfinished writes by their receipts and the relay's rows, whatever
 * the sync before it did: a push can reach the relay in a step whose pull
 * then fails. `syncError` is the sync's failure, if any: a whole-push relay
 * rejection stalls the writes, and the operator hears of it. Answers each
 * write's row afterwards, or null when the receipts couldn't be read, which
 * stalls only the writes past their active time.
 */
export async function inspectOperations(
  storage: PublicationStorage,
  workspaceId: string,
  read: ReceiptReader,
  records: readonly OperationRecord[],
  nowMs: () => number,
  syncError?: unknown,
): Promise<Array<OperationRecord | null> | null> {
  const code = wholePushRejection(syncError);
  if (code !== null) {
    console.error(`[sync-relay] The relay refused a whole push from this server's copy of workspace "${workspaceId}" (${code}). Its phone writes are stalled.`);
    stallOperations(storage, records, nowMs());
  }
  const receipts = await readStages(read, records).catch(() => null);
  if (receipts === null) {
    stallExpired(storage, records, nowMs());
    return null;
  }
  return records.map((record) => recordVerdict(storage, record, judgeOperation(storage, record, receipts, null), nowMs()));
}

/**
 * One bounded attempt for unfinished writes on an open copy: one sync step,
 * queued behind any sync already running, then their receipts and the
 * relay's rows, read whether or not the step succeeded. `signal` ends the
 * attempt wherever it waits; the copy's own passes carry the sync on.
 */
export async function publishOnce(
  storage: PublicationStorage,
  copy: PublicationCopy,
  records: readonly OperationRecord[],
  nowMs: () => number,
  signal?: AbortSignal,
): Promise<Array<OperationRecord | null> | null> {
  let syncError: unknown;
  try {
    await copy.step(signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (copy.signal.aborted) return null;
    syncError = error;
  }
  const inspected = await inspectOperations(storage, copy.workspaceId, receiptReader(copy, copy.workspace, signal), records, nowMs, syncError);
  signal?.throwIfAborted();
  return inspected;
}

const answerOf = (record: OperationRecord | null): PublicationAnswer => ({
  state: record === null || record.stage === "refused" ? "refused" : record.stage === "saved" ? "saved" : "pending",
  record,
});

/**
 * Drives one write's publication once its engine stages are written, from
 * outside the copy's sync lane: bounded sync steps, each queued on its own,
 * so the lane is free between them, until the relay accepted or refused
 * every record the receipts list, or `deadlineMs` passes. The deadline ends
 * this request's attempt wherever it waits, in the lane, in an engine
 * request, or in a receipt read. Then `authorize` checks the caller again,
 * and the answer comes from the record: saved, refused, or pending, which
 * the copy's passes carry on. `signal` is the caller's: its abort rejects
 * instead. A sync that succeeds, or has more to do, is never taken as
 * acceptance. Never call it from a sync callback: it waits for the lane.
 */
export async function publishOperation(input: {
  storage: PublicationStorage;
  copy: PublicationCopy;
  record: OperationRecord;
  signal?: AbortSignal;
  /** Checks the caller's credential, ownership, and "Show on phone" again, right before the answer. */
  authorize?(): Promise<void>;
  deadlineMs?: number;
  nowMs?(): number;
  /** The wait between attempts. */
  pause?(ms: number, signal?: AbortSignal): Promise<void>;
}): Promise<PublicationAnswer> {
  const { storage, copy, signal } = input;
  const nowMs = input.nowMs ?? Date.now;
  const pause = input.pause ?? ((ms: number, abort?: AbortSignal) => sleep(ms, undefined, abort === undefined ? {} : { signal: abort }));
  // A write made on an earlier incarnation settles when that incarnation's folder goes.
  if (input.record.workspaceId !== copy.workspaceId || input.record.incarnation !== copy.incarnation) return answerOf(input.record);
  const { accountId, operationId } = input.record;
  let record = storage.advanceAccountOperation({ accountId, operationId, stage: "publishing", nowMs: nowMs() })?.record ?? null;
  const budgetMs = input.deadlineMs ?? PUBLICATION_DEADLINE_MS;
  const deadline = nowMs() + budgetMs;
  const expired = new AbortController();
  const timer = setTimeout(() => expired.abort(new Error("The write's publication deadline passed.")), budgetMs);
  timer.unref?.();
  const attempt = signal === undefined ? expired.signal : AbortSignal.any([expired.signal, signal]);
  try {
    for (let wait = FIRST_POLL_MS; record !== null && record.stage !== "saved" && record.stage !== "refused"; wait = Math.min(wait * 2, MAX_POLL_MS)) {
      const after = await publishOnce(storage, copy, [record], nowMs, attempt);
      if (after !== null) record = after[0] ?? null;
      if (record === null || record.stage === "saved" || record.stage === "refused" || nowMs() + wait >= deadline) break;
      await pause(wait, attempt);
    }
  } catch (error) {
    // Only the deadline ends the attempt with an answer; the caller's abort, or a failure, rejects.
    if (signal?.aborted || !expired.signal.aborted) throw error;
    record = storage.advanceAccountOperation({ accountId, operationId, nowMs: nowMs() })?.record ?? null;
  } finally {
    clearTimeout(timer);
  }
  await input.authorize?.();
  return answerOf(record);
}

/**
 * Settles writes whose folder is closed and about to go: nothing can
 * publish from it again, so each ends saved or refused. Every receipt is
 * read first. A read that fails throws: retirement and the orphan sweep keep
 * the folder and try again, and account deletion reports it and removes the
 * folder anyway. `read` is null when the folder is already gone, which
 * leaves no receipt.
 */
export async function settleOperations(
  storage: PublicationStorage,
  records: readonly OperationRecord[],
  read: ReceiptReader | null,
  reason: RefusalReason,
  nowMs: number,
  /** Runs once every receipt is read and before any verdict is recorded, whether or not a record needed a read. */
  beforeRecording?: () => Promise<void>,
): Promise<void> {
  if (records.length === 0) return;
  const receipts = read === null ? new Map<string, StageState>() : await readStages(read, records);
  await beforeRecording?.();
  for (const record of records) recordVerdict(storage, record, judgeOperation(storage, record, receipts, reason), nowMs);
}

/** Turns every write settled long enough ago into a tombstone, a batch at a time, yielding between batches. Answers how many. */
export async function tombstoneSettledOperations(
  storage: Pick<SyncRelayStorage, "tombstoneSettledAccountOperations">,
  nowMs: number,
  pause: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): Promise<number> {
  let tombstoned = 0;
  for (;;) {
    const batch = storage.tombstoneSettledAccountOperations(nowMs);
    tombstoned += batch;
    if (batch < OPERATION_TOMBSTONE_BATCH) return tombstoned;
    await pause();
  }
}
