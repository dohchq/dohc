import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AutomationTimeSpent, JsonObject, JsonValue } from "@dohc/app-backend-runtime/automation";
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
import type { AutomationTargets, TargetResolution } from "./automationTargets";
import {
  codeFilesOf,
  codeRecordKey,
  codeStepOrdinals,
  conditionsHold,
  conditionsRequest,
  definitionHash,
  evaluateRequest,
  findOverflowError,
  findQueryOf,
  MAX_FOUND_RECORDS,
  parseCollectionAutomationId,
  reachStepsOf,
  runRecordOf,
  scheduleDueAt,
  stepKey,
  stepsInOrder,
  bindingsIn,
  triggerMatches,
  type CodeChange,
  type PlannedEffect,
  type PlannedField,
  type RunClaim,
  type RunContext,
  type RunRecord,
} from "./automationPlan";
import { checkAutomationReach, type ReachCollection, type ReachRoster, type ReachStep, type StepReach } from "./automationReach";
import {
  chatNeedsOf,
  NoticeNotSentError,
  type AutomationChatMessage,
  type AutomationNotice,
  type ChatDirectory,
  type ChatNeeds,
} from "./automationChat";
import type { AutomationRunStore, RunWrite, StoredRun, StoredStep } from "./automationRunStore";
import { KEPT_CHANGING_ERROR, runSteps, StepRecordChanged, unfinishedStep, type EffectMode, type StepBackend } from "./automationStepRun";

// One run of one claim: check reach, check the trigger and its conditions,
// then run the steps in order (automationStepRun.ts). The executor settles
// the claim with the outcome.

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
export const LOST_COLLECTION_ERROR = "A Collection this run changes is no longer in this workspace, so the run stopped.";
export const RULES_CHANGED_ERROR = "Collection rules changed after this run started.";

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
  targets: AutomationTargets;
  /** Engine reads; resolves null when the engine is unavailable. */
  withReads<T>(work: (reads: CollectionAutomationReads) => Promise<T>): Promise<T | null>;
  /** Record writes with the workspace's write authority, ending at `signal`. */
  withRecordWrites<T>(signal: AbortSignal, work: (writes: CollectionRecordWrites) => Promise<T>): Promise<T>;
  /** A document Collection's id, the object id of its collection.yaml, or null when the folder is not one. */
  collectionIdOf(path: string): string | null;
  /** Where the document Collection with this id is now, or null when this workspace has none. */
  collectionPathOf(collectionId: string): string | null;
  /** A code file a step runs, as text; null when it does not exist. */
  readCode(path: string): Promise<{ text: string; truncated: boolean } | null>;
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
   * Keeps a verdict for each person a formula named and each Collection a
   * code step named, as for any step, and says which of them wait for a
   * current editor to allow them.
   */
  recipientVerdicts(input: {
    automationId: string;
    definitionHash: string;
    recipients: readonly RecipientReach[];
  }): Promise<Array<"allowed" | "held" | "stopped">>;
}

/**
 * A person a formula named, or a Collection a code step named, with what the
 * roster says about reaching it. `id` is the person's user id or the
 * Collection's path.
 */
interface RecipientReach {
  /** The step's place in the automation. */
  step: number;
  id: string;
  name: string;
  action: "post" | "notify" | "change";
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
  // Or the automation's Collection moved while the run wrote: the next drain
  // checks the run again where the Collection is now.
  | { kind: "wait"; reason: "busy" | "engine" | "stopped" | "session" | "held" | "roster" | "moved" };

export interface CollectionAutomationRunInput {
  claim: AutomationClaim;
  automation: Automation;
  /** The automation's Collection, where it is now. */
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

/** A Collection as reach and messages name it, from its workspace path. */
const collectionNamed = (path: string): ReachCollection => ({ path, name: path.split("/").at(-1) ?? path });

/** Why a step cannot read or change a Collection's records through this executor, or null. */
function targetProblem(resolved: TargetResolution): string | null {
  if (resolved.kind === "problem") return resolved.problem;
  // A dataset's records change only through its approved operations.
  if (resolved.kind === "dataset") {
    return `Automations cannot use ${resolved.collection.name} yet, because its records change only through its Collection actions.`;
  }
  return null;
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
  // The ledger handed the claim out again without a Try again, as after a
  // crash before the failure reached it: the run stays failed.
  if (current?.outcome?.state === "failed" && current.outcome.run === claim.run) {
    return { outcome: { kind: "failed-before", error: current.outcome.error } };
  }
  return { current };
}

/** A new run's record, before anything of it is saved. */
export function newRun(claim: Pick<AutomationClaim, "automationId" | "claimId">, automation: Automation, keySeed: string, nowMs: number): StoredRun {
  return {
    version: 6,
    claimId: claim.claimId,
    automationId: claim.automationId,
    definitionHash: definitionHash(automation),
    keySeed,
    startedAtMs: nowMs,
    finishedAtMs: null,
    steps: [],
    applied: [],
    created: [],
    replans: [],
    undoRequests: [],
    readableFields: null,
    collections: [],
    rules: null,
    superseded: false,
    undo: null,
    settled: false,
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
  // A run that started while the Collection kept its records in a dataset
  // wrote them there; it never goes on as document writes.
  if (current !== null && current.rules !== null) return failed(RULES_CHANGED_ERROR);
  const liveTargets = dependencies.targets;
  const resolved = new Map<string, Promise<TargetResolution>>();
  dependencies = { ...dependencies, targets: { resolve: (path) => {
    let target = resolved.get(path);
    if (target === undefined) {
      target = liveTargets.resolve(path);
      resolved.set(path, target);
    }
    return target;
  } } };

  // Where the automation's messages go, found once for the reach check and
  // the steps.
  let chat: ChatDirectory | null = null;
  if (readsChats(automation)) {
    chat = await dependencies.chat.directory(roster, chatNeedsOf([automation]));
    if (chat === null) return { kind: "wait", reason: "engine" };
  }
  const groupChanged = groupChangedOutcome(automation, claim, chat, current !== null);
  if (groupChanged !== null) return groupChanged;
  // Reach (ADR 0012), before anything is read. The targets are in the file,
  // so the check needs only the roster.
  const steps = reachStepsOf(automation, collection, collectionNamed, chat);
  for (const verdict of checkAutomationReach(roster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps })) {
    if (!verdict.allowed) return failed(verdict.reason);
  }
  // Saved steps write where they planned, followed to where those
  // Collections are now, and checked there on every resume.
  if (current !== null) {
    const followed = await followCollections(dependencies, input, current, true);
    if (followed !== null) return followed;
  }
  // The Collections the file names for steps not saved yet must still be
  // ones this executor can use; a saved step's were followed above.
  const savedSteps = new Set(current?.steps.map((step) => step.ordinal));
  for (const target of fileTargets(automation, collection, savedSteps)) {
    const problem = targetProblem(await dependencies.targets.resolve(target.path));
    if (problem !== null) return failed(problem);
  }

  // The file names no Collection a code step changes, so the step an
  // earlier attempt left part way has its checked again here, as the file's
  // are above.
  const unfinished = current === null ? null : unfinishedStep(current);
  if (unfinished !== null) {
    const checked = await checkCodeTargets(dependencies, input, savedCodeTargets(automation, unfinished));
    if (checked !== null) return checked;
  }
  let message: RunContext["message"] = null;
  if (claim.change.kind === "message") {
    const got = await groupMessage(dependencies, claim, automation, chat);
    if ("outcome" in got) return got.outcome;
    message = got.message;
  }
  // A Group message's formulas name its author from the message itself.
  const personId = claim.change.kind === "message" ? null : claimPerson(claim);
  // A new run's keys and added record ids come from the definition and the
  // claim's run, never from what history kept: a start-over is a new run, so
  // the engine takes its writes as new, and a crash requeue keeps the run,
  // so it replays the same keys. A resumed run keeps its own seed.
  const run = current ?? newRun(claim, automation, `${definitionHash(automation)}-${claim.run}`, dependencies.nowMs());
  const ctx: RunContext = {
    automation,
    // A claim made before its Collection moved runs where the Collection is now.
    claim: { ...claim, collectionPath: collection.path },
    message,
    person: personId === null ? null : { id: personId, name: dependencies.personName(personId) },
    chat,
    // Formulas read `now` as the time of the change, or a schedule's due
    // time, so every attempt reads the same.
    nowMs: scheduleDueAt(claim) ?? claim.createdAtMs,
    key: { claimId: claim.claimId, hash: run.keySeed },
  };
  const backend = documentBackend(dependencies, input, ctx, liveTargets);
  // One evaluator budget for the whole attempt: its conditions, then every step.
  const spent: AutomationTimeSpent = { prepareMs: 0, runMs: 0 };
  if (current === null) {
    const started = await startRun(dependencies.evaluator, backend, ctx, spent);
    if (started !== null) return input.stopped.aborted ? stopped : started;
  }
  return await runSteps(dependencies, backend, { ...input, claimRun: claim.run }, ctx, run, current !== null, spent);
}

/**
 * Checks a new run's trigger and conditions against the trigger record, once:
 * a resumed run went ahead already. Null when the run goes ahead, or how it
 * ends instead.
 */
export async function startRun(
  evaluator: AutomationFormulaEvaluator,
  backend: StepBackend,
  ctx: RunContext,
  spent: AutomationTimeSpent,
): Promise<CollectionAutomationRunOutcome | null> {
  const { automation, claim } = ctx;
  const read = await backend.step(async (reads) => ({ record: await reads.trigger() }));
  if (read === null) return { kind: "wait", reason: "engine" };
  if (read === "moved") return { kind: "wait", reason: "moved" };
  if (read === "changed") return failed(KEPT_CHANGING_ERROR);
  const { record } = read;
  // The record was removed before its automation ran.
  if (record === null && claim.change.kind !== "removed" && hasTriggerRecord(claim)) return { kind: "skipped" };
  if (!triggerMatches(automation, claim, record)) return { kind: "skipped" };
  const request = conditionsRequest(ctx, record);
  if (request.items.length === 0) return null;
  const results = await evaluateRequest(evaluator, claim.automationId, request, spent);
  if (results === "busy") return { kind: "wait", reason: "busy" };
  const holds = conditionsHold(ctx, record, request, results);
  if (holds === "go") return null;
  return holds === "skip" ? { kind: "skipped" } : failed(holds.error, holds.timedOut);
}

/** Whether the claim names a record: a schedule or a Group message has none. */
function hasTriggerRecord(claim: RunClaim): boolean {
  return claim.change.kind !== "message" && claim.change.kind !== "schedule";
}

/**
 * Checks every message and notice of the steps under this roster, before
 * anything is sent, and answers the directory the step sends with. A person
 * only a formula named has no verdict from the file, so they keep one here:
 * one an editor's leaving allowed waits for Allow. A saved direct message is
 * checked against its conversation as it is now, read for the steps' own
 * people.
 */
export async function checkPlannedMessages(
  dependencies: Pick<CollectionAutomationRunDependencies, "chat" | "recipientVerdicts">,
  input: { automationId: string; automation: Automation; collection: ReachCollection; roster: Exclude<ReachRoster, { kind: "unknown" }> },
  planned: readonly StoredStep[],
  chat: ChatDirectory | null,
): Promise<{ chat: ChatDirectory | null } | { outcome: CollectionAutomationRunOutcome }> {
  const { automation, collection, roster } = input;
  const effects = planned.flatMap((step) => step.effects.map((effect) => ({ ordinal: step.ordinal, effect })));
  const messages = effects.flatMap(({ ordinal, effect }): Array<{ ordinal: number; effect: PlannedEffect; step: ReachStep }> => {
    if (effect.kind === "message") {
      return [{ ordinal, effect, step: { kind: "post", group: { channelWireId: effect.channelWireId, name: effect.name } } }];
    }
    if (effect.kind === "notice") {
      return [{ ordinal, effect, step: { kind: "notify", person: { userId: effect.notice.recipientUserId, name: effect.name } } }];
    }
    return [];
  });
  if (messages.length === 0) return { chat };
  const verdicts = checkAutomationReach(roster, {
    id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps: messages.map(({ step }) => step),
  });
  const recipients: RecipientReach[] = [];
  for (const [index, { ordinal, effect }] of messages.entries()) {
    if (effect.kind === "message" && effect.byFormula && effect.to.kind === "direct-message") {
      recipients.push({ step: ordinal, id: effect.to.userId, name: effect.name, action: "post", reach: verdicts[index]! });
    } else if (effect.kind === "notice" && effect.byFormula) {
      recipients.push({ step: ordinal, id: effect.notice.recipientUserId, name: effect.name, action: "notify", reach: verdicts[index]! });
    }
  }
  // Kept before anything fails, so a stop is remembered for the next run.
  const kept = recipients.length === 0 ? [] : await dependencies.recipientVerdicts({
    automationId: input.automationId, definitionHash: definitionHash(automation), recipients,
  });
  const stoppedReach = verdicts.find((reach) => !reach.allowed);
  if (stoppedReach && !stoppedReach.allowed) return { outcome: failed(stoppedReach.reason) };
  if (kept.includes("held")) return { outcome: { kind: "wait", reason: "held" } };
  const planPeople = new Set(effects.flatMap(({ effect }) =>
    effect.kind === "message" && effect.to.kind === "direct-message" ? [effect.to.userId] : []));
  if (planPeople.size === 0) return { chat };
  const sendChat = await dependencies.chat.directory(roster, { groups: new Set(), people: planPeople });
  return sendChat === null ? { outcome: { kind: "wait", reason: "engine" } } : { chat: sendChat };
}

/** A document record by its id, or null when it left the Collection. */
async function readDocumentRecord(reads: CollectionAutomationReads, collectionPath: string, recordId: string): Promise<RunRecord | null> {
  try {
    return runRecordOf((await reads.getCollectionRecord({ collectionPath, recordId, historyLimit: 1 })).record);
  } catch (error) {
    if (error instanceof Error && error.message === RECORD_NOT_FOUND) return null;
    throw error;
  }
}

/**
 * The person a run acts for: who pressed its button, wrote its Group
 * message, or made the record change or had an agent or automation make it.
 * Null when nobody is known, as for a schedule, an Edit share link's change,
 * or a file another program wrote.
 */
export function claimPerson(claim: AutomationClaim): string | null {
  return claim.change.kind === "schedule" ? null : claim.change.onBehalfOf;
}

/**
 * How a document Collection's run reads and writes: through the engine,
 * which answers each read with the writes of the steps before it, since each
 * write settles before it returns.
 */
function documentBackend(dependencies: CollectionAutomationRunDependencies, input: CollectionAutomationRunInput, ctx: RunContext, liveTargets: AutomationTargets): StepBackend {
  const { automation, signal } = input;
  // The claim as the steps read it: where its Collection is now.
  const claim = { ...input.claim, collectionPath: ctx.claim.collectionPath };
  const home = parseCollectionAutomationId(claim.automationId)?.collectionId ?? null;
  const ordered = new Map(stepsInOrder(automation).map(({ ordinal, step }) => [ordinal, step]));
  // The Collection the Find or Add record step at `ordinal` reads or adds to.
  const collectionOf = (ordinal: number) => {
    const step = ordered.get(ordinal);
    return (step && (step.kind === "find" || step.kind === "add-record") ? step.collection : null) ?? claim.collectionPath;
  };
  // The run's writes carry its person on, so a change they cause names the
  // same person, and a run with nobody names nobody.
  const personId = claimPerson(claim);
  const author: ChangeAuthor = {
    kind: "automation",
    automationId: claim.automationId,
    ...(personId === null ? {} : { onBehalfOf: personId }),
    depth: claim.depth + 1,
  };
  return {
    async step(work) {
      return await dependencies.withReads(async (reads) => {
        const homePath = home === null ? null : dependencies.collectionPathOf(home);
        if (homePath === null) throw new Error("This automation's Collection is gone.");
        if (homePath !== input.collection.path) return "moved" as const;
        // Each record the step read, by Collection and id, so one step sees
        // one version of it however many ways it reads it.
        const seen = new Map<string, RunRecord>();
        const remember = (collectionPath: string, record: RunRecord) => {
          const key = JSON.stringify([collectionPath, record.id]);
          const earlier = seen.get(key);
          if (earlier === undefined) {
            seen.set(key, record);
            return record;
          }
          if (!isDeepStrictEqual(earlier.values, record.values)) throw new StepRecordChanged();
          return earlier;
        };
        const read = async (collectionPath: string, recordId: string) => {
          const earlier = seen.get(JSON.stringify([collectionPath, recordId]));
          if (earlier !== undefined) return earlier;
          const problem = targetProblem(await dependencies.targets.resolve(collectionPath));
          if (problem !== null) throw new Error(problem);
          const record = await readDocumentRecord(reads, collectionPath, recordId);
          return record === null ? null : remember(collectionPath, record);
        };
        try {
          return await work({
            trigger: async () => (claim.change.kind === "removed" || claim.recordId === null ? null : await read(claim.collectionPath, claim.recordId)),
            async bound(ordinal, refs) {
              const records: RunRecord[] = [];
              for (const ref of refs) {
                // A record lives directly in its Collection's folder, which a move of the Collection carries.
                const record = await read(posix.dirname(ref.path), ref.id);
                if (record !== null) records.push(record);
              }
              return records;
            },
            findValues(ordinal) {
              const step = ordered.get(ordinal);
              const query = step?.kind === "find" ? findQueryOf(step.condition) : { problem: "" };
              return "problem" in query || query.match === "all" ? [] : [query.value];
            },
            async find(ordinal, values) {
              const step = ordered.get(ordinal);
              const query = step?.kind === "find" ? findQueryOf(step.condition) : null;
              if (query === null || "problem" in query) throw new Error(query?.problem ?? `Step ${ordinal + 1} is not a Find.`);
              const problem = targetProblem(await dependencies.targets.resolve(collectionOf(ordinal)));
              if (problem !== null) throw new Error(problem);
              const result = await reads.queryCollectionRecords({
                collectionPath: collectionOf(ordinal),
                ...(query.match === "all" ? {} : { filter: { field: query.field, operator: query.operator, value: values[0] ?? null } }),
                limit: MAX_FOUND_RECORDS,
              });
              // Never bind a partial page.
              return result.nextCursor !== null ? { problem: findOverflowError(ordinal) } : result.records.map((record) => remember(collectionOf(ordinal), runRecordOf(record)));
            },
            codeRecords: (changes) => codeRecords(dependencies, input, read, changes),
            // A record's Collection is the folder it is in, wherever the file last named it.
            effects: (_ordinal, planned) => planned.map((effect) => (effect.kind === "set"
              ? { ...effect, target: { ...effect.target, collectionPath: posix.dirname(effect.target.path) } }
              : effect)),
          });
        } catch (error) {
          if (error instanceof StepRecordChanged) return "changed" as const;
          throw error;
        }
      });
    },
    collectionsOf: (step) => collectionsOf(dependencies, [step]),
    added(run, ordinal) {
      const created = run.applied.find((entry) => entry.ordinal === ordinal)?.writes.find((write) => write.kind === "created");
      return created?.kind === "created" ? { id: created.recordId, path: created.path } : null;
    },
    async apply(run, planned, place, chat) {
      // Another Collection the steps write moved: followed, and checked there.
      const followed = await followCollections(dependencies, input, run, false);
      if (followed !== null) return { outcome: followed };
      const effect = run.steps.find((step) => step.ordinal === place.ordinal)?.effects[place.part] ?? planned;
      // The automation's own Collection moved since the run was checked: who
      // can edit it, and where a relayed press may run, are decided again
      // before it writes, just before each effect starts.
      const homePath = home === null ? null : dependencies.collectionPathOf(home);
      if (homePath === null) return { outcome: failed("This automation's Collection is gone.") };
      if (homePath !== input.collection.path) return { outcome: { kind: "wait", reason: "moved" } };
      // Only a dataset Collection's run plans dataset effects.
      if (effect.kind !== "set" && effect.kind !== "add" && effect.kind !== "message" && effect.kind !== "notice" && effect.kind !== "wake" && effect.kind !== "invoke") {
        return { outcome: failed(UNREADABLE_RUN_ERROR) };
      }
      if (effect.kind === "set" || effect.kind === "add") {
        const path = effect.kind === "set" ? effect.target.collectionPath : effect.collectionPath;
        const problem = targetProblem(await liveTargets.resolve(path));
        if (problem !== null) return { outcome: failed(problem) };
      }
      return await applyEffect(dependencies, { run, author, signal, ordinal: place.ordinal, automationName: automation.name, depth: claim.depth + 1, chat }, effect, place.mode);
    },
  };
}

/** A Collection a code step changes records in, and the fields it sets there. */
type CodeTarget = { ordinal: number; collection: string; fields: readonly string[] };

/** The Collections a saved code step changes records in. */
function savedCodeTargets(automation: Automation, { ordinal, effects }: StoredStep): CodeTarget[] {
  if (!codeStepOrdinals(automation).has(ordinal)) return [];
  return effects.flatMap((effect): CodeTarget[] => {
    if (effect.kind === "add") return [{ ordinal, collection: effect.collectionPath, fields: effect.fields.map(({ field }) => field) }];
    if (effect.kind === "set") return [{ ordinal, collection: effect.target.collectionPath, fields: effect.fields.map(({ field }) => field) }];
    return [];
  });
}

/**
 * Checks each Collection and field the code steps change, as a Set fields
 * or Add record step's are checked on every attempt, or answers why the run
 * cannot go on. Reach (ADR 0012) applies to what the code named: nobody
 * reaches more by writing code. Each code step keeps a verdict for each
 * Collection it named, as for a person a formula named, before anything
 * fails. So a stop is remembered, and removing an editor never switches on
 * a change they could not make.
 */
async function checkCodeTargets(
  dependencies: CollectionAutomationRunDependencies,
  input: CollectionAutomationRunInput,
  targets: readonly CodeTarget[],
): Promise<CollectionAutomationRunOutcome | null> {
  const { automation, collection, roster } = input;
  const named = new Map<string, { step: number; target: ReachCollection }>();
  for (const { ordinal, collection: path } of targets) named.set(JSON.stringify([ordinal, path]), { step: ordinal, target: collectionNamed(path) });
  if (named.size === 0) return null;
  const verdicts = checkAutomationReach(roster, {
    id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path),
    steps: [...named.values()].map(({ target }): ReachStep => ({ kind: "change-records", collection: target })),
  });
  const recipients = [...named.values()].map(({ step, target }, index): RecipientReach => ({
    step, id: target.path, name: target.name, action: "change", reach: verdicts[index]!,
  }));
  const kept = await dependencies.recipientVerdicts({ automationId: input.claim.automationId, definitionHash: definitionHash(automation), recipients });
  const stop = (step: number, name: string, reason: string) => failed(`The code in step ${step + 1} changes records in ${name}. ${reason}`);
  for (const { step, name, reach } of recipients) {
    if (!reach.allowed) return stop(step, name, reach.reason);
  }
  if (kept.includes("held")) return { kind: "wait", reason: "held" };
  for (const { step, target } of named.values()) {
    const resolved = await dependencies.targets.resolve(target.path);
    if (resolved.kind !== "document") return stop(step, target.name, targetProblem(resolved)!);
    const fields = resolved.fields;
    if (fields === null) continue;
    for (const change of targets) {
      if (change.ordinal !== step || change.collection !== target.path) continue;
      const missing = change.fields.find((field) => !fields.has(field));
      if (missing !== undefined) return failed(`The code in step ${step + 1} sets ${missing}, which is not a field in ${target.name}.`);
    }
  }
  return null;
}

/**
 * Checks what a code step changes, then reads each record it changes. A
 * record that is not in its Collection is left out, and the step says so.
 */
async function codeRecords(
  dependencies: CollectionAutomationRunDependencies,
  input: CollectionAutomationRunInput,
  read: (collectionPath: string, recordId: string) => Promise<RunRecord | null>,
  changes: readonly CodeChange[],
): Promise<{ records: Map<string, RunRecord> } | { outcome: CollectionAutomationRunOutcome }> {
  const checked = await checkCodeTargets(dependencies, input, changes.map(({ ordinal, collection, fields }) => ({ ordinal, collection, fields: Object.keys(fields) })));
  if (checked !== null) return { outcome: checked };
  const records = new Map<string, RunRecord>();
  for (const change of changes) {
    if (change.action !== "change" || change.id === null) continue;
    const key = codeRecordKey(change.collection, change.id);
    if (records.has(key)) continue;
    const record = await read(change.collection, change.id);
    if (record !== null) records.set(key, record);
  }
  return { records };
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
      // Every write lands only on the value its step read, so a write that
      // landed before a crash replaced exactly that value, and a change
      // someone made since the step read the record stays.
      expectedBefore: Object.fromEntries(fields.map(({ field, before }) => [field, before])),
    });

  if (effect.kind === "add") {
    // The record's id comes from the claim and step, so an earlier attempt's
    // record is found again instead of added twice. When the engine gave the
    // file another id, the one this run recorded is the one to find.
    const known = run.created.find((entry) => entry.planned === effect.recordId);
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
      const entry = { ordinal, planned: effect.recordId, recordId: created.recordId, path: created.path };
      await dependencies.store.recordCreated(run, entry);
      run.created = [...run.created.filter((existing) => existing.planned !== effect.recordId), entry];
    }
    const fields = effect.fields.map(({ field, value }) => ({ field, before: null, after: value }));
    const writes: RunWrite[] = [{ kind: "created", recordId: created.recordId, path: created.path }];
    if (fields.length === 0) return writes;
    const result = await dependencies.withRecordWrites(signal, (edit) => seam(edit, created.path, created.recordId, fields));
    return [...writes, ...fieldWrites(created, fields, result, mode)];
  }

  // Find the record again by its id: it may have moved since the step read
  // it, and a saved path alone could name another file now.
  const planned = effect.target;
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

/**
 * The Collections the file names for the steps not in `saved`: those a Find
 * reads, an Add record adds to, or a Set changes the records of, as reach
 * counts them.
 */
function fileTargets(automation: Automation, collection: ReachCollection, saved: ReadonlySet<number>): ReachCollection[] {
  const bindings = bindingsIn(automation);
  const targets = new Map<string, ReachCollection>();
  for (const { ordinal, step } of stepsInOrder(automation)) {
    if (saved.has(ordinal)) continue;
    const path = step.kind === "find" || step.kind === "add-record" ? step.collection
      : step.kind === "set" && step.records !== null ? (bindings.get(step.records)?.collection ?? null)
      : step.kind === "set" || step.kind === "run" || step.kind === "run-file" ? null
      : undefined;
    if (path === undefined) continue;
    const target = path === null ? collection : collectionNamed(path);
    targets.set(target.path, target);
  }
  return [...targets.values()];
}

/** Each document Collection the steps write, with its Collection id. */
function collectionsOf(
  dependencies: Pick<CollectionAutomationRunDependencies, "collectionIdOf">,
  steps: readonly StoredStep[],
): StoredRun["collections"] {
  const paths = new Set<string>();
  for (const { effects } of steps) {
    for (const effect of effects) {
      if (effect.kind === "add") paths.add(effect.collectionPath);
      if (effect.kind === "set") paths.add(effect.target.collectionPath);
    }
  }
  return [...paths].flatMap((path) => {
    const collectionId = dependencies.collectionIdOf(path);
    return collectionId === null ? [] : [{ collectionId, path }];
  });
}

/**
 * Moves a saved run to where the Collections its plan writes are now, and
 * checks them there as a new plan's targets are checked: each still a
 * document Collection that everyone who can edit the automation can change.
 * `always` checks them even when none moved, as a resume must. Saves a run
 * that moved. Answers the outcome that stops the run, or null.
 */
async function followCollections(
  dependencies: CollectionAutomationRunDependencies,
  input: Pick<CollectionAutomationRunInput, "automation" | "collection" | "roster">,
  run: StoredRun,
  always: boolean,
): Promise<CollectionAutomationRunOutcome | null> {
  const { moved, lost } = rebaseRun(run, (collectionId) => dependencies.collectionPathOf(collectionId));
  if (lost) return failed(LOST_COLLECTION_ERROR);
  if (!moved && !always) return null;
  const targets = run.collections.map(({ path }): ReachCollection => ({ path, name: posix.basename(path) }));
  const steps = targets.map((target): ReachStep => ({ kind: "change-records", collection: target }));
  for (const verdict of checkAutomationReach(input.roster, { id: input.automation.id, collection: input.collection, codeFiles: [], steps })) {
    if (!verdict.allowed) return failed(verdict.reason);
  }
  for (const target of targets) {
    const problem = targetProblem(await dependencies.targets.resolve(target.path));
    if (problem !== null) return failed(problem);
  }
  if (moved) await dependencies.store.save(run);
  return null;
}

/**
 * Moves a saved run's paths to where its Collections are now, found by
 * their Collection ids. A record lives directly in its Collection's folder,
 * so a record path moves with its folder. `lost` says a Collection the run
 * writes is no longer in this workspace; its paths stay, and its records
 * are not found there.
 */
export function rebaseRun(run: StoredRun, collectionPathOf: (collectionId: string) => string | null): { moved: boolean; lost: boolean } {
  const moves = new Map<string, string>();
  let lost = false;
  run.collections = run.collections.map((entry) => {
    const now = collectionPathOf(entry.collectionId);
    lost ||= now === null;
    if (now === null || now === entry.path) return entry;
    moves.set(entry.path, now);
    return { ...entry, path: now };
  });
  if (moves.size === 0) return { moved: false, lost };
  const folder = (path: string) => moves.get(path) ?? path;
  const record = (path: string) => {
    const moved = moves.get(posix.dirname(path));
    return moved === undefined ? path : `${moved}/${posix.basename(path)}`;
  };
  run.steps = run.steps.map((step) => ({
    ...step,
    effects: step.effects.map((effect) => {
      if (effect.kind === "add") return { ...effect, collectionPath: folder(effect.collectionPath) };
      if (effect.kind !== "set") return effect;
      return { ...effect, target: { ...effect.target, collectionPath: folder(effect.target.collectionPath), path: record(effect.target.path) } };
    }),
    // A Find's records live in their Collection's folder too.
    ...(step.output?.kind === "find" ? { output: { kind: "find" as const, records: step.output.records.map((ref) => ({ ...ref, path: record(ref.path) })) } } : {}),
  }));
  run.applied = run.applied.map((entry) => ({
    ...entry,
    writes: entry.writes.map((write) => "path" in write ? { ...write, path: record(write.path) } : write),
  }));
  run.created = run.created.map((entry) => ({ ...entry, path: record(entry.path) }));
  return { moved: true, lost };
}
