import { isDeepStrictEqual } from "node:util";
import type { JsonObject, JsonValue } from "@dohc/app-backend-runtime/automation";
import type { Automation } from "@dohc/workspace-contracts/automations";
import type {
  CollectionGetRecordParams,
  CollectionGetRecordResult,
  CollectionQueryParams,
  CollectionQueryResult,
} from "@dohc/workspace-contracts/collection";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import type { AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import {
  definitionHash,
  evaluationRequest,
  filterValue,
  FIND_OVERFLOW_ERROR,
  findsOf,
  findValueKey,
  findValuesRequest,
  formulaPeople,
  MAX_FOUND_RECORDS,
  planRun,
  reachStepsOf,
  runRecordOf,
  scheduleDueAt,
  stepKey,
  triggerMatches,
  type PlannedEffect,
  type PlannedField,
  type PlannedStep,
  type FindValue,
  type FindValueInputs,
  type RunInputs,
  type RunRecord,
} from "./automationPlan";
import { checkAutomationReach, type ReachCollection, type ReachRoster, type ReachStep, type StepReach } from "./automationReach";
import {
  AutomationChatSessionWait,
  chatNeedsOf,
  NoticeNotSentError,
  type AutomationChatMessage,
  type AutomationNotice,
  type ChatDirectory,
  type ChatNeeds,
} from "./automationChat";
import { RUN_PLAN_BUDGET_BYTES, type AutomationRunStore, type RunWrite, type StoredRun, type StoredStep } from "./automationRunStore";

// One run of one claim: check reach, read, evaluate, save the plan, then
// apply the plan's effects in order, saving each one as it lands. The
// executor settles the claim with the outcome.

export const RECORD_NOT_FOUND = "collection-record-not-found";

export const DEADLINE_ERROR = "The automation did not finish within 5 minutes.";
export const GROUP_CHANGED_ERROR =
  "The Group this automation watches changed after this message arrived, so the run stopped before sending anything more.";

/**
 * How a Group message's run ends before it reads anything, or null when the
 * automation still watches the Group the message came from, on every
 * attempt: reach reads the Group the file names now, and a saved plan
 * carries the message it was made from. A run with no plan yet skips; one
 * with a plan fails, since it may have sent part of it.
 */
export function groupChangedOutcome(
  automation: Automation,
  claim: AutomationClaim,
  chat: ChatDirectory | null,
  planned: boolean,
): CollectionAutomationRunOutcome | null {
  if (claim.change.kind !== "message") return null;
  const trigger = automation.when;
  const group = trigger.kind === "group-message" ? chat?.group(trigger.group) : undefined;
  if (group && !("problem" in group) && group.channelId === claim.change.message.groupId) return null;
  return planned ? failed(GROUP_CHANGED_ERROR) : { kind: "skipped" };
}

/** Whether a run loads the chat directory: it sends something, or a Group message starts it. */
export function readsChats(automation: Automation): boolean {
  return sendsMessages(automation) || automation.when.kind === "group-message";
}
// How run history and holds name a wake's destination.
const WAKE_TARGET_NAME = "your agent";
export const DEFINITION_CHANGED_ERROR =
  "This automation changed after this run began. Try again to run the new version from the start. It may repeat changes, posts, direct messages, and notices the earlier run already made.";
export const UNREADABLE_RUN_ERROR =
  "dohc could not read this run's saved progress in .dohc/automations, so it did not run again. Move that folder aside, then try again.";
export const UNDONE_RUN_ERROR = "You undid this run, so dohc does not run it again.";
export const COMPACTED_RUN_ERROR =
  "This run failed too long ago for dohc to finish it. Change the records by hand, or wait for the automation's next run.";

/** The engine reads a run makes. VersionedLiveAdapter satisfies it. */
export interface CollectionAutomationReads {
  getCollectionRecord(input: CollectionGetRecordParams): Promise<CollectionGetRecordResult>;
  queryCollectionRecords(input: CollectionQueryParams): Promise<CollectionQueryResult>;
}

/** What a field write did. */
interface RecordFieldsWritten {
  /**
   * The value each written field held before this write, keyed by field.
   * A field the record did not have reads as null. Fields that already held
   * the requested value are absent.
   */
  replaced: Record<string, unknown>;
  /** The current value of each field `expectedBefore` left as it is. */
  kept: Record<string, unknown>;
}

/**
 * Record writes with the workspace's write authority. The desktop binds
 * them to its live record documents (collectionRecordEdits.ts).
 */
export interface CollectionRecordWrites {
  setFields(input: {
    recordPath: string;
    fields: Record<string, unknown>;
    author: ChangeAuthor;
    /** Names the write for the engine's idempotency check, one key per field under this prefix. */
    idempotencyKeyPrefix?: string;
    /**
     * The value each field should hold before the write. A field holding
     * something else changed since the plan: the write keeps it and reports
     * it in `kept`.
     */
    expectedBefore?: Record<string, unknown>;
  }): Promise<RecordFieldsWritten>;
  /**
   * Adds the record `name` with this id, or answers the record the
   * Collection already has with it. The answer names the id the engine gave
   * the file.
   */
  create(input: { collectionPath: string; name: string; author: ChangeAuthor; recordId: string }): Promise<{ path: string; recordId: string }>;
}

export interface CollectionAutomationRunDependencies {
  /** Engine reads; resolves null when the engine is unavailable. */
  withReads<T>(work: (reads: CollectionAutomationReads) => Promise<T>): Promise<T | null>;
  /** Record writes with the workspace's write authority, ending at `signal`. */
  withRecordWrites<T>(signal: AbortSignal, work: (writes: CollectionRecordWrites) => Promise<T>): Promise<T>;
  /** Whether a folder is a Collection the engine lists. */
  isCollection(path: string): boolean;
  /** Whether a folder keeps its records in a dataset (it holds dataset.json). */
  isDatasetCollection(path: string): Promise<boolean>;
  /** The name a formula's `person` shows for the person who pressed a button. */
  personName(userId: string): string;
  evaluator: AutomationFormulaEvaluator;
  store: AutomationRunStore;
  nowMs(): number;
  chat: AutomationChatDependencies;
  /**
   * Sends one notice from this workspace, ending at `signal` before it
   * sends; throws NoticeNotSentError when it did not reach its person.
   */
  postNotice(notice: AutomationNotice, signal: AbortSignal): Promise<void>;
  /** A message's whole body, for one whose claim carried it truncated; null when the engine is unavailable. */
  readMessageBody(messageId: string): Promise<string | null>;
  /**
   * Keeps a verdict for each person a formula named, as for any step, and
   * says which of them wait for a current editor to allow them.
   */
  recipientVerdicts(input: {
    automationId: string;
    definitionHash: string;
    recipients: readonly RecipientReach[];
  }): Promise<Array<"allowed" | "held" | "stopped">>;
}

/** A person a formula named, with what the roster says about reaching them. */
interface RecipientReach {
  /** The step's place in the automation. */
  step: number;
  userId: string;
  name: string;
  action: "post" | "notify";
  reach: StepReach;
}

/** Where an automation's posts and direct messages go, and how they are written. */
export interface AutomationChatDependencies {
  /** What `needs` names under this roster; null when the engine is unavailable. */
  directory(roster: Exclude<ReachRoster, { kind: "unknown" }>, needs: ChatNeeds): Promise<ChatDirectory | null>;
  /**
   * Writes one message as the automation, ending at `signal`. Throws
   * AutomationChatSessionWait when a synced workspace has no session.
   */
  write(signal: AbortSignal, message: AutomationChatMessage): Promise<unknown>;
}

/** Whether any step posts, sends a direct message, or notifies someone. */
export function sendsMessages(automation: Automation): boolean {
  const walk = (steps: Automation["do"]): boolean => steps.some((step) =>
    step.kind === "post" || step.kind === "direct-message" || step.kind === "notify" || step.kind === "wake-agent" ||
    (step.kind === "if" && (walk(step.do) || walk(step.otherwise))));
  return walk(automation.do);
}

export type CollectionAutomationRunOutcome =
  | { kind: "done" }
  // The trigger or a condition did not hold, or the record is gone.
  | { kind: "skipped" }
  | { kind: "failed"; error: string; timedOut: boolean }
  // The claim's run already failed here; the engine handed it out again
  // without a Try again, so only its settle is left.
  | { kind: "failed-before"; error: string }
  // Leave the claim for a later drain: the evaluator is busy, the engine is
  // not answering, a pause or close stopped the run, or a synced workspace
  // has no session to post under. A stopped run's progress is saved, so the
  // next drain resumes it.
  // Or who can edit the Collection could not be read just before a record effect.
  | { kind: "wait"; reason: "busy" | "engine" | "stopped" | "session" | "held" | "roster" };

export interface CollectionAutomationRunInput {
  claim: AutomationClaim;
  automation: Automation;
  collection: ReachCollection;
  /** Who can edit what now; the executor waits while it is unknown. */
  roster: Exclude<ReachRoster, { kind: "unknown" }>;
  /** Aborts at the run's deadline, or when the executor stops. Every write receives it. */
  signal: AbortSignal;
  /** Aborts when the executor stops for an engine restart or a close: the run waits instead of failing. */
  stopped: AbortSignal;
}

const failed = (error: string, timedOut = false): CollectionAutomationRunOutcome => ({ kind: "failed", error, timedOut });
const stopped: CollectionAutomationRunOutcome = { kind: "wait", reason: "stopped" };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ClaimRuns =
  | { unreadable: true }
  | {
      unreadable: false;
      /**
       * A person started to undo a run of the claim, under any definition. Its
       * keys and record ids are spent, so the claim never runs again.
       */
      undo: boolean;
      /** A run that finished, under any definition. The claim needs only its settle. */
      done: StoredRun | null;
      /** The run this definition continues. */
      current: StoredRun | null;
      /**
       * A run of another definition that reached its writes. Running this
       * one from the start could repeat what that one did.
       */
      changedSince: StoredRun | null;
    };

export async function runsForClaim(
  store: AutomationRunStore,
  claim: Pick<AutomationClaim, "automationId" | "claimId">,
  automation: Automation,
): Promise<ClaimRuns> {
  const hash = definitionHash(automation);
  const { runs, unreadable } = await store.runsOf(claim.automationId, claim.claimId);
  if (unreadable) return { unreadable: true };
  const live = runs.filter((run) => !run.superseded);
  return {
    unreadable: false,
    undo: runs.some((run) => run.undo !== null),
    done: live.find((run) => run.outcome?.state === "done") ?? null,
    current: live.find((run) => run.definitionHash === hash) ?? null,
    // A run is saved only once its plan is ready to write, so any saved run
    // of another definition may have written.
    changedSince: live.find((run) => run.definitionHash !== hash) ?? null,
  };
}

/**
 * What this claim's saved runs leave to do: an outcome that needs no run, or
 * the run this definition continues, if any.
 */
export async function savedRunOf(
  store: AutomationRunStore,
  claim: Pick<AutomationClaim, "automationId" | "claimId" | "run">,
  automation: Automation,
): Promise<{ outcome: CollectionAutomationRunOutcome } | { current: StoredRun | null }> {
  const runs = await runsForClaim(store, claim, automation);
  // Never start over as if nothing had run.
  if (runs.unreadable) return { outcome: failed(UNREADABLE_RUN_ERROR) };
  const { done, current, changedSince } = runs;
  // It finished before this computer could settle the claim, whatever the
  // automation says now.
  if (done !== null) return { outcome: { kind: "done" } };
  if (runs.undo) return { outcome: failed(UNDONE_RUN_ERROR) };
  // Running another definition from the start could repeat the changes the
  // earlier one made. A person has to choose that with Try again.
  if (current === null && changedSince !== null) return { outcome: failed(DEFINITION_CHANGED_ERROR) };
  if (current?.compacted) return { outcome: failed(COMPACTED_RUN_ERROR) };
  // The ledger handed the claim out again without a Try again, as after a
  // crash before the failure reached it: the run stays failed.
  if (current?.outcome?.state === "failed" && current.outcome.run === claim.run) {
    return { outcome: { kind: "failed-before", error: current.outcome.error } };
  }
  return { current };
}

/** A new run's record, before its plan is saved. */
export function newRun(claim: Pick<AutomationClaim, "automationId" | "claimId">, automation: Automation, keySeed: string, plan: StoredStep[], nowMs: number): StoredRun {
  return {
    version: 2,
    claimId: claim.claimId,
    automationId: claim.automationId,
    definitionHash: definitionHash(automation),
    keySeed,
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
    plan,
    applied: [],
    created: [],
    replans: [],
    undoRequests: [],
    readableFields: null,
    datasetId: null,
    superseded: false,
    undo: null,
    settled: false,
    compacted: false,
    outcome: null,
  };
}

export async function runCollectionAutomation(
  dependencies: CollectionAutomationRunDependencies,
  input: CollectionAutomationRunInput,
): Promise<CollectionAutomationRunOutcome> {
  const { claim, automation, collection, roster } = input;
  const { store } = dependencies;
  const saved = await savedRunOf(store, claim, automation);
  if ("outcome" in saved) return saved.outcome;
  const { current } = saved;

  // Where the automation's messages go, found once for the reach check and
  // the plan.
  let chat: ChatDirectory | null = null;
  if (readsChats(automation)) {
    chat = await dependencies.chat.directory(roster, chatNeedsOf([automation]));
    if (chat === null) return { kind: "wait", reason: "engine" };
  }
  const groupChanged = groupChangedOutcome(automation, claim, chat, Boolean(current?.plan));
  if (groupChanged !== null) return groupChanged;
  // Reach (ADR 0012), before anything is read. The targets are in the file,
  // so the check needs only the roster.
  const steps = reachStepsOf(automation, collection, (path) => ({ path, name: path.split("/").at(-1) ?? path }), chat);
  for (const verdict of checkAutomationReach(roster, { id: automation.id, collection, codeFiles: [], steps })) {
    if (!verdict.allowed) return failed(verdict.reason);
  }
  const targets = new Map<string, ReachCollection>();
  for (const step of steps) {
    if (step.kind === "change-records" || step.kind === "find-records") targets.set(step.collection.path, step.collection);
  }
  for (const target of targets.values()) {
    // A dataset's records change only through its approved operations.
    if (await dependencies.isDatasetCollection(target.path)) {
      return failed(`Automations cannot use ${target.name} yet, because its records change only through its Collection actions.`);
    }
    if (!dependencies.isCollection(target.path)) return failed(`dohc cannot find the Collection ${target.path}.`);
  }

  let run = current?.plan ? current : null;
  const resumed = run !== null;
  // A new plan's keys and added record ids come from the definition and the
  // claim's run, never from what history kept: a start-over is a new run, so
  // the engine takes its writes as new, and a crash requeue keeps the run,
  // so it replays the same keys. A resumed plan keeps its own seed.
  const keySeed = `${definitionHash(automation)}-${claim.run}`;
  if (run === null) {
    let planned: Awaited<ReturnType<typeof plan>>;
    try {
      planned = await plan(dependencies, input, keySeed, chat);
    } catch (error) {
      return input.stopped.aborted ? stopped : failed(errorText(error));
    }
    if (input.stopped.aborted) return stopped;
    if (planned.kind === "stop") return planned.outcome;
    run = newRun(claim, automation, keySeed, planned.steps, dependencies.nowMs());
    // The plan with every effect recorded must fit what the store reads
    // back, and one that does not is refused before anything is written.
    if (Buffer.byteLength(JSON.stringify({ ...run, applied: projectedProgress(planned.steps) })) > RUN_PLAN_BUDGET_BYTES) {
      return failed("This run would change more data than dohc can save for it. Narrow its Find steps, or split it into smaller automations.");
    }
    // The plan is on disk before the first write, so a run that stops part
    // way continues with these values instead of evaluating again.
    await store.save(run);
  }
  const messages = await checkPlannedMessages(dependencies, { automationId: claim.automationId, automation, collection, roster }, run, chat);
  if ("outcome" in messages) return messages.outcome;
  const outcome = await applyPlan(dependencies, input, run, resumed, messages.chat);
  // A stopped run keeps its progress and no outcome; the next drain resumes it.
  if (outcome.kind === "wait") return outcome;
  if (outcome.kind === "failed") {
    run.outcome = { state: "failed", error: outcome.error, run: claim.run };
  } else {
    run.outcome = { state: "done" };
    run.plan = null;
  }
  run.updatedAtMs = dependencies.nowMs();
  await store.save(run);
  return outcome;
}

/**
 * Checks every message and notice in a run's plan again under this roster,
 * before anything is sent, and answers the directory the run sends with. A
 * person only a formula named has no verdict from the file, so they keep one
 * here: one an editor's leaving allowed waits for Allow. A saved direct
 * message is checked against its conversation as it is now, read for the
 * plan's own people, resumed or not.
 */
export async function checkPlannedMessages(
  dependencies: Pick<CollectionAutomationRunDependencies, "chat" | "recipientVerdicts">,
  input: { automationId: string; automation: Automation; collection: ReachCollection; roster: Exclude<ReachRoster, { kind: "unknown" }> },
  run: StoredRun,
  chat: ChatDirectory | null,
): Promise<{ chat: ChatDirectory | null } | { outcome: CollectionAutomationRunOutcome }> {
  const { automation, collection, roster } = input;
  const planned = (run.plan ?? []).flatMap((step) => step.effects.map((effect) => ({ ordinal: step.ordinal, effect })));
  const messages = planned.flatMap(({ ordinal, effect }): Array<{ ordinal: number; effect: PlannedEffect; step: ReachStep }> => {
    if (effect.kind === "message") {
      return [{ ordinal, effect, step: { kind: "post", group: { channelWireId: effect.channelWireId, name: effect.name } } }];
    }
    if (effect.kind === "notice") {
      return [{ ordinal, effect, step: { kind: "notify", person: { userId: effect.notice.recipientUserId, name: effect.name } } }];
    }
    return [];
  });
  const verdicts = checkAutomationReach(roster, { id: automation.id, collection, codeFiles: [], steps: messages.map(({ step }) => step) });
  const recipients: RecipientReach[] = [];
  for (const [index, { ordinal, effect }] of messages.entries()) {
    if (effect.kind === "message" && effect.byFormula && effect.to.kind === "direct-message") {
      recipients.push({ step: ordinal, userId: effect.to.userId, name: effect.name, action: "post", reach: verdicts[index]! });
    } else if (effect.kind === "notice" && effect.byFormula) {
      recipients.push({ step: ordinal, userId: effect.notice.recipientUserId, name: effect.name, action: "notify", reach: verdicts[index]! });
    }
  }
  // Kept before anything fails, so a stop is remembered for the next run.
  const kept = recipients.length === 0 ? [] : await dependencies.recipientVerdicts({
    automationId: input.automationId, definitionHash: definitionHash(automation), recipients,
  });
  const stoppedReach = verdicts.find((reach) => !reach.allowed);
  if (stoppedReach && !stoppedReach.allowed) return { outcome: failed(stoppedReach.reason) };
  if (kept.includes("held")) return { outcome: { kind: "wait", reason: "held" } };
  const planPeople = new Set(planned.flatMap(({ effect }) =>
    effect.kind === "message" && effect.to.kind === "direct-message" ? [effect.to.userId] : []));
  if (planPeople.size === 0) return { chat };
  const sendChat = await dependencies.chat.directory(roster, { groups: new Set(), people: planPeople });
  return sendChat === null ? { outcome: { kind: "wait", reason: "engine" } } : { chat: sendChat };
}

/**
 * The values Finds compare with that formulas give, by findValueKey, and
 * the Finds whose formula failed, which read nothing: the run fails only if
 * one of their branches runs. Waits while the evaluator is busy. Only a run
 * whose Finds use formulas asks the evaluator.
 */
export async function evaluateFindValues(
  evaluator: AutomationFormulaEvaluator,
  inputs: FindValueInputs,
  finds: ReadonlyArray<{ ordinal: number; values: readonly FindValue[] }>,
  nowMs: number,
): Promise<{ values: Map<string, JsonValue>; failed: Map<number, { error: string; timedOut: boolean }> } | { outcome: CollectionAutomationRunOutcome }> {
  const request = findValuesRequest(inputs, finds, nowMs);
  const values = new Map<string, JsonValue>();
  const failedFinds = new Map<number, { error: string; timedOut: boolean }>();
  if (request.formulas.length === 0) return { values, failed: failedFinds };
  const results = await evaluator.evaluate(inputs.claim.automationId, request.scope, request.formulas);
  if (results === "busy") return { outcome: { kind: "wait", reason: "busy" } };
  for (const [position, { ordinal, index }] of request.slots.entries()) {
    const result = results[position];
    if (!result) return { outcome: failed("The evaluator did not answer every formula.") };
    if (result.ok) {
      values.set(findValueKey(ordinal, index), result.value);
      continue;
    }
    // A timeout counts toward switching the automation off, so another
    // formula's failure in the same Find never hides one.
    const timedOut = result.error.code === "timeout";
    if (failedFinds.get(ordinal)?.timedOut !== true && (timedOut || !failedFinds.has(ordinal))) {
      failedFinds.set(ordinal, { error: `The Find in step ${ordinal + 1} failed. ${result.error.message}`, timedOut });
    }
  }
  return { values, failed: failedFinds };
}

async function plan(
  dependencies: CollectionAutomationRunDependencies,
  input: CollectionAutomationRunInput,
  keySeed: string,
  chat: ChatDirectory | null,
): Promise<{ kind: "plan"; steps: PlannedStep[] } | { kind: "stop"; outcome: CollectionAutomationRunOutcome }> {
  const { claim, automation } = input;
  const stop = (outcome: CollectionAutomationRunOutcome) => ({ kind: "stop" as const, outcome });
  let message: RunInputs["message"] = null;
  if (claim.change.kind === "message") {
    const got = await groupMessage(dependencies, claim, automation, chat);
    if ("outcome" in got) return stop(got.outcome);
    message = got.message;
  }
  const pressedBy = claim.change.kind === "button" ? claim.change.onBehalfOf : null;
  const person = pressedBy === null ? null : { id: pressedBy, name: dependencies.personName(pressedBy) };
  // Formulas read `now` as the time of the change, or a schedule's due
  // time, so every attempt plans the same values.
  const nowMs = scheduleDueAt(claim) ?? claim.createdAtMs;
  const read = await dependencies.withReads(async (reads) => {
    let record: RunRecord | null = null;
    // A claim with no record (a message or a schedule) reads none.
    const recordId = claim.recordId;
    if (claim.change.kind !== "removed" && recordId !== null) {
      try {
        const result = await reads.getCollectionRecord({
          collectionPath: claim.collectionPath,
          recordId,
          historyLimit: 1,
        });
        record = runRecordOf(result.record);
      } catch (error) {
        // The record was removed before its automation ran.
        if (error instanceof Error && error.message === RECORD_NOT_FOUND) return { removed: true } as const;
        throw error;
      }
    }
    const finds = findsOf(automation);
    const computed = await evaluateFindValues(dependencies.evaluator, { automation, claim, record, message, person },
      finds.map(({ ordinal, query }) => ({ ordinal, values: query.match === "all" ? [] : [query.value] })), nowMs);
    if ("outcome" in computed) return { removed: false, stopped: computed.outcome } as const;
    const found = new Map<number, RunRecord[]>();
    const unreadFinds = new Map(computed.failed);
    for (const find of finds) {
      if (unreadFinds.has(find.ordinal)) continue;
      const { query } = find;
      const filter = query.match === "all" ? undefined : {
        field: query.field,
        operator: query.operator,
        value: filterValue(query.value, record, computed.values, findValueKey(find.ordinal, 0)),
      };
      const result = await reads.queryCollectionRecords({
        collectionPath: find.collection ?? claim.collectionPath,
        ...(filter ? { filter } : {}),
        limit: MAX_FOUND_RECORDS,
      });
      if (result.nextCursor !== null) {
        // The planner refuses this Find only if its branch runs. Never bind a partial page.
        unreadFinds.set(find.ordinal, { error: FIND_OVERFLOW_ERROR, timedOut: false });
      } else {
        found.set(find.ordinal, result.records.map(runRecordOf));
      }
    }
    return { removed: false, stopped: null, record, found, unreadFinds } as const;
  });
  if (read === null) return stop({ kind: "wait", reason: "engine" });
  if (read.removed) return stop({ kind: "skipped" });
  if (read.stopped !== null) return stop(read.stopped);
  const inputs: RunInputs = { automation, claim, record: read.record, found: read.found, unreadFinds: read.unreadFinds, message, chat, person };
  if (!triggerMatches(inputs)) return stop({ kind: "skipped" });
  const request = evaluationRequest(inputs, nowMs);
  const results = request.formulas.length === 0
    ? []
    : await dependencies.evaluator.evaluate(claim.automationId, request.scope, request.formulas);
  if (results === "busy") return stop({ kind: "wait", reason: "busy" });
  // Only the conversations of the people the formulas named are read.
  const named = formulaPeople(request, results);
  if (named.length > 0) {
    const needs = chatNeedsOf([automation]);
    for (const userId of named) needs.people.add(userId);
    inputs.chat = await dependencies.chat.directory(input.roster, needs);
    if (inputs.chat === null) return stop({ kind: "wait", reason: "engine" });
  }
  const planned = planRun(inputs, request, results, { claimId: claim.claimId, hash: keySeed });
  if (planned.kind === "skip") return stop({ kind: "skipped" });
  if (planned.kind === "failed") return stop(failed(planned.error, planned.timedOut));
  return { kind: "plan", steps: planned.steps };
}

/**
 * The claim's Group message, with its whole body, when the automation still
 * watches that Group for such a message. The automation's file may have
 * changed since the engine claimed the message.
 */
export async function groupMessage(
  dependencies: Pick<CollectionAutomationRunDependencies, "readMessageBody">,
  claim: AutomationClaim,
  automation: Automation,
  chat: ChatDirectory | null,
): Promise<{ message: JsonObject } | { outcome: CollectionAutomationRunOutcome }> {
  const trigger = automation.when;
  const claimed = claim.change.kind === "message" ? claim.change.message : null;
  if (trigger.kind !== "group-message") return { outcome: { kind: "skipped" } };
  if (!claimed) return { outcome: failed("This run's claim did not carry its message.") };
  const group = chat?.group(trigger.group);
  if (!group) return { outcome: { kind: "wait", reason: "engine" } };
  if ("problem" in group) return { outcome: failed(group.problem) };
  if (group.channelId !== claimed.groupId) return { outcome: { kind: "skipped" } };
  let body = claimed.body;
  if (typeof body !== "string") {
    const whole = await dependencies.readMessageBody(claimed.id);
    if (whole === null) return { outcome: { kind: "wait", reason: "engine" } };
    body = whole;
  }
  const startsWith = trigger.startsWith;
  if (startsWith !== null && !body.replace(/^[\s\uFEFF]+/u, "").startsWith(startsWith)) return { outcome: { kind: "skipped" } };
  return { message: { ...claimed, body } };
}

/** Where the record with `recordId` is now, or null when it left the Collection. */
async function locate(
  dependencies: CollectionAutomationRunDependencies,
  collectionPath: string,
  recordId: string,
): Promise<string | null> {
  const found = await dependencies.withReads(async (reads) => {
    try {
      return { path: (await reads.getCollectionRecord({ collectionPath, recordId, historyLimit: 1 })).record.path };
    } catch (error) {
      if (error instanceof Error && error.message === RECORD_NOT_FOUND) return { path: null };
      throw error;
    }
  });
  if (found === null) throw new Error("The workspace engine is not running.");
  return found.path;
}

async function applyPlan(
  dependencies: CollectionAutomationRunDependencies,
  input: CollectionAutomationRunInput,
  run: StoredRun,
  resumed: boolean,
  chat: ChatDirectory | null,
): Promise<CollectionAutomationRunOutcome> {
  const { claim, signal } = input;
  const author: ChangeAuthor = {
    kind: "automation",
    automationId: claim.automationId,
    // The origin computer runs automations for its own workspace owner.
    onBehalfOf: "local",
    depth: claim.depth + 1,
  };
  const effects = (run.plan ?? []).flatMap((step) => step.effects.map((effect) => ({ ordinal: step.ordinal, effect })));
  const firstUnrecorded = run.applied.length;
  for (let index = firstUnrecorded; index < effects.length; index += 1) {
    if (input.stopped.aborted) return stopped;
    if (signal.aborted) return failed(DEADLINE_ERROR, true);
    const { ordinal, effect } = effects[index]!;
    // Only a dataset Collection's run plans dataset effects.
    if (effect.kind !== "set" && effect.kind !== "add" && effect.kind !== "message" && effect.kind !== "notice" && effect.kind !== "wake") return failed(UNREADABLE_RUN_ERROR);
    // After a stop, records may have changed while the run waited, so every
    // effect checks each field before it writes. Only the first effect the
    // run had not recorded may have landed before the stop.
    const mode: EffectMode = !resumed ? "fresh" : index === firstUnrecorded ? "may-have-landed" : "resumed";
    let writes: RunWrite[];
    try {
      writes = await applyEffect(
        dependencies,
        { run, author, signal, ordinal, automationName: input.automation.name, depth: claim.depth + 1, chat },
        effect,
        mode,
      );
    } catch (error) {
      if (input.stopped.aborted) return stopped;
      if (error instanceof AutomationChatSessionWait) return { kind: "wait", reason: "session" };
      return signal.aborted ? failed(DEADLINE_ERROR, true) : failed(errorText(error));
    }
    const applied = { ordinal, writes };
    await dependencies.store.appendEffect(run, applied);
    run.applied.push(applied);
    run.updatedAtMs = dependencies.nowMs();
  }
  // A stop that came during the last write or its record leaves the run to
  // the next drain, which finds every effect recorded and completes it.
  if (input.stopped.aborted) return stopped;
  return { kind: "done" };
}

/**
 * How an effect writes: a fresh run writes as planned; after a stop, every
 * effect writes only fields still at their planned before value, and the
 * first effect the run had not recorded may already have landed.
 */
type EffectMode = "fresh" | "may-have-landed" | "resumed";

// What a field write did, from the seam's answer. A field the seam kept
// belongs to whoever changed it since the plan, so it is not the
// automation's write, and Undo leaves it alone.
function fieldWrites(
  target: { recordId: string; path: string },
  fields: readonly PlannedField[],
  result: RecordFieldsWritten,
  mode: EffectMode,
): RunWrite[] {
  const writes: RunWrite[] = [];
  for (const { field, before, after } of fields) {
    const base = { recordId: target.recordId, path: target.path, field };
    if (Object.hasOwn(result.replaced, field)) {
      writes.push({ kind: "field", ...base, before: (result.replaced[field] ?? null) as JsonValue, after });
    } else if (Object.hasOwn(result.kept, field)) {
      writes.push({ kind: "kept", ...base, planned: after, current: (result.kept[field] ?? null) as JsonValue });
    } else if (mode === "may-have-landed" && !isDeepStrictEqual(before, after)) {
      // The earlier attempt wrote it before the run stopped.
      writes.push({ kind: "field", ...base, before, after });
    } else if (mode === "resumed" && !isDeepStrictEqual(before, after)) {
      // Someone else gave it the planned value while the run waited.
      writes.push({ kind: "kept", ...base, planned: after, current: after });
    }
  }
  return writes;
}

/** Every effect's record if it lands as planned, to size a run before it writes. */
function projectedProgress(plan: readonly PlannedStep[]): StoredRun["applied"] {
  return plan.flatMap((step) => step.effects.map((effect) => {
    if (effect.kind === "message") {
      return { ordinal: step.ordinal, writes: [{ kind: "message" as const, messageId: effect.messageId, name: effect.name }] };
    }
    if (effect.kind === "notice") {
      return { ordinal: step.ordinal, writes: [{ kind: "notice" as const, noticeId: effect.notice.noticeId, name: effect.name }] };
    }
    if (effect.kind === "wake") {
      return { ordinal: step.ordinal, writes: [{ kind: "message" as const, messageId: effect.messageId, name: WAKE_TARGET_NAME }] };
    }
    // An action's changes are its own; its record holds no fields.
    if (effect.kind === "invoke") return { ordinal: step.ordinal, writes: [] };
    if (effect.kind === "add") {
      const path = `${effect.collectionPath}/${effect.name}.md`;
      return { ordinal: step.ordinal, writes: [
        { kind: "created" as const, recordId: effect.recordId, path },
        ...effect.fields.map(({ field, value }) => ({ kind: "field" as const, recordId: effect.recordId, path, field, before: null, after: value })),
      ] };
    }
    const target = "addedBy" in effect.target ? { recordId: "rec_".padEnd(30, "x"), path: "" } : effect.target;
    return { ordinal: step.ordinal, writes: effect.fields.map(({ field, before, after }) =>
      ({ kind: "field" as const, recordId: target.recordId, path: target.path, field, before, after })) };
  }));
}

async function applyEffect(
  dependencies: CollectionAutomationRunDependencies,
  context: {
    run: StoredRun;
    author: ChangeAuthor;
    signal: AbortSignal;
    ordinal: number;
    automationName: string;
    depth: number;
    chat: ChatDirectory | null;
  },
  effect: PlannedEffect,
  mode: EffectMode,
): Promise<RunWrite[]> {
  const { run, author, signal, ordinal } = context;
  if (effect.kind === "message" || effect.kind === "wake" || effect.kind === "notice") return await applyChatEffect(dependencies, context, effect);
  // A document Collection's automation that names an action never runs (unsupportedReason).
  if (effect.kind === "invoke") throw new Error("Only a dataset Collection has actions.");
  const key = stepKey(run.claimId, run.keySeed, ordinal);
  const seam = (edit: CollectionRecordWrites, path: string, recordId: string, fields: readonly PlannedField[]) =>
    edit.setFields({
      recordPath: path,
      fields: Object.fromEntries(fields.map(({ field, after }) => [field, after])),
      author,
      idempotencyKeyPrefix: `${key}/${recordId}`,
      ...(mode === "fresh" ? {} : { expectedBefore: Object.fromEntries(fields.map(({ field, before }) => [field, before])) }),
    });

  if (effect.kind === "add") {
    // The record's id comes from the claim and step, so an earlier attempt's
    // record is found again instead of added twice. When the engine gave the
    // file another id, the one this run recorded is the one to find.
    const known = [...run.created].reverse().find((entry) => entry.ordinal === ordinal);
    const created = await dependencies.withRecordWrites(signal, (edit) =>
      edit.create({
        collectionPath: effect.collectionPath,
        name: effect.name,
        author,
        recordId: known?.recordId ?? effect.recordId,
      }),
    );
    if (!known || known.recordId !== created.recordId || known.path !== created.path) {
      // Saved before its fields, so a failed seed resumes on this record.
      const entry = { ordinal, recordId: created.recordId, path: created.path };
      await dependencies.store.recordCreated(run, entry);
      run.created = [...run.created.filter((existing) => existing.ordinal !== ordinal), entry];
    }
    const fields = effect.fields.map(({ field, value }) => ({ field, before: null, after: value }));
    const writes: RunWrite[] = [{ kind: "created", recordId: created.recordId, path: created.path }];
    if (fields.length === 0) return writes;
    const result = await dependencies.withRecordWrites(signal, (edit) => seam(edit, created.path, created.recordId, fields));
    return [...writes, ...fieldWrites(created, fields, result, mode)];
  }

  // Find the record again by its id: it may have moved since the plan, and
  // a saved path alone could name another file now.
  const planned = "addedBy" in effect.target ? addedRecord(run, effect.target.addedBy) : effect.target;
  if (planned === null) throw new Error("dohc cannot find the record an earlier step added.");
  const path = await locate(dependencies, planned.collectionPath, planned.recordId);
  if (path === null) {
    return [{ kind: "skipped", recordId: planned.recordId, path: planned.path, reason: "The record is no longer in the Collection." }];
  }
  const target = { recordId: planned.recordId, path };
  const result = await dependencies.withRecordWrites(signal, (edit) => seam(edit, path, planned.recordId, effect.fields));
  return fieldWrites(target, effect.fields, result, mode);
}

/**
 * Sends one post, direct message, wake, or notice as the automation, at
 * `depth`, and says what it sent. Every attempt sends the same ids, so a
 * retry, or an attempt that stopped after the send landed, sends it once.
 */
export async function applyChatEffect(
  dependencies: Pick<CollectionAutomationRunDependencies, "chat" | "postNotice">,
  context: { run: StoredRun; signal: AbortSignal; automationName: string; depth: number; chat: ChatDirectory | null },
  effect: Extract<PlannedEffect, { kind: "message" | "wake" | "notice" }>,
): Promise<RunWrite[]> {
  const { run, signal } = context;
  if (effect.kind === "message") {
    // A saved direct message goes only where the plan meant: the same
    // conversation, still with exactly that person.
    if (effect.to.kind === "direct-message") {
      const now = context.chat?.directMessage(effect.to.userId);
      if (!now || "problem" in now || now.threadId !== effect.to.threadId) {
        throw new Error(`The people in ${effect.name} changed since this run began, so dohc did not send its message.`);
      }
    }
    // The engine records the message under its effect id, so a retry, or an
    // attempt that stopped after the write landed, replays it.
    await dependencies.chat.write(signal, {
      target: effect.to.kind === "group"
        ? { kind: "group", channelId: effect.to.channelId, lane: effect.to.lane }
        : { kind: "direct-message", threadId: effect.to.threadId },
      effectId: effect.effectId,
      messageId: effect.messageId,
      threadId: effect.threadId,
      automation: { automationId: run.automationId, name: context.automationName, depth: context.depth },
      body: effect.body,
    });
    return [{ kind: "message", messageId: effect.messageId, name: effect.name }];
  }
  if (effect.kind === "wake") {
    await dependencies.chat.write(signal, {
      target: { kind: "agent" },
      effectId: effect.effectId,
      messageId: effect.messageId,
      threadId: effect.threadId,
      automation: { automationId: run.automationId, name: context.automationName, depth: context.depth },
      body: effect.body,
    });
    return [{ kind: "message", messageId: effect.messageId, name: WAKE_TARGET_NAME }];
  }
  // Each person's notice is its own effect, recorded once it is sent, so a
  // retry resumes with the people not yet notified. The outbox and the
  // relay drop a repeat of the same id.
  try {
    await dependencies.postNotice(effect.notice, signal);
  } catch (error) {
    if (error instanceof NoticeNotSentError) throw new Error(`dohc could not notify ${effect.name}. ${error.message}`);
    throw error;
  }
  return [{ kind: "notice", noticeId: effect.notice.noticeId, name: effect.name }];
}

function addedRecord(run: StoredRun, ordinal: number): { recordId: string; collectionPath: string; path: string } | null {
  const add = run.plan?.find((step) => step.ordinal === ordinal)?.effects.find((effect) => effect.kind === "add");
  const created = run.applied.find((entry) => entry.ordinal === ordinal)?.writes.find((write) => write.kind === "created");
  return add?.kind === "add" && created?.kind === "created"
    ? { recordId: created.recordId, collectionPath: add.collectionPath, path: created.path }
    : null;
}
