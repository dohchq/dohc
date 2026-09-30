import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseAutomationsFile,
  writeAutomationsFile,
  type Automation,
  type AutomationDiagnostic,
  type AutomationEntry,
  type AutomationScheduleTrigger,
  type AutomationsFileParseResult,
} from "@dohc/workspace-contracts/automations";
import { COLLECTION_SCHEMA_FILENAME, collectionVersionError, type CollectionListResult } from "@dohc/workspace-contracts/collection";
import { isNormalizedRelativePath, parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { AUTOMATION_NEVER_STARTED_REFUSAL } from "@dohc/app-backend-runtime/dataset-automation-claims";
import { AUTOMATION_HOST_REACH_MAX_BYTES } from "@dohc/workspace-contracts/relay";
import type {
  DatasetAutomationClaim,
  DatasetAutomationFailure,
  DatasetAutomationSubscription,
  DatasetPressed,
  DatasetPressInput,
  DatasetRememberedPress,
} from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetDefinition, DatasetDescription } from "@dohc/security-contract/dataset";
import type { WatcherEvent } from "@dohc/workspace-core";
import {
  isInvalidInputRefusal,
  type AutomationClaim,
  type AutomationClaimSummary,
  type SharedChangeAuthor,
  type AutomationGroupRelayRecord,
  type AutomationPressActor,
  type AutomationReleaseGroupsResult,
  type AutomationWatchGroupsParams,
  type VersionedLiveAdapter,
} from "@dohc/workspace-engine-client";
import { changedSincePressed, datasetButtonAccess, namesButton, noAccessReason, resolveButton, type AutomationButtonState } from "./automationButtons";
import type { AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import {
  codeFilesOf,
  collectionAutomationId,
  COLLECTION_AUTOMATION_PREFIX,
  datasetSubscriptionFor,
  definitionDigest,
  definitionHash,
  directMessageReach,
  fieldWritesOf,
  fieldsNamedBy,
  parseCollectionAutomationId,
  scheduleHash,
  stepsInOrder,
  subscriptionFor,
} from "./automationPlan";
import {
  checkAutomationReach,
  reachStepId,
  shareImpactOf,
  type ReachCollection,
  type ReachRoster,
  type ReachDatasetGrants,
  type ReachShare,
  type ReachStep,
} from "./automationReach";
import type { AutomationRunStore, ClaimStanding, DatasetUndoCall, ExpiringClaim, ReportedFailure, RunWrite, StoredRun, StoredSubscription } from "./automationRunStore";
import {
  runCollectionAutomation,
  runsForClaim,
  UNDONE_RUN_ERROR,
  sendsMessages,
  RECORD_NOT_FOUND,
  UNREADABLE_RUN_ERROR,
  type AutomationChatDependencies,
  type ClaimRuns,
  type CollectionAutomationReads,
  type CollectionAutomationRunDependencies,
  type CollectionAutomationRunOutcome,
  rebaseRun,
  LOST_COLLECTION_ERROR,
} from "./collectionAutomationRun";
import { automationInventory, type AutomationInventory } from "./automationInventory";
import { AutomationRunWait } from "./automationRunWait";
import { automationUndoReach, undoAutomationRuns } from "./automationUndo";
import {
  type CollectionAutomationUndone,
} from "./collectionAutomationUndo";
import {
  datasetIrreversibleActions,
  datasetFieldWritesOf,
  datasetTableNamed,
  datasetUndoDeletes,
  pinDatasetOperations,
  type DatasetRecordId,
} from "./datasetAutomationPlan";
import { datasetPresser, datasetRecordExists, runDatasetAutomation, type DatasetRunClaim, type DatasetRunHost } from "./datasetAutomationRun";
import {
  datasetUndoDeletesRecorded,
  datasetUndoLostRun,
  datasetUndoRulesChanged,
  DATASET_UNDO_RULES_CHANGED,
  planDatasetUndo,
  type DatasetUndoConfirmed,
  type DatasetUndoHost,
  type DatasetUndoPreview,
} from "./datasetAutomationUndo";
import { createAutomationTargets } from "./automationTargets";
import {
  definitionKey,
  mergedReachVerdict,
  nextReachVerdict,
  sameReachVerdict,
  reachVerdictKey,
  type ReachHandover,
  type ReachRelayRecord,
  type StoredReachVerdict,
} from "./reachVerdicts";
import { chatNeedsOf, GROUP_ENDED, GROUP_READ_ONLY, type ChatDirectory } from "./automationChat";
import type { GroupMessagesSkipped } from "./groupMessagesNotice";
import {
  AUTOMATION_CHAIN_STOPPED,
  automationFailureKey,
  CHAIN_STOPPED_PRESS,
  type AutomationFailure,
  type ReportedRun,
} from "./automationFailedNotice";

// The Collection automation executor for one open workspace (ADR 0008, ADR
// 0012). It keeps an index of every Collection's automations.yaml, keeps the
// engine's subscriptions in step with the automations that can run, and
// drains the engine's claims in the "collection:" namespace one at a time.
// The engine's `automation.claimed` event is only the wake-up: the claim
// table is the transport, so a claim made while this computer was away
// drains on the next open.
//
// Every claim the drain takes ends one of three ways: it runs and settles,
// it settles failed, or it waits and goes back to the engine at the end of
// the drain. Until the engine takes the settle or the release, the executor
// keeps the claim and tries again on its next drain, without running it.
//
// A dataset Collection's claims come from its dataset host's ledger instead,
// where the host claims each commit it makes (ADR 0011), and each press of
// one of its buttons (pressDataset). The drain takes
// engine claims first, then dataset claims, one at a time, and treats both
// the same way; a dataset run's steps go through the dataset's approved
// operations (datasetAutomationRun.ts). The executor uses the dataset host
// only while something else has it open, as the Collections list does, or
// when a person asks about a dataset's automations. A workspace whose
// datasets nobody uses never opens it for automations.

export const AUTOMATIONS_FILE_NAME = "automations.yaml";
const DATASET_FILE_NAME = "dataset.json";
const WATCHED_FILES = new Set([AUTOMATIONS_FILE_NAME, "collection.yaml", DATASET_FILE_NAME]);
const KEPT_ANOTHER_WAY_UNDO = "This run ran before this Collection changed how it keeps its records, so dohc cannot undo it.";
const MOVED_SINCE_PRESSED = "This Collection moved after the button was pressed. Press it again.";
const DATASET_NOT_APPROVED = "This Collection's rules are not approved yet, so its automations cannot run.";
// A dataset's records are kept on one computer, and its schedules and Group messages run only there.
const DATASET_TRIGGERS_ELSEWHERE = "Schedules and Group messages run on another computer, but this Collection's records are kept on this one. Choose this computer under Schedules run on in Settings.";

const AUTOMATION_RUN_DEADLINE_MS = 5 * 60_000;
// A workspace that synced before, or that has no record of whether it did,
// runs schedules and Group triggers only once it syncs and its relay names
// a computer.
const SCHEDULES_NEED_SYNC = "Turn on sync to run this workspace's schedules.";
const GROUP_MESSAGES_NEED_SYNC = "Turn on sync so Group messages start this automation.";
// After the deadline, a run's writes stop at their next check. A write
// still running after this long is not settled at all, so nothing can land
// after the claim settles; the engine's recovery requeues the claim.
const DEADLINE_GRACE_MS = 30_000;
// Runs that time out this many times in a row switch their automation off.
export const TIMEOUTS_BEFORE_SWITCH_OFF = 3;
// A claim the evaluator had no room for runs again after this long, if
// nothing else wakes the drain first.
const BUSY_RETRY_MS = 2_000;
// Run history expires at open, then at most this often, after a run settles.
const HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
// The most claims either ledger's prune keeps past their time, as the engine allows.
const MAX_HISTORY_KEEP = 10_000;
// The engine bounds a settle error at 4096 bytes; stay well under it.
const MAX_SETTLE_ERROR_CHARS = 1000;

/** The engine RPC subset the executor drives. VersionedLiveAdapter satisfies it. */
type AutomationPressResult = Awaited<ReturnType<VersionedLiveAdapter["pressAutomation"]>>;

type AutomationClaimScheduleResult = Awaited<ReturnType<VersionedLiveAdapter["claimAutomationSchedule"]>>;
type AutomationScheduleMark = Awaited<ReturnType<VersionedLiveAdapter["listAutomationScheduleMarks"]>>["marks"][number];

export interface CollectionAutomationEngine extends CollectionAutomationReads {
  listCollections(): Promise<CollectionListResult>;
  /** Records under a path. */
  subscribeAutomation(input: RecordSubscription): Promise<unknown>;
  unsubscribeAutomation(input: { automationId: string; path: string }): Promise<unknown>;
  /**
   * Stops every Group subscription here from claiming, and answers what the
   * next host needs with the generation whose handover this computer last took.
   */
  releaseAutomationGroups(): Promise<AutomationReleaseGroupsResult>;
  /** Sets every Group subscription this computer watches, taking a new host generation's handover. */
  watchAutomationGroups(input: AutomationWatchGroupsParams): Promise<{ needsHandover: boolean }>;
  claimNextAutomation(input: { automationIdPrefix: string }): Promise<AutomationClaim | null>;
  readonly workspaceId: string;
  /** The workspace's versions and their files, to list every automation a take over cannot vouch for. */
  listVersions(input: { workspaceId: string }): Promise<ReadonlyArray<{ id: string }>>;
  listTextFileMetadata(input: { workspaceId: string; versionId: string }): Promise<ReadonlyArray<{ path: string; objectId: string }>>;
  readTextFile(input: { workspaceId: string; versionId: string; path: string }): Promise<{ text: string | null; contentKind: string; objectId: string } | null>;
  settleAutomationClaim(input: { claimId: string; state: "done" | "failed"; error?: string }): Promise<unknown>;
  retryAutomationClaim(input: { claimId: string }): Promise<AutomationClaimSummary>;
  /** One page of an automation's run history, newest first, and the `before` of the next page, or null after the oldest. */
  listAutomationClaims(input: { automationId: string; before?: string; limit?: number }): Promise<{ claims: AutomationClaimSummary[]; next: string | null }>;
  /** One claim in run history, by its id or by its automation and trigger key, or null. */
  getAutomationClaim(input: { claimId: string } | { automationId: string; key: string }): Promise<{ claim: AutomationClaimSummary | null }>;
  /** Expires one batch of done claims past 30 days, except those `keep` names. */
  pruneAutomationHistory(input: { keep: string[] }): Promise<{ pruned: number; more: boolean }>;
  /** Each automation's newest failed claim, the one its failure notice offers to try again. */
  listAutomationFailures(): Promise<{ failures: Array<Omit<AutomationFailure, "datasetInstance" | "neverStarted">> }>;
  /** When Group messages last started nothing here for a reason a person can act on, by this computer's clock. */
  readAutomationGroupSkips(): Promise<{ aheadAtMs: number | null; lateAtMs: number | null }>;
  /** Hands a running claim this computer holds back to pending, without counting an attempt. */
  releaseAutomationClaim(input: { claimId: string }): Promise<unknown>;
  /** Claims a schedule's due times and moves its mark, in one transaction. */
  claimAutomationSchedule(input: {
    automationId: string;
    scheduleHash: string;
    run: number[];
    throughMs: number;
  }): Promise<AutomationClaimScheduleResult>;
  listAutomationScheduleMarks(): Promise<{ marks: AutomationScheduleMark[] }>;
  /** Claims Run now from a skipped-run notice; a repeat answers the same claim. */
  runAutomationNow(input: { automationId: string; noticeId: string }): Promise<unknown>;
  pressAutomation(input: { pressId: string; automationId: string; recordId: string; pressedBy: string; by: AutomationPressActor }): Promise<AutomationPressResult>;
}

/** An enabled schedule this executor can run. */
export interface ScheduledAutomation {
  automationId: string;
  /** Where its Collection is now. */
  collectionPath: string;
  name: string;
  trigger: AutomationScheduleTrigger;
  scheduleHash: string;
  /**
   * When this executor saw the schedule added or switched on, or null when
   * it was already on as the executor opened. Nothing before it runs.
   */
  enabledSince: number | null;
}


/** Whether the Collection an automation id names is one whose automations a take over could not list. */
function inUnprovenFolder(folders: ReadonlySet<string>, automationId: string): boolean {
  if (folders.size === 0) return false;
  const folder = parseCollectionAutomationId(automationId)?.collectionId;
  return folder === undefined || folders.has(folder);
}

/** The dataset host's automation surface, as the executor drives it. LocalDatasetHost's `automations` satisfies it. */
export interface DatasetAutomationHost extends DatasetRunHost, DatasetUndoHost {
  /** Each approved, unarchived dataset's rules. */
  datasets(): { definitions: DatasetDefinition[]; failures: Array<{ datasetId: string; error: unknown }> };
  subscribe(datasetId: string, subscription: DatasetAutomationSubscription): void;
  unsubscribe(datasetId: string, automationId: string): void;
  subscriptions(): Array<DatasetAutomationSubscription & { datasetId: string }>;
  next(): DatasetAutomationClaim | null;
  settle(started: DatasetAutomationClaim, outcome: SettleInput): unknown;
  /** Hands a started claim back to pending, without counting its attempt. */
  release(started: DatasetAutomationClaim): void;
  retry(claimId: string): unknown;
  /** One page of an automation's run history, newest first, and the `before` of the next page, or null after the oldest. */
  claims(automationId: string, page?: { before?: string; limit?: number }): { claims: DatasetAutomationClaim[]; next: string | null };
  /** Expires one batch of done claims past 30 days, except those `keep` names. */
  pruneHistory(keep: readonly string[]): { pruned: number; more: boolean };
  /** One of an automation's claims however old, or null. */
  claim(automationId: string, claimId: string): DatasetAutomationClaim | null;
  failures(): DatasetAutomationFailure[];
  /** Throws why the host cannot take a press of this button, as `press` would. */
  assertPressable(datasetId: string, button: Pick<DatasetPressInput, "tableId" | "fieldId">): void;
  /** Records a press by `pressedBy`, made by `by`, and answers the claim that runs it. */
  press(datasetId: string, input: Omit<DatasetPressInput, "presser"> & { pressedBy: string; by: AutomationPressActor }): DatasetPressed;
  /** A press the ledger remembers, with its claim, or null. */
  pressed(pressId: string): DatasetRememberedPress | null;
}

export interface CollectionAutomationsOptions {
  /** Engine adapter runner; resolves null when the engine is unavailable. */
  withEngine<T>(work: (engine: CollectionAutomationEngine) => Promise<T>): Promise<T | null>;
  withRecordWrites: CollectionAutomationRunDependencies["withRecordWrites"];
  /** A workspace text file, or null when it does not exist. */
  readText(relativePath: string): Promise<
    { text: string; truncated: false; contentHash: string } | { text: string; truncated: true; contentHash: null } | null
  >;
  /**
   * Replaces a text file whose content still hashes to `expectedContentHash`,
   * as the automation `automationId`, so History does not name a person.
   */
  writeText(relativePath: string, text: string, expectedContentHash: string, automationId: string): Promise<{ status: "written" | "conflict" }>;
  pathExists(relativePath: string): Promise<boolean>;
  /**
   * Resolves once the engine has recorded every file change the watcher
   * delivered so far, so it lists a Collection that just appeared or moved.
   */
  recorded?(): Promise<void>;
  /** Who can edit what in this workspace, listed again when stale, for a run's reach check. */
  roster(): Promise<ReachRoster>;
  /** What the roster says now, without listing again, for showing reach. */
  cachedRoster(): Promise<ReachRoster>;
  evaluator: AutomationFormulaEvaluator;
  store: AutomationRunStore;
  /** Where automations post and send direct messages, and the writer they use. */
  chat: AutomationChatDependencies;
  /**
   * The automation host generation this computer runs at, from its last
   * host read: 0 for a workspace that never synced, null when it is not the
   * host. Only the host watches Groups, so the engine claims each Group
   * message on one computer (ADR 0012).
   */
  groupHost(): Promise<number | null>;
  /**
   * The relay's last release or take over, read at this host generation,
   * with the handover when a release left it for this computer. Throws when
   * the relay does not answer.
   */
  groupRelayRecord(generation: number): Promise<AutomationGroupRelayRecord>;
  /**
   * The relay's last release or take over, read at this host generation,
   * with the reach verdicts when a release left them for this computer.
   * Throws when the relay does not answer.
   */
  reachRelayRecord(generation: number): Promise<ReachRelayRecord>;
  /**
   * An enabled Group trigger asks the host module, as a schedule does, to
   * record this computer as the host when the relay names none. Resolves at
   * once when a host is named, or after the read that learns one.
   */
  requestHost(): Promise<unknown>;
  /** Tells the owner, once a day, that Group messages started no automations here, and why. */
  groupMessagesSkipped(reason: GroupMessagesSkipped, atMs: number): Promise<void>;
  /** A message's whole body, for a claim that carried it truncated. */
  readMessageBody: CollectionAutomationRunDependencies["readMessageBody"];
  /** Sends one notice from this workspace. */
  postNotice: CollectionAutomationRunDependencies["postNotice"];
  /** A claim settled failed, or a retry cleared one: run history re-reads. */
  onRunsChanged(): void;
  /**
   * Sends the notice for an automation's newest failure on this computer,
   * and takes back the notice for its failure `replaces` counted, if any.
   * Rejects when the notice was not kept, so the failure is reported again.
   */
  reportFailure(report: AutomationFailureReport): Promise<void>;
  /** Takes back the notice for a run that is no longer its automation's newest failure, as after Try again. */
  withdrawFailure(failure: ReportedRun): Promise<void>;
  /**
   * An automation this computer last saved as on is off in the file it
   * read now, even when the change came while dohc was closed. The switch
   * the executor makes itself after repeated timeouts is not one.
   */
  onSwitchedOff(switched: AutomationSwitchedOff): void;
  /**
   * A step started or stopped waiting for a current editor, or a share
   * stopped a step or someone dismissed its notice: the reach notices re-read.
   */
  onHoldsChanged(): void;
  /**
   * The automations dohc read from the workspace changed, or a step's reach
   * verdict did: the ⚡ field marks re-read.
   */
  onAutomationsChanged(): void;
  /** The index was read again, so the schedules this executor can run may differ. */
  onSchedulesChanged?(): void;
  /** Whether some computer can run the workspace's schedules and Group triggers. True unless set. */
  hostCanRun?(): Promise<boolean>;
  /** The Groups in this computer's chat store, by name and slug; null when it cannot be read. None unless set. */
  groupList?(): Promise<Array<{ name: string; slug: string }> | null>;
  /** The name a formula's `person` shows for the person who pressed a button. */
  personName(userId: string): string;
  /** Whether this computer's person may run a failed press again: the person who pressed it, or the workspace's owner. */
  mayRetryPress(pressedBy: string | null): Promise<boolean>;
  /** The engine took a press's settle. */
  onPressSettled(event: PressSettled): void;
  /** A press's run went back to wait. */
  onPressWaiting(event: { claimId: string; reason: PressWaitReason }): void;
  /**
   * Holds off a handover while a relayed press's run writes: null when this
   * computer no longer runs the workspace's automations or a handover began.
   * Unset, relayed presses run with no hold.
   */
  holdForHost?(): (() => void) | null;
  onError(context: string, error: unknown): void;
  /**
   * This workspace's dataset host, while it is open; resolves null when it is
   * not. With `open`, opens it first: only for what a person asked for.
   */
  withDatasetHost<T>(work: (host: DatasetAutomationHost) => T | Promise<T>, open: boolean): Promise<T | null>;
  nowMs?: () => number;
  /** Starts a run's deadline, which calls `abort`; returns its cancel. Five minutes unless a test sets it. */
  deadline?: (abort: () => void) => () => void;
}

type IndexedFile = { file: AutomationsFileParseResult; contentHash: string | null };
/**
 * A dataset Collection's approved rules, whether dohc generated its
 * operations, and its data grants, as the reach check reads them.
 */
type IndexedDataset = { approved: import("@dohc/security-contract/dataset").DatasetRevision | null; definition: DatasetDefinition; generated: boolean | null; grants: ReachDatasetGrants };

/** One step's reach as the ⚡ panel shows it. */
export type CollectionAutomationStepReach =
  | { verdict: "allowed" }
  | { verdict: "stopped"; reason: string }
  // Allowed now, but stopped before under the same definition: it waits
  // for a current editor to confirm it with `seq`. `target` is the
  // destination the step reaches.
  | {
    verdict: "held"; step: string; stoppedFor: string | null; seq: number; target: string; action: CollectionAutomationHold["action"];
    fileUnread: CollectionAutomationHold["fileUnread"];
  };

/** One automation as the ⚡ panel reads it. */
export type CollectionAutomationSummary =
  | {
      valid: true;
      /** The engine automation id, for its runs and Try again. */
      automationId: string;
      automation: Automation;
      definitionHash: string;
      /**
       * Why dohc does not run it now, or null: a trigger or step dohc cannot
       * run yet, or a field its Collection does not have.
       */
      cannotRun: string | null;
      /** Each step's reach in step order, or why dohc cannot check who can edit yet. */
      reach: { kind: "checked"; steps: CollectionAutomationStepReach[] } | { kind: "waiting"; reason: string };
      /** Its newest run on this computer, or null when it has not run here. */
      lastRun: { state: AutomationClaimSummary["state"]; atMs: number } | null;
    }
  | { valid: false; id: string | null; name: string | null; diagnostics: AutomationDiagnostic[] };

// `you` is this computer's person as a step names them, in a workspace
// proved never shared (automationReach.ts). The builder writes it for
// "You", and never shows it.
export type CollectionAutomationsFile =
  | { status: "missing"; you?: string }
  | { status: "unreadable"; diagnostic: AutomationDiagnostic }
  | {
      status: "read";
      contentHash: string | null;
      automations: CollectionAutomationSummary[];
      /**
       * In a dataset, the tables where Undo would keep the records an Add
       * record step adds, because no approved delete every editor can use
       * qualifies (datasetUndoDeletes), for the builder to say beside the
       * step. Empty in a document Collection, or while dohc cannot check who
       * can edit.
       */
      addsStay: string[];
      you?: string;
    };

/** One field that switched-on automations set, with their names in file order. */
export interface CollectionFieldMark {
  field: string;
  automations: string[];
}

/** A Collection a step can reach, or why it cannot, for the builder. */
export interface CollectionAutomationTarget {
  path: string;
  name: string;
  /** Why a step cannot change its records, or null. */
  stopped: string | null;
  /** Why a Find cannot read its records, or null. */
  findStopped: string | null;
}

/**
 * A Group an automation can name: its name, its slug, and `ref`, the text a
 * step writes to name it, which is its name unless that names another Group
 * or none; with why its messages cannot start the automation, or it cannot
 * take the automation's post, each null when it can.
 */
export interface CollectionAutomationGroup {
  name: string;
  slug: string;
  ref: string;
  readStopped: string | null;
  postStopped: string | null;
}

/**
 * A person a Direct message or a Notify step can name, as the owner already
 * sees them: `userId` is what the step writes, `name` how the owner knows
 * them, and `you` marks this computer's person. Each reason is why a step
 * cannot reach them, or null when it can.
 */
export interface CollectionAutomationPerson {
  userId: string;
  name: string;
  you: boolean;
  dmStopped: string | null;
  noticeStopped: string | null;
}

/** The people a builder can offer, or why dohc cannot list them yet. */
export type CollectionAutomationPeople =
  | { status: "listed"; people: CollectionAutomationPerson[] }
  | { status: "waiting"; reason: string };

/** Why a direct message cannot go to this computer's own person. */
export const DIRECT_MESSAGE_TO_YOU = "A direct message goes to another person. To reach yourself, use Notify.";

/**
 * A step whose reach changed, for its notice: one that waits for a current
 * editor to allow it, or one a narrower share stopped.
 */
export interface CollectionAutomationHold {
  automationId: string;
  automationName: string;
  definitionHash: string;
  /** The step's identity (reachStepId). */
  step: string;
  seq: number;
  /** The name of the Collection the automation belongs to, and the one the step reaches. */
  collection: string;
  /** Where the automation's Collection is now. */
  collectionPath: string;
  /** A Collection, a Group, or a direct message. */
  target: string;
  action: "change" | "find" | "post" | "notify" | "wake" | "read";
  /** A person a formula named, or a Collection a code step named: the hold is theirs, not the step's. */
  recipient?: string;
  /** The editor whose reach stopped the step. */
  stoppedFor: string | null;
  /**
   * It waits because the Collection's automations file does not read in
   * some version, so dohc holds every step there it has not seen.
   */
  fileUnread: boolean;
}

/**
 * Steps waiting for a current editor, steps a narrower share stopped, and
 * whether dohc could read which steps were allowed.
 */
export interface CollectionAutomationHolds {
  holds: CollectionAutomationHold[];
  stops: CollectionAutomationStop[];
  /** reach.json cannot be read, so every automation waits until someone resets the holds. */
  unreadable: boolean;
  /** Collections whose automations wait because one version does not say which Collection their file belongs to. */
  unprovenPaths: string[];
}

export const UNREADABLE_REACH =
  "dohc cannot read which automation steps were allowed, so every automation waits. Reset holds in Notices to allow each step again.";
/** A switched-on step a share stopped: the same facts as a hold. */
export type CollectionAutomationStop = CollectionAutomationHold;

/** A step a share would stop, for the share dialog to say before the share is made. */
export interface CollectionAutomationShareStop {
  automationId: string;
  automationName: string;
  /** The full path of the Collection the automation belongs to. */
  collectionPath: string;
  /** The destination the step reaches, by the name the UI shows. */
  target: string;
  action: CollectionAutomationHold["action"];
}

/**
 * The change a run is for: its kind, the record it runs on, who made the
 * change, and the change's chain depth. `kind` is null for a dataset claim
 * that failed before it could carry its change.
 */
export interface CollectionAutomationTrigger {
  kind: AutomationClaimSummary["change"]["kind"] | null;
  /** Null for a message or a schedule. */
  recordId: string | null;
  /** Null when the change did not say. */
  by: "human" | "agent" | "automation" | null;
  /**
   * The person the owner shared with, or the Edit share link, the relay
   * accepted the change from. A link names its grant, never a person.
   */
  sharedAuthor: SharedChangeAuthor | null;
  depth: number;
}

export interface CollectionAutomationRun {
  claimId: string;
  state: AutomationClaimSummary["state"];
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  trigger: CollectionAutomationTrigger;
  /** What the run's effects did on this computer, oldest first. */
  writes: RunWrite[];
  /** The run began under another version of the automation. */
  definitionChanged: boolean;
  /** It failed before it started, as a chain stop or a change too large to claim, so Try again cannot run it. */
  neverStarted: boolean;
  /** The chain depth cap stopped it before it started. */
  chainStopped: boolean;
  /** A person undid what it changed. */
  undone: boolean;
}

/** One run with what each of its steps changed, for reading a single run. */
export interface CollectionAutomationRunDetail extends Omit<CollectionAutomationRun, "writes"> {
  /**
   * What each step changed on this computer, in step order. Steps are
   * numbered from 1 in the order the file lists them, counting the steps
   * inside If and Otherwise. A step that changed nothing is not listed.
   */
  steps: Array<{ step: number; writes: RunWrite[] }>;
  /**
   * The step whose change did not land when the run failed. Null when it
   * did not fail, or failed before it saved its plan, such as on a formula.
   */
  failedStep: number | null;
  /**
   * Try again runs a failed run from the first step, and asks the caller to
   * confirm that, because the automation changed or its progress is gone.
   * Otherwise Try again resumes at `failedStep`.
   */
  startsOver: boolean;
}

/**
 * How a press's run ended. `skipped` did nothing: its record, or its
 * automation, was gone or off. `ended` is a run that ended before dohc
 * could say which: a press sent again after its run record was trimmed.
 */
export interface PressSettled {
  claimId: string;
  outcome: "done" | "skipped" | "failed" | "ended";
  error: string | null;
}

/** What a press answers: its run's claim, how the run ended if it has, or busy. */
export type CollectionAutomationPress =
  | { busy: true }
  | { busy: false; claimId: string; settled: Omit<PressSettled, "claimId"> | null };

/** A press this computer took, so the same press sent again finds its claim whatever changed since. */
interface RememberedPress {
  field: string;
  recordId: string;
  pressedBy: string;
  automationId: string;
}
// Presses remembered for a resend after a lost reply; the oldest go first.
const REMEMBERED_PRESSES = 500;

/** One Button field in a Collection, and what its button shows. */
export interface CollectionAutomationButton {
  field: string;
  state: AutomationButtonState;
}

/** An automation's newest failure on this computer, for its notice. */
export interface AutomationFailureReport {
  failure: AutomationFailure;
  /** The automation's name in its automations.yaml, when dohc can read it. */
  name: string | null;
  /** Where its Collection is now, or null when this computer no longer has it. */
  collectionPath: string | null;
  /** The person whose Group message, button press or edit started the run, when its claim names one. */
  startedBy: string | null;
  /** The earlier failure whose notice this one replaces, or null when none is up. */
  replaces: ReportedRun | null;
}

/** An automation someone switched off, as the file this computer read says. */
export interface AutomationSwitchedOff {
  collectionPath: string;
  /** The automation's id in its automations.yaml. */
  id: string;
  /** The engine automation id. */
  automationId: string;
  name: string;
}

export type CollectionAutomationRetry =
  // `press` is true for a button's run, whose window hears how it settles.
  | { status: "queued"; press: boolean }
  // The automation changed since the run began. Running it again starts
  // from the beginning and can repeat what it already did, so the person
  // must choose that. `repeatsMessages` says the confirmation must also say
  // that messages it sent may be sent again.
  | { status: "definition-changed"; repeatsMessages: boolean }
  | { status: "refused"; reason: string };

export type CollectionAutomationUndo =
  | ({ status: "undone" } & CollectionAutomationUndone)
  // The run added dataset records: the person reads what Undo deletes and
  // keeps, and chooses a delete where several qualify, before it runs.
  | { status: "confirm"; preview: DatasetUndoPreview }
  | { status: "refused"; reason: string };

/**
 * A dataset Undo's checks passed, with the runs it planned and their
 * reverses and deletes to save before it sends any; or what it answers instead.
 */
type DatasetUndoChecked =
  | { collection: ReachCollection; covers: StoredRun[]; calls: DatasetUndoCall[] }
  | Extract<CollectionAutomationUndo, { status: "confirm" | "refused" }>;

const BUSY_CLAIM_REFUSAL = "dohc is already changing this run. Try again in a moment.";

/**
 * What runs did, oldest first, with the ordinal of the step that did it. A
 * record a run created before it stopped has no write yet, so it is listed
 * from `created`, once.
 */
function stepWritesOf(runs: readonly StoredRun[]): Array<{ ordinal: number; write: RunWrite }> {
  const writes = runs.flatMap((run) => run.applied.flatMap((effect) => effect.writes.map((write) => ({ ordinal: effect.ordinal, write }))));
  const listed = new Set(writes.flatMap(({ write }) => (write.kind === "created" ? [write.recordId] : [])));
  for (const run of runs) {
    for (const created of run.created) {
      if (listed.has(created.recordId)) continue;
      listed.add(created.recordId);
      writes.push({ ordinal: created.ordinal, write: { kind: "created", recordId: created.recordId, path: created.path } });
    }
  }
  return writes;
}

/** What each step of runs did, in step order, numbered from 1. */
function stepsOf(runs: readonly StoredRun[]): CollectionAutomationRunDetail["steps"] {
  const steps = new Map<number, RunWrite[]>();
  for (const { ordinal, write } of stepWritesOf(runs)) steps.set(ordinal, [...(steps.get(ordinal) ?? []), write]);
  return [...steps].sort(([left], [right]) => left - right).map(([ordinal, writes]) => ({ step: ordinal + 1, writes }));
}

/**
 * Who made a dataset change, when the ledger says. A press is its agent's
 * when one pressed for the person, and otherwise the person's; any other
 * change the owner or an app made could be a person's or an agent's.
 */
function datasetActorKind(claim: DatasetAutomationClaim): CollectionAutomationTrigger["by"] {
  if (claim.actor.kind === "automation" || claim.actor.kind === "agent") return claim.actor.kind;
  if (claim.fact?.kind !== "button") return null;
  return "agent" in claim.actor && claim.actor.agent !== undefined ? "agent" : "human";
}

/**
 * How Try again treats a claim's saved runs: it refuses, or it runs the
 * claim again, from the first step when `startsOver`, which the caller must
 * confirm.
 */
function tryAgainOf(
  runs: ClaimRuns,
): { refused: string } | (Extract<ClaimRuns, { unreadable: false }> & { startsOver: boolean }) {
  if (runs.unreadable) return { refused: UNREADABLE_RUN_ERROR };
  // An undone run's keys and record ids are spent, so it cannot run again.
  if (runs.undo) return { refused: UNDONE_RUN_ERROR };
  return { ...runs, startsOver: runs.current === null && runs.changedSince !== null };
}

/** The step a run failed at, or whose change it had not landed when it stopped, numbered from 1. */
function stoppedAtStep(run: StoredRun | undefined): number | null {
  if (run === undefined) return null;
  // The step a run failed at, until a later attempt lands all of it.
  if (run.outcome?.state === "failed") {
    const failed = run.outcome.step;
    const through = run.steps.findIndex((step) => step.ordinal === failed);
    const planned = run.steps.slice(0, through + 1).reduce((count, step) => count + step.effects.length, 0);
    if (through < 0 || planned > run.applied.length) return failed + 1;
  }
  const ordinals = run.steps.flatMap((step) => step.effects.map(() => step.ordinal));
  const next = ordinals[run.applied.length];
  return next === undefined ? null : next + 1;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = message.trim().slice(0, MAX_SETTLE_ERROR_CHARS);
  return bounded.length > 0 ? bounded : "The automation failed.";
}

function startDeadline(abort: () => void): () => void {
  const timer = setTimeout(abort, AUTOMATION_RUN_DEADLINE_MS);
  return () => clearTimeout(timer);
}

/** Whether any step wakes its person's agent. */
function wakesAgent(automation: Automation): boolean {
  const walk = (steps: Automation["do"]): boolean => steps.some((step) =>
    step.kind === "wake-agent" || (step.kind === "if" && (walk(step.do) || walk(step.otherwise))));
  return walk(automation.do);
}

// A relayed press's engine id: the relay's id and the definition hash the
// presser saw. The relay mints UUIDs, so the first "." ends it.
/** Names the folder a relayed press's relay allowed, as its engine press id carries it. */
function placeHash(collectionPath: string): string {
  return createHash("sha256").update(collectionPath).digest("hex").slice(0, 16);
}

function relayedPressId(pressId: string, hash: string, collectionPath: string): string {
  return `${pressId}.${hash}.${placeHash(collectionPath)}`;
}

/**
 * What a relayed press's claim is bound to: the definition its presser saw,
 * and the folder the relay allowed it in. Null for any other claim.
 */
function boundPress(claim: Pick<AutomationClaim, "trigger" | "change">): { definition: string; place: string } | null {
  if (claim.change.kind !== "button" || !("key" in claim.trigger)) return null;
  const match = /^press:[^.]+\.([0-9a-f]{16})\.([0-9a-f]{16})$/u.exec(claim.trigger.key);
  return match ? { definition: match[1]!, place: match[2]! } : null;
}

function collectionNamed(path: string): ReachCollection {
  return { path, name: path.split("/").at(-1) ?? path };
}

/** Why dohc cannot check who can edit `collection`, from a roster it does not know. */
function rosterProblem(roster: Extract<ReachRoster, { kind: "unknown" }>, collection: ReachCollection): string {
  const [waiting] = checkAutomationReach(roster, { id: "", collection, codeFiles: [], steps: [{ kind: "change-records", collection }] });
  return waiting !== undefined && !waiting.allowed ? waiting.reason : `dohc could not check who can edit ${collection.name}.`;
}

type OwnedAutomation = { automationId: string; collectionPath: string; automation: Automation };

type SettleInput = { state: "done" } | { state: "failed"; error: string };
/** A claim this computer holds, from the ledger that made it. */
type HeldClaim = { source: "engine"; claim: AutomationClaim } | { source: "dataset"; claim: DatasetAutomationClaim };

/**
 * How a held claim runs: through the dataset its Collection keeps, or as a
 * document Collection's engine claim. An engine claim in a dataset
 * Collection is a due time or a Group message, and runs through the dataset.
 */
function runnerOf(held: HeldClaim, datasetId: string | undefined): { kind: "dataset"; held: DatasetRunClaim } | { kind: "document"; claim: AutomationClaim } {
  if (held.source === "dataset") return { kind: "dataset", held };
  return datasetId === undefined ? { kind: "document", claim: held.claim } : { kind: "dataset", held: { ...held, datasetId } };
}

/** Whether a held claim runs a button's press, whose window hears how it runs. */
function isPress(held: HeldClaim): boolean {
  return held.source === "engine" ? held.claim.change.kind === "button" : held.claim.fact?.kind === "button";
}

/** A dataset record's primary key from the JSON a window sends, or null when it is not one. */
function datasetRecordIdOf(text: string): DatasetRecordId | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? value : null;
}
/**
 * Whether a claim failed before it started, as both ledgers insert it: failed
 * and never served. Of those, a chain stop records its own reason.
 */
function stopOf(claim: Pick<AutomationClaimSummary, "state" | "attempts"> & { error?: string | null }): Pick<CollectionAutomationRun, "neverStarted" | "chainStopped"> {
  const neverStarted = claim.state === "failed" && claim.attempts === 0;
  return { neverStarted, chainStopped: neverStarted && claim.error === AUTOMATION_CHAIN_STOPPED };
}

/** One automation's run history and the failure its notice offers, whichever ledger holds its claims. */
type HistoryClaim = Pick<AutomationClaimSummary, "claimId" | "state" | "createdAtMs" | "updatedAtMs" | "attempts"> & {
  error?: string | null;
  trigger: CollectionAutomationTrigger;
};
/** One page of an automation's claims, newest first, and the `before` of the next page, or null after the oldest. */
type ClaimPage = { claims: HistoryClaim[]; next: string | null };
/**
 * A claim found in the ledger that holds it: the dataset ledger for a
 * record change or a press on a dataset, the engine otherwise. `pressedBy`
 * is the person a press ran for, or undefined for anything but a press.
 */
type LedgerClaim = {
  ledger: "dataset" | "engine";
  state: AutomationClaimSummary["state"];
  pressedBy: string | null | undefined;
  /** It failed before it started, so no Try again can run it. */
  neverStarted: boolean;
  history: HistoryClaim;
};

/** Claims from both ledgers, merged newest first, in the order both page them. */
function newestFirst(claims: HistoryClaim[]): HistoryClaim[] {
  return claims.sort((left, right) =>
    right.createdAtMs - left.createdAtMs || (left.claimId < right.claimId ? 1 : left.claimId > right.claimId ? -1 : 0));
}

function engineHistoryClaim(claim: AutomationClaimSummary): HistoryClaim {
  return {
    ...claim,
    trigger: { kind: claim.change.kind, recordId: claim.recordId, by: claim.change.actorKind, sharedAuthor: claim.change.sharedAuthor, depth: claim.depth },
  };
}

function datasetHistoryClaim(claim: DatasetAutomationClaim): HistoryClaim {
  return {
    ...claim,
    trigger: {
      kind: claim.fact?.kind ?? null,
      recordId: claim.fact === null ? null : String(claim.fact.recordId),
      by: datasetActorKind(claim),
      sharedAuthor: null,
      depth: claim.depth,
    },
  };
}
/** What a released claim waits for; later drains pass it by until that clears. */
export type PressWaitReason = "roster" | "held" | "busy" | "session";
/** A press's reasons, or a dataset whose host has not opened, which a press never waits for. */
type WaitReason = PressWaitReason | "dataset";
/**
 * What the engine must hear about a claim this computer holds: hand it back
 * to wait, or settle it. `settled` runs once the engine takes the settle.
 */
type ClaimAction =
  | { kind: "release"; waitsFor?: WaitReason }
  | { kind: "settle"; input: SettleInput; outcome: Exclude<PressSettled["outcome"], "ended">; settled: () => Promise<void> };
// One page of run history shows this many runs.
const RUN_PAGE = 20;
// The most claims one page of either ledger holds.
const CLAIM_PAGE_LIMIT = 100;

export class CollectionAutomations {
  /**
   * Every document Collection the engine lists, and those a watcher batch
   * added, with its Collection id: the object id of its collection.yaml.
   */
  private collections = new Map<string, string>();
  /** Collections that hold an automations.yaml, with what it says. */
  private readonly files = new Map<string, IndexedFile>();
  /**
   * The field names of each Collection with a collection.yaml that an
   * automation names, or the reason dohc cannot read the schema.
   * A Collection without one, such as a dataset, is not
   * listed.
   */
  private readonly schemaFields = new Map<string, ReadonlySet<string> | string>();
  /** Dataset Collections, with their approved rules. Only when dohc can run dataset automations. */
  private readonly datasets = new Map<string, IndexedDataset>();
  private targetRevision = 0;
  private readonly inventories = new WeakMap<Automation, {
    revision: number; chat: ChatDirectory | null; source: string; result: AutomationInventory | Error;
  }>();
  /** The engine subscriptions this computer holds, by engine automation id. */
  private subscribed = new Map<string, StoredSubscription>();
  /** Each step's last reach verdict. */
  private readonly verdicts = new Map<string, StoredReachVerdict>();
  /** Orders verdicts and confirmations; it only rises. */
  private verdictSeq = 0;
  /** The generation of the relay's last release or take over whose verdicts this computer took. */
  private hostRecord = 0;
  /**
   * Definitions, by definitionKey, whose steps with no verdict yet are held:
   * this computer became the host without the last host's verdicts.
   */
  private unproven = new Set<string>();
  /**
   * Also hold any step with no verdict yet: this computer could not prove
   * its verdicts and may not have seen every definition. The first pull
   * that reaches the relay after that ends it, once every definition it
   * then has is in `unproven`.
   */
  private unprovenAll = false;
  /**
   * The Collections whose automations file, in some version, did not read
   * or held an entry that did not when this computer listed the unproven
   * definitions. Fixing that file can bring back a definition the last host
   * stopped, with the same hash, so a step there with no verdict yet is
   * held. A Collection leaves once its file reads in every version and its
   * definitions joined `unproven`.
   */
  private unprovenFolders = new Set<string>();
  /** Paths whose Collection identity was unreadable in at least one version. */
  private unprovenPaths = new Set<string>();
  /** Rises at each take over's mark, so a listing ends only the mark it was queued for. */
  private markEpoch = 0;
  /** The host generation this computer took the last host's verdicts at, saved. */
  private reachTakenAt: number | null = null;
  /**
   * The host generation whose record the relay did not answer for, so this
   * computer has not taken the last host's verdicts: the next sync pull asks
   * again, and nothing runs meanwhile.
   */
  private reachPending: number | null = null;
  /** `reachPending` as the last save wrote it, which a host claim can rely on. */
  private savedPending: number | null = null;
  /**
   * Claims this computer holds whose release or settle the engine has not
   * taken yet. Each drain tries these first, and never runs them again.
   */
  private readonly owed = new Map<string, { held: HeldClaim; action: ClaimAction }>();
  /**
   * Claims handed back to wait, with what they wait for. A drain that the
   * engine serves one of them passes it by until that reason clears, so a
   * waiting claim costs nothing but its release.
   */
  private readonly waitingFor = new Map<string, WaitReason>();
  /** The held and stopped steps the notices last showed. */
  private publishedHolds: string[] = [];
  /**
   * The saved verdicts could not be read. No step can be treated as seen
   * before, so every run waits until someone resets the holds.
   */
  private verdictsUnreadable = false;
  /**
   * Claims a Try again or an Undo is changing. The drain leaves them, and
   * neither starts while the other runs.
   */
  private readonly changing = new Set<string>();
  /** Presses this computer took, by press id, oldest first. */
  private readonly presses = new Map<string, RememberedPress>();
  /** The switched-on automations this computer last saved, per Collection; undefined until read. */
  private enabledSaved: Map<string, string[]> | null | undefined;
  /** The pass sending failure notices, and whether another must follow it. */
  private reportingFailures: Promise<void> | null = null;
  private reportFailuresAgain = false;
  /** Consecutive timed-out runs per automation, saved so a restart keeps them. */
  private timeouts = new Map<string, number>();
  /**
   * The Groups and direct messages automations post to, as the last roster
   * found them. Reach reads it; a run reads its own.
   */
  private chat: ChatDirectory | null = null;
  /** The Groups Group-message automations watch, found for their subscriptions. */
  private groups: ChatDirectory | null = null;
  /** The Groups `groups` was read for: those saved automations name. */
  private groupsLookedUp: ReadonlySet<string> = new Set();
  /** Whether this computer was the automation host at the last reconcile, so it watches Groups. */
  private groupTriggersHere = false;
  /**
   * The engine may hold other Group subscriptions than `subscribed` lists:
   * at open, or after a watch or release whose answer was lost. Until one
   * lands, a reconcile sends the whole set again.
   */
  private groupSubscriptionsUncertain = true;
  /** The host generation the engine last took Group subscriptions at, from this executor. */
  private watchedGeneration: number | null = null;
  /** The relay did not answer for a new generation's Group handover: the next sync pull asks again. */
  private handoverUnread = false;
  // The newest Group message skip of each kind the owner was told about.
  private readonly groupSkipsTold: Record<GroupMessagesSkipped, number> = { ahead: 0, late: 0 };
  /** Serializes index loads and subscription reconciles. */
  private chain: Promise<void> = Promise.resolve();
  /** Serializes reach verdict updates. */
  private verdictChain: Promise<unknown> = Promise.resolve();
  private opened: Promise<void> | null = null;
  private state: "closed" | "open" | "paused" | "disposed" = "closed";
  /** Rises at each pause and close, so an open that began before one stops. */
  private generation = 0;
  /** Whether the workspace had opened its automations when the engine restart began. */
  private reopenAfterRestart = false;
  private draining: Promise<void> | null = null;
  private redrain = false;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  // When run history last expired, or null before the first time.
  private historyPrunedAtMs: number | null = null;
  // The expiry pass in progress; a later pass starts after it.
  private historyPruning: Promise<void> = Promise.resolve();
  // The expiry batch in progress. An Undo waits for it before it reads its claim.
  private historyBatch: Promise<unknown> = Promise.resolve();
  // The next expiry while the workspace stays open.
  private historyTimer: ReturnType<typeof setTimeout> | null = null;
  private runAbort = new AbortController();
  private readonly nowMs: () => number;
  // Claims waiting for their dataset, with its id.
  private readonly datasetWaits = new Map<string, string>();
  // The dataset store failed to open, so a due time or message whose
  // Collection is not indexed may be a dataset's, and waits for it.
  private datasetStoreFailed = false;
  // Approved datasets whose folder's dataset.json does not name them now.
  // Their due times and messages wait for the descriptor to be fixed.
  private unplacedDatasets = new Set<string>();
  // Each enabled schedule's switch-on time, as the index last read them.
  private enabledSince = new Map<string, number | null>();

  constructor(private readonly options: CollectionAutomationsOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  /**
   * Reads every Collection's automations, subscribes the ones that can run,
   * and drains once: claims made while the workspace was closed have no
   * other wake-up. Safe to call on every workspace activity open.
   */
  open(): Promise<void> {
    if (this.state === "disposed" || this.state === "paused") return Promise.resolve();
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.opened ??= this.enqueue(async () => {
      const subscriptions = await this.options.store.readSubscriptions();
      const { verdicts, hostRecord, unproven, unprovenAll, unprovenFolders, unprovenPaths, pending, taken, unreadable } =
        await this.options.store.readReachVerdicts();
      const timeouts = await this.options.store.readTimeouts();
      if (!current()) return;
      this.subscribed = new Map(subscriptions.map((entry) => [entry.automationId, entry]));
      this.groupSubscriptionsUncertain = true;
      this.timeouts = timeouts;
      this.verdictsUnreadable = unreadable;
      this.hostRecord = hostRecord;
      this.unproven = new Set(unproven);
      this.unprovenAll = unprovenAll;
      this.unprovenFolders = new Set(unprovenFolders);
      this.unprovenPaths = new Set(unprovenPaths);
      this.reachTakenAt = taken;
      this.reachPending = pending;
      this.savedPending = pending;
      for (const verdict of verdicts) {
        this.verdicts.set(reachVerdictKey(verdict.automationId, verdict.definitionHash, verdict.step, verdict.recipient?.id), verdict);
        this.verdictSeq = Math.max(this.verdictSeq, verdict.seq);
      }
      await this.loadIndex();
      if (!current()) return;
      await this.noteSwitches();
      this.noteEnabledSchedules(true);
      this.state = "open";
      this.waitingFor.clear();
      this.datasetWaits.clear();
      await this.reconcile(true);
      this.publishHolds();
    }).then(
      () => {
        if (!current()) return;
        this.options.onAutomationsChanged();
        this.rosterChanged();
        this.options.onSchedulesChanged?.();
        // Failures recorded while the workspace was closed, or before a crash.
        this.reportFailures();
        void this.pruneHistory();
      },
      (error: unknown) => {
        // A later open tries again.
        if (current()) this.opened = null;
        this.options.onError("open Collection automations", error);
      },
    );
    return this.opened;
  }

  /** The settled watcher batch: re-read the Collections whose automations or schema changed. */
  handleWatcherEvents(events: readonly WatcherEvent[]): void {
    this.rereadFoldersOf(events.flatMap((event) => [event.path, event.fromPath]));
  }

  /**
   * Files a relay pull wrote. A pull writes the owner's files itself, and
   * need not leave a watcher batch, so a collaborator's direct change to a
   * Collection's automations or schema (ADR 0013) is read from here.
   */
  handlePulledPaths(paths: readonly string[]): void {
    this.rereadFoldersOf(paths);
  }

  private rereadFoldersOf(paths: readonly (string | undefined)[]): void {
    const folders = new Set<string>();
    for (const path of paths) {
      if (path === undefined || !WATCHED_FILES.has(posix.basename(path))) continue;
      const folder = posix.dirname(path);
      if (folder !== ".") folders.add(folder);
    }
    if (folders.size === 0 || this.opened === null) return;
    this.targetRevision += 1;
    void this.enqueue(async () => {
      let datasets: Promise<Map<string, IndexedDataset> | null> | undefined;
      let listed: Promise<Map<string, string>> | undefined;
      for (const folder of folders) {
        this.schemaFields.delete(folder);
        const collectionId = await this.options.pathExists(`${folder}/collection.yaml`)
          ? (await (listed ??= this.listedCollections())).get(folder)
          : undefined;
        if (collectionId !== undefined) {
          this.datasets.delete(folder);
          this.collections.set(folder, collectionId);
          await this.readFile(folder);
          continue;
        }
        this.collections.delete(folder);
        // A new automations.yaml beside a dataset is a reason to open its host.
        const open = await this.options.pathExists(`${folder}/${DATASET_FILE_NAME}`) &&
          await this.options.pathExists(`${folder}/${AUTOMATIONS_FILE_NAME}`);
        const knownDatasets = await (datasets ??= this.datasetFolders(open));
        if (knownDatasets === null) continue;
        const dataset = knownDatasets.get(folder);
        if (dataset === undefined) {
          this.datasets.delete(folder);
          this.files.delete(folder);
          if (this.unprovenPaths.has(folder)) await this.proveFolder(folder, undefined);
        } else {
          this.datasets.set(folder, dataset);
          await this.readFile(folder);
        }
      }
      await this.readNamedSchemas();
      this.targetRevision += 1;
      await this.noteSwitches();
      this.noteEnabledSchedules(false);
      await this.reconcile(false);
      // An edited or removed automation's held steps leave the notices.
      this.publishHolds();
      // A descriptor fixed or removed: its waiting due times and messages look again.
      this.wakeDatasetWaits();
    })
      // A new or changed step gets its verdict now, while the people who
      // could have written it can still edit the Collection.
      .then(() => {
        this.options.onAutomationsChanged();
        this.rosterChanged();
        this.options.onSchedulesChanged?.();
      })
      .catch((error: unknown) => this.options.onError("reload Collection automations", error));
  }

  /**
   * The dataset host opened, or a dataset's approved rules changed: an
   * approval, a migration, a restore, or an archive. Sources change before
   * approval, so the watcher alone cannot tell. Re-index every dataset
   * Collection, reconcile, and drain what the host's ledger holds.
   */
  datasetsChanged(): void {
    if (this.opened === null) return;
    void this.enqueue(() => this.indexDatasets(false))
      .then(() => {
        this.rosterChanged();
        this.notifyClaimed();
        this.failuresChanged();
        // An approval can make a dataset's panel and field marks answer at last.
        this.options.onAutomationsChanged();
      })
      .catch((error: unknown) => this.options.onError("reload dataset automations", error));
  }

  private async indexDatasets(open: boolean): Promise<void> {
    this.targetRevision += 1;
    const folders = await this.datasetFolders(open);
    if (folders === null) return;
    for (const path of this.datasets.keys()) {
      if (folders.has(path)) continue;
      this.datasets.delete(path);
      this.files.delete(path);
    }
    for (const [path, dataset] of folders) {
      if (this.collections.has(path)) continue;
      this.datasets.set(path, dataset);
      await this.readFile(path);
    }
    this.targetRevision += 1;
    await this.noteSwitches();
    // A schedule found now counts from now, as one switched on does.
    this.noteEnabledSchedules(false);
    await this.reconcile(false);
    this.publishHolds();
    this.options.onSchedulesChanged?.();
    this.wakeDatasetWaits();
  }

  /**
   * Wakes each due time or message whose dataset no longer keeps it
   * waiting, so the next drain looks again: it runs once its dataset is
   * indexed, and settles once the store opened without it.
   */
  private wakeDatasetWaits(): void {
    const woken = [...this.datasetWaits].filter(([, datasetId]) => !this.waitsForDataset(datasetId));
    for (const [claimId] of woken) {
      this.datasetWaits.delete(claimId);
      this.waitingFor.delete(claimId);
    }
    if (woken.length > 0) this.notifyClaimed();
  }

  /**
   * Whether a due time or message of this dataset waits: the store failed
   * to open, or the approved dataset's folder does not name it now.
   */
  private waitsForDataset(datasetId: string): boolean {
    return this.collectionPathOf(datasetId) === null && (this.datasetStoreFailed || this.unplacedDatasets.has(datasetId));
  }

  /** The wake-up: a claim event landed, a retry queued a claim, or a reconcile registered work. */
  notifyClaimed(): void {
    if (this.state !== "open") return;
    if (this.draining) {
      this.redrain = true;
      return;
    }
    this.draining = this.drain().finally(() => {
      this.draining = null;
      if (this.redrain && this.state === "open") {
        this.redrain = false;
        this.notifyClaimed();
      }
    });
  }

  /**
   * The roster or the automations changed: record every step's verdict,
   * then drain, so claims waiting to check who can edit run now.
   */
  rosterChanged(): void {
    if (this.state !== "open") return;
    void this.options.cachedRoster()
      .then((roster) => roster.kind === "unknown" ? undefined : this.recordVerdicts(roster))
      .catch((error: unknown) => this.options.onError("check who can edit automations", error))
      .finally(() => this.clearWaits("roster", "held"));
  }

  /** The signed-in session changed: runs that waited to post under one try again. */
  sessionChanged(): void {
    if (this.state !== "open") return;
    this.clearWaits("session");
  }

  /**
   * Whether this computer is the automation host may have changed: watch
   * or release Groups to match.
   */
  hostChanged(): void {
    if (this.opened === null) return;
    void this.enqueue(() => this.reconcile(false))
      .catch((error: unknown) => this.options.onError("update Group subscriptions for the automation host", error));
  }

  /** A sync pull reached the relay: a Group handover it could not read before is asked for again. */
  relayAnswered(): void {
    if (this.handoverUnread || this.reachPending !== null) this.hostChanged();
    // Every definition the relay had is on this computer now: hold those,
    // in every version, whether or not this computer indexed them or they
    // can run yet, and judge the ones current editors write from here as
    // usual. A Collection whose file did not read keeps holding what it
    // has not seen until it does. A definition no version names leaves the
    // list. The listing ends only the mark it was asked for: a take over
    // meanwhile sets a new one.
    if (this.unprovenAll && this.opened !== null) {
      const epoch = this.markEpoch;
      void this.enqueue(async () => {
        if (!this.unprovenAll || this.markEpoch !== epoch) return;
        const found = await this.automationFiles();
        // Without the listing, the mark stays until the next pull.
        if (found === null) return;
        await this.updateVerdicts(() => {
          if (!this.unprovenAll || this.markEpoch !== epoch) return;
          const { named, unread } = this.addListedDefinitions(found);
          // A path whose file names its Collection in every version is identified again.
          const unidentified = new Set(found.flatMap((file) => file.collectionId === null ? [file.folder] : []));
          for (const file of found) if (!unidentified.has(file.folder)) this.unprovenPaths.delete(file.folder);
          for (const key of this.unproven) {
            const [automationId] = JSON.parse(key) as [string, string];
            if (!named.has(automationId) && !inUnprovenFolder(unread, automationId)) this.unproven.delete(key);
          }
          this.unprovenFolders = unread;
          this.unprovenAll = false;
        }, true);
      }).catch((error: unknown) => this.options.onError("hold the automations this computer could not vouch for", error));
    }
  }

  /**
   * This computer's verdicts, for the release that hands the workspace's
   * automations to the next host. Null when it could not read them, never
   * took the last host's, or they are too large to carry: the next host then
   * holds what it cannot prove.
   */
  async reachHandover(): Promise<ReachHandover | null> {
    await this.verdictChain;
    if (this.verdictsUnreadable || this.reachPending !== null) return null;
    const handover: ReachHandover = {
      version: 2, verdicts: [...this.verdicts.values()], unproven: [...this.unproven], unprovenAll: this.unprovenAll,
      unprovenFolders: [...this.unprovenFolders], unprovenPaths: [...this.unprovenPaths],
    };
    return Buffer.byteLength(JSON.stringify(handover)) <= AUTOMATION_HOST_REACH_MAX_BYTES ? handover : null;
  }

  /**
   * Before this computer hands the workspace's automations to another one:
   * the engine stops every Group subscription in the workspace, including
   * one this computer lost track of, so no message it stores after that
   * claims here, and answers the Group handover for the release. Resolves
   * null when the executor has not opened, the owner called the handover
   * off, or the engine did not answer; the handover then waits and tries
   * again. A message claimed here before still runs here, as a claimed
   * schedule does.
   */
  async releaseGroupSubscriptions(stillHandingOver: () => boolean): Promise<AutomationReleaseGroupsResult | null> {
    await this.opened;
    if (this.state !== "open") return null;
    let released = null as AutomationReleaseGroupsResult | null;
    try {
      await this.enqueue(async () => {
        // Called off while this waited in line: keep them.
        if (stillHandingOver()) released = await this.releaseEngineGroups();
      });
    } catch (error) {
      this.options.onError("stop Group subscriptions before a handover", error);
      return null;
    }
    return released;
  }

  /** The engine is about to restart: stop runs. The engine recovers the claims they held. */
  pauseForEngineRestart(): void {
    if (this.state === "disposed" || this.state === "paused") return;
    this.generation += 1;
    this.reopenAfterRestart = this.opened !== null;
    this.stopRuns();
    // Claims owed a release or settle keep it: the replacement engine still
    // holds them as running, and the first drain after it answers sends it.
    this.state = "paused";
  }

  /** The replacement engine answers: subscribe again and drain, if the workspace had opened. */
  resumeAfterEngineRestart(): void {
    if (this.state !== "paused") return;
    this.state = "closed";
    this.opened = null;
    if (this.reopenAfterRestart) void this.open();
  }

  /**
   * Workspace close. Claims this computer holds go back to the engine, and
   * subscriptions stay, so changes made at the next open claim at once.
   */
  async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    this.generation += 1;
    this.stopRuns();
    // Disposed before the drain ends, so it starts no further drain that
    // could take a claim again after it is handed back.
    this.state = "disposed";
    await Promise.allSettled([this.draining]);
    await this.payOwed(false);
    await Promise.allSettled([this.chain, this.verdictChain]);
  }

  /**
   * The end of a background run: claims this computer holds go back, and a
   * later open starts again. Its schedules are unknown until then.
   */
  async close(): Promise<void> {
    if (this.state !== "open") return;
    this.generation += 1;
    // Closed before the drain ends and claims are handed back, as dispose
    // does, so a settle paid below starts no drain and no expiry pass.
    this.state = "closed";
    this.stopRuns();
    await Promise.allSettled([this.draining]);
    await this.payOwed(false);
    this.opened = null;
    await Promise.allSettled([this.chain, this.verdictChain]);
  }

  /** Resolves once no drain is running or queued. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** The enabled schedules this executor can run, or null until it has opened. */
  schedules(): ScheduledAutomation[] | null {
    if (this.state !== "open") return null;
    const schedules: ScheduledAutomation[] = [];
    for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
      if (automation.enabled && automation.when.kind === "schedule") {
        schedules.push({
          automationId,
          collectionPath,
          name: automation.name,
          trigger: automation.when,
          scheduleHash: scheduleHash(automation.when),
          enabledSince: this.enabledSince.get(automationId) ?? null,
        });
      }
    }
    return schedules;
  }

  /**
   * Run now from a skipped-run notice, after this computer's dismissal was
   * the notice's first. False while the engine is not answering.
   */
  async runNow(automationId: string, noticeId: string): Promise<boolean> {
    await this.markHostClaims();
    const ran = await this.withLiveEngine((engine) => engine.runAutomationNow({ automationId, noticeId }));
    if (ran === null) return false;
    this.notifyClaimed();
    return true;
  }

  /**
   * Why Run now cannot run an automation on this computer, or null. A
   * dataset's schedule runs only where its records are kept, so a computer
   * without them refuses before it wins the notice's dismissal.
   */
  async runNowRefusal(automationId: string): Promise<string | null> {
    await this.ready();
    if (parseCollectionAutomationId(automationId) === null || this.locate(automationId) !== null) return null;
    // A dataset whose host has not opened yet may still be kept here.
    await this.enqueue(() => this.indexDatasets(true));
    if (this.locate(automationId) !== null) return null;
    return "This computer does not keep this automation's Collection. Run it from the computer that keeps it.";
  }

  /**
   * Where an automation's Collection is now, found by its Collection id,
   * or null when this computer has not indexed that Collection.
   */
  locate(automationId: string): { collectionPath: string; id: string } | null {
    const parsed = parseCollectionAutomationId(automationId);
    const collectionPath = parsed === null ? null : this.collectionPathOf(parsed.collectionId);
    return parsed === null || collectionPath === null ? null : { collectionPath, id: parsed.id };
  }

  /** The folder of the indexed Collection with this Collection id, or null. */
  private collectionPathOf(collectionId: string): string | null {
    for (const [path, id] of this.collections) if (id === collectionId) return path;
    for (const [path, dataset] of this.datasets) if (dataset.definition.datasetId === collectionId) return path;
    return null;
  }

  /** An indexed Collection's id: its collection.yaml's object id, or its dataset id. */
  private collectionIdOf(collectionPath: string): string | null {
    return this.collections.get(collectionPath) ?? this.datasets.get(collectionPath)?.definition.datasetId ?? null;
  }

  /** The engine id of the automation `id` in an indexed Collection. */
  private automationIdIn(collectionPath: string, id: string): string {
    const collectionId = this.collectionIdOf(collectionPath);
    if (collectionId === null) throw new Error(`dohc has not indexed the Collection ${collectionPath}.`);
    return collectionAutomationId(collectionId, id);
  }

  /** Every schedule's mark in this workspace, or null while the engine is not answering. */
  async scheduleMarks(): Promise<AutomationScheduleMark[] | null> {
    const listed = await this.withLiveEngine((engine) => engine.listAutomationScheduleMarks());
    return listed?.marks ?? null;
  }

  /**
   * Claims a schedule's due times and moves its mark. Returns the mark after
   * the step, or null while the engine is not answering. New claims drain
   * at once, because the engine's announcement can drop.
   */
  async claimSchedule(input: {
    automationId: string;
    scheduleHash: string;
    run: number[];
    throughMs: number;
  }): Promise<AutomationScheduleMark | null> {
    await this.markHostClaims();
    const claimed = await this.withLiveEngine((engine) => engine.claimAutomationSchedule(input));
    if (claimed === null) return null;
    if (claimed.claims.length > 0) this.notifyClaimed();
    return claimed.mark;
  }

  /** Whether any Collection has an automation dohc can run, switched on or not. */
  hasAutomations(): boolean {
    return this.everyAutomation().length > 0;
  }

  /** The automations in one Collection's file, with why each can or cannot run. */
  async automationsIn(collectionPath: string): Promise<CollectionAutomationsFile> {
    await this.indexCollection(collectionPath);
    // A dataset whose rules are not approved is not in the index.
    const unapproved = await this.maybeDataset(collectionPath);
    const indexed = unapproved ? await this.parsedFile(collectionPath) : this.files.get(collectionPath);
    const collectionId = unapproved ? await this.describedDatasetId(collectionPath) : this.collectionIdOf(collectionPath);
    const roster = await this.options.cachedRoster();
    const you = roster.kind === "owner" && roster.localPersonId !== undefined ? { you: roster.localPersonId } : {};
    if (!indexed || collectionId === null) return { status: "missing", ...you };
    if (indexed.file.status === "unreadable") return { status: "unreadable", diagnostic: indexed.file.diagnostic };
    const { unsupported, reasonOf } = await this.reasonsIn(collectionPath, unapproved);
    const collection = collectionNamed(collectionPath);
    const runnable = indexed.file.entries.flatMap((entry) => entry.status === "valid" && unsupported(entry.automation) === null
      ? [{ automationId: collectionAutomationId(collectionId, entry.automation.id), collectionPath, automation: entry.automation }]
      : []);
    // Without a roster, the reason is the same for every step: dohc cannot
    // check who can edit the Collection yet.
    const [waiting] = roster.kind === "unknown"
      ? checkAutomationReach(roster, { id: "", collection, codeFiles: [], steps: [{ kind: "change-records", collection }] })
      : [];
    if (roster.kind !== "unknown") await this.recordVerdicts(roster, runnable);
    // One engine read per automation, together; the newest claim comes first.
    const lastRuns = new Map(await Promise.all(indexed.file.entries.flatMap((entry) => entry.status === "valid"
      ? [collectionAutomationId(collectionId, entry.automation.id)]
      : []).map(async (automationId) => {
      const [newest] = (await this.claimPage(automationId, { limit: 1 }))?.claims ?? [];
      return [automationId, newest ? { state: newest.state, atMs: newest.updatedAtMs } : null] as const;
    })));
    const automations = indexed.file.entries.map((entry): CollectionAutomationSummary => {
      if (entry.status === "invalid") {
        return { valid: false, id: entry.id, name: entry.name, diagnostics: entry.diagnostics };
      }
      const { automation } = entry;
      const automationId = collectionAutomationId(collectionId, automation.id);
      const hash = definitionHash(automation);
      const cannotRun = reasonOf(automation);
      const summary = {
        valid: true as const, automationId, automation, definitionHash: hash, cannotRun,
        lastRun: lastRuns.get(automationId) ?? null,
      };
      if (this.verdictsUnreadable) return { ...summary, reach: { kind: "waiting", reason: UNREADABLE_REACH } };
      if (roster.kind === "unknown") {
        return { ...summary, reach: { kind: "waiting", reason: waiting && !waiting.allowed ? waiting.reason : "" } };
      }
      const reachSteps = this.reachSteps(collectionPath, automation);
      const steps = checkAutomationReach(roster, {
        id: automation.id, collection, codeFiles: codeFilesOf(automation, collectionPath), steps: reachSteps,
      }).map((reach, step): CollectionAutomationStepReach => {
        if (!reach.allowed) return { verdict: "stopped", reason: reach.reason };
        const stored = this.verdicts.get(reachVerdictKey(automationId, hash, reachStepId(reachSteps[step]!, step)));
        const reached = reachSteps[step] ? reachDestination(reachSteps[step]) : null;
        return stored?.verdict === "held" && reached
          ? {
              verdict: "held", step: stored.step, stoppedFor: stored.stoppedFor, seq: stored.seq,
              fileUnread: this.fileUnread(stored), ...reached,
            }
          : { verdict: "allowed" };
      });
      return { ...summary, reach: { kind: "checked", steps } };
    });
    const dataset = unapproved || roster.kind === "unknown" ? undefined : this.datasets.get(collectionPath);
    const addsStay = dataset === undefined ? [] : dataset.definition.tables
      .filter((table) => datasetUndoDeletes(roster, collection, dataset.definition, table.tableId, dataset.grants).length === 0)
      .map((table) => table.name);
    return { status: "read", contentHash: indexed.contentHash, automations, addsStay, ...you };
  }

  /**
   * A claim failed, a retry cleared one, or the engine inserted one failed:
   * run history re-reads, and each new failure sends its notice.
   */
  failuresChanged(): void {
    this.options.onRunsChanged();
    this.reportFailures();
  }

  /** One pass at a time; a call during a pass runs one more after it. */
  private reportFailures(): void {
    if (this.state === "disposed") return;
    if (this.reportingFailures) {
      this.reportFailuresAgain = true;
      return;
    }
    this.reportingFailures = (async () => {
      do {
        this.reportFailuresAgain = false;
        await this.reportFailuresOnce();
      } while (this.reportFailuresAgain && this.state !== "disposed");
    })()
      .catch((error: unknown) => this.options.onError("send automation failure notices", error))
      .finally(() => {
        this.reportingFailures = null;
      });
  }

  /**
   * Sends a notice for each automation whose newest failure here counts
   * past the one this computer last sent, and takes back a notice whose run
   * is no longer its automation's newest failure, as after Try again. What
   * was sent is saved after each notice, so a crash sends a notice again,
   * which the notice list takes once, and never skips one.
   */
  private async reportFailuresOnce(): Promise<void> {
    const engine = await this.withLiveEngine((live) => live.listAutomationFailures());
    if (engine === null) return;
    // Null while the dataset host is closed: its failures are unknown, not gone.
    const dataset = await this.datasetFailures();
    const failures: AutomationFailure[] = [
      // The engine inserts a claim failed only for a chain stop.
      ...engine.failures.map((failure) => ({ ...failure, neverStarted: failure.chainStopped, datasetInstance: null })),
      ...(dataset ?? []),
    ];
    const reported = new Map((await this.options.store.readReportedFailures()).map((entry) => [automationFailureKey(entry), entry]));
    // A pass that outlived its executor saves nothing: the next executor
    // reports from what was saved, and its notices are the same ones.
    const commit = async (key: string, entry: ReportedFailure): Promise<boolean> => {
      if (this.state === "disposed") return false;
      reported.set(key, entry);
      await this.options.store.saveReportedFailures([...reported.values()]);
      return true;
    };
    for (const failure of failures) {
      if (this.state === "disposed") return;
      const key = automationFailureKey(failure);
      const last = reported.get(key);
      // The same run at the same count was sent. Another run, as the older
      // failed run a retry of the newest leaves, is news.
      if (last !== undefined && last.claimId === failure.claimId && failure.generation <= last.generation) continue;
      try {
        await this.options.reportFailure({
          failure,
          name: this.nameOf(failure.automationId),
          collectionPath: this.locate(failure.automationId)?.collectionPath ?? null,
          startedBy: await this.startedByOf(failure),
          replaces: last?.open ? last : null,
        });
      } catch (error) {
        // Unsaved, so the next pass sends it again.
        this.options.onError(`send the notice for a failure of "${failure.automationId}"`, error);
        continue;
      }
      const { automationId, datasetInstance, claimId, generation } = failure;
      if (!(await commit(key, { automationId, datasetInstance, claimId, generation, open: true }))) return;
    }
    const newest = new Map(failures.map((failure) => [automationFailureKey(failure), failure.claimId]));
    for (const [key, entry] of reported) {
      if (this.state === "disposed") return;
      if (!entry.open || newest.get(key) === entry.claimId || (entry.datasetInstance !== null && dataset === null)) continue;
      await this.options.withdrawFailure(entry);
      if (!(await commit(key, { ...entry, open: false }))) return;
    }
  }

  /**
   * The person a failed claim ran for, from the ledger that holds it: whose
   * Group message or button press started it, or the named person whose
   * edit did. Null when the claim names no person, as an app's or an agent's
   * change does.
   */
  private async startedByOf(failure: AutomationFailure): Promise<string | null> {
    if (failure.datasetInstance !== null) {
      const claim = await this.withLiveHost((ledger) => ledger.claim(failure.automationId, failure.claimId));
      if (!claim) return null;
      return claim.actor.kind === "named" ? claim.actor.userId : datasetPresser(claim);
    }
    const found = await this.withLiveEngine((engine) => engine.getAutomationClaim({ claimId: failure.claimId }));
    const claim = found?.claim;
    if (claim?.automationId !== failure.automationId) return null;
    return claim.change.kind === "message" || claim.change.kind === "button" ? claim.change.onBehalfOf : null;
  }

  /**
   * Each dataset automation's newest failure, for the failure notices, while
   * the dataset host is open, or null. It does not open the host.
   */
  private async datasetFailures(): Promise<DatasetAutomationFailure[] | null> {
    try {
      return await this.withLiveHost((host) => host.failures());
    } catch (error) {
      this.options.onError("list dataset automation failures", error);
      return null;
    }
  }

  /**
   * The automations the ⚡ panel saves, with each dataset step pinned to the
   * approved operation it prefers (datasetAutomationPlan.ts). Only a step
   * the file does not already hold is pinned: one a person built or changed
   * in the builder. A switch, a rename, a copy, or an edit elsewhere leaves
   * what each existing step does alone.
   */
  async pinOperations(collectionPath: string, automations: readonly Automation[], saved: readonly Automation[]): Promise<Automation[]> {
    await this.ready();
    await this.openDataset(collectionPath);
    const dataset = this.datasets.get(collectionPath);
    if (dataset === undefined || dataset.generated === null) return [...automations];
    const held = new Set(saved.flatMap((automation) => stepsInOrder(automation).map(({ step }) => JSON.stringify(step))));
    return automations.map((automation) => pinDatasetOperations(automation, { ...dataset, generated: dataset.generated === true }, (step) => held.has(JSON.stringify(step))));
  }

  /**
   * Why dohc would not run `automation` if the ⚡ panel saved it in this
   * Collection now, or null: an action the dataset lacks, a Find it cannot
   * read, or trigger.record on a schedule. It pins steps as a save does,
   * from what dohc has already indexed, and asks which computer runs
   * schedules as the list does; it writes and wakes nothing. A Collection
   * dohc has not indexed yet has no status to give.
   */
  async draftCannotRun(collectionPath: string, automation: Automation): Promise<string | null> {
    await this.ready();
    const dataset = this.datasets.get(collectionPath);
    if (dataset === undefined && !this.collections.has(collectionPath)) return null;
    const indexed = this.files.get(collectionPath);
    const held = new Set(indexed?.file.status === "read"
      ? indexed.file.entries.flatMap((entry) => (entry.status === "valid" ? stepsInOrder(entry.automation).map(({ step }) => JSON.stringify(step)) : []))
      : []);
    const pinned = dataset === undefined ? automation : pinDatasetOperations(automation, { ...dataset, generated: dataset.generated === true }, (step) => held.has(JSON.stringify(step)));
    return (await this.reasonsIn(collectionPath, false)).reasonOf(pinned);
  }

  /**
   * The code files a draft's steps name that this Collection's folder
   * lacks, as each step names them. It looks for each file and reads none.
   */
  async missingCodeFiles(collectionPath: string, automation: Automation): Promise<string[]> {
    // Only a path the file contract takes, so a lookup stays inside the Collection's folder by name.
    const files = [...new Set(stepsInOrder(automation).flatMap(({ step }) =>
      (step.kind === "run-file" && isNormalizedRelativePath(step.file) ? [step.file] : [])))];
    const found = await Promise.all(files.map((file) => this.options.pathExists(`${collectionPath}/${file}`)));
    return files.filter((_, index) => !found[index]);
  }

  /**
   * Why dohc does not run an automation in this Collection now, as the ⚡
   * panel lists it and a draft's check says it: `unsupported`, what keeps
   * it from running anywhere, and `reasonOf`, that or what keeps it from
   * starting here, such as a Group it cannot read or schedules without
   * sync. `unapproved` is a dataset whose rules are not approved.
   */
  private async reasonsIn(collectionPath: string, unapproved: boolean) {
    const unsupported = (automation: Automation) =>
      unapproved ? DATASET_NOT_APPROVED : this.cannotRun(collectionPath, automation);
    const hostCanRun = (await this.options.hostCanRun?.()) ?? true;
    // Only the computer that keeps a dataset can run its schedules and Group messages.
    const keptHereOnly = hostCanRun && this.datasets.has(collectionPath) && (await this.options.groupHost()) === null;
    const reasonOf = (automation: Automation): string | null => unsupported(automation) ?? this.groupProblem(automation) ?? (hostCanRun
      ? (keptHereOnly && (automation.when.kind === "schedule" || automation.when.kind === "group-message") ? DATASET_TRIGGERS_ELSEWHERE : null)
      : automation.when.kind === "schedule" ? SCHEDULES_NEED_SYNC
      : automation.when.kind === "group-message" ? GROUP_MESSAGES_NEED_SYNC
      : null);
    return { unsupported, reasonOf };
  }

  /** Every step that waits for a current editor, and whether dohc could read what was allowed. */
  holdState(): CollectionAutomationHolds {
    return { holds: this.holds(), stops: this.stops(), unreadable: this.verdictsUnreadable, unprovenPaths: this.heldUnprovenPaths() };
  }

  /** The unidentified paths where a Collection is indexed, so its automations wait. A stray file holds nothing. */
  private heldUnprovenPaths(): string[] {
    return [...this.unprovenPaths].filter((path) => this.collectionIdOf(path) !== null);
  }

  /**
   * Starts the verdicts again after they could not be read: every step the
   * roster allows now is held for Allow, and every other is stopped.
   */
  async resetHolds(): Promise<"reset" | "roster-unknown"> {
    await this.ready();
    const roster = await this.options.cachedRoster();
    if (roster.kind === "unknown") return "roster-unknown";
    await this.loadChat(roster);
    await this.updateVerdicts(() => {
      this.verdicts.clear();
      for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
        const collection = collectionNamed(collectionPath);
        const hash = definitionHash(automation);
        const steps = this.reachSteps(collectionPath, automation);
        checkAutomationReach(roster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collectionPath), steps }).forEach((reach, index) => {
          const step = reachStepId(steps[index]!, index);
          // A former link's evidence is part of what Allow answers now.
          const accounted = reach.allowed ? (reach.formerStops ?? []).map((stop) => stop.evidence).sort() : [];
          this.verdicts.set(reachVerdictKey(automationId, hash, step), {
            automationId, definitionHash: hash, step,
            ...(reach.allowed ? { verdict: "held", stoppedFor: null } : { verdict: "stopped", stoppedFor: reach.person ?? null }),
            ...(accounted.length === 0 ? {} : { accountedLinks: accounted }),
            seq: ++this.verdictSeq,
          });
        });
      }
      this.verdictsUnreadable = false;
    }, true);
    this.clearWaits("held");
    return "reset";
  }

  /** Where the verdicts are saved, for a person to look at. */
  reachVerdictsPath(): Promise<string> {
    return this.options.store.reachVerdictsPath();
  }

  /**
   * The Groups in this computer's chat store that a Group trigger or a Post
   * in a Group step in this Collection can name, with the reach check's
   * reason, as a saved automation would get it, when one cannot be read or
   * posted in. Names and reasons only; it reads no message.
   */
  async groupsFor(collectionPath: string): Promise<CollectionAutomationGroup[]> {
    await this.ready();
    const listed = [...((await this.options.groupList?.()) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    if (listed.length === 0) return [];
    const roster = await this.options.cachedRoster();
    const chat = roster.kind === "unknown"
      ? null
      : await this.options.chat.directory(roster, { groups: new Set(listed.map(({ slug }) => slug)), people: new Set() });
    const collection = collectionNamed(collectionPath);
    return listed.map(({ name, slug }) => {
      // The name, where it names this Group as a run reads it; otherwise the slug, which always does.
      const bySlug = chat?.group(slug);
      const byName = chat?.group(name);
      const ref = bySlug && byName && !("problem" in bySlug) && !("problem" in byName) && byName.channelId === bySlug.channelId ? name : slug;
      const found = chat?.group(ref);
      // A Group the directory cannot resolve can neither start nor take a message.
      if (found && "problem" in found) return { name, slug, ref, readStopped: found.problem, postStopped: found.problem };
      const group = found ? { channelWireId: found.wireId, name: found.name } : { channelWireId: null, name };
      const [read, post] = checkAutomationReach(roster, {
        id: "", collection, codeFiles: [], steps: [{ kind: "read-group", group }, { kind: "post", group }],
      });
      return {
        name,
        slug,
        ref,
        readStopped: found?.ended ? GROUP_ENDED : read && !read.allowed ? read.reason : null,
        postStopped: found?.readOnly ? GROUP_READ_ONLY : post && !post.allowed ? post.reason : null,
      };
    });
  }

  /**
   * The people a Direct message or a Notify step in this Collection can
   * name: this computer's person, and each person who accepted one of the
   * workspace's shares, as the roster already lists them. Each comes with
   * the reason a saved step's run would give when it cannot reach them.
   * Names and reasons only; it reads no message.
   */
  async peopleFor(collectionPath: string): Promise<CollectionAutomationPeople> {
    await this.ready();
    const roster = await this.options.cachedRoster();
    const collection = collectionNamed(collectionPath);
    if (roster.kind === "unknown") {
      // Every step waits for the same reason without a roster.
      const [waiting] = checkAutomationReach(roster, { id: "", collection, codeFiles: [], steps: [{ kind: "notify", person: { userId: "", name: "" } }] });
      return { status: "waiting", reason: waiting && !waiting.allowed ? waiting.reason : "" };
    }
    // A shared view lists nobody: its automations run on the owner's computer.
    if (roster.kind !== "owner") return { status: "listed", people: [] };
    // The owner by this computer's own id in a workspace proved never shared, as steps name them there; else by their account.
    const you = roster.localPersonId ?? roster.ownerUserId;
    const others = roster.grants.flatMap((grant) =>
      grant.recipientUserId !== null && grant.recipientUserId !== roster.ownerUserId && grant.recipientUserId !== you ? [grant.recipientUserId] : []);
    const ids = [...new Set([...(you === null ? [] : [you]), ...others])];
    if (ids.length === 0) return { status: "listed", people: [] };
    // The directory reads a direct message only for the people it is asked about.
    const chat = await this.options.chat.directory(roster, { groups: new Set(), people: new Set(ids) });
    // A run waits for the engine then too.
    if (chat === null) return { status: "waiting", reason: "dohc could not read this workspace's chats." };
    const people = ids.map((userId) => {
      const name = chat.person(userId);
      const dm = userId === you ? { problem: DIRECT_MESSAGE_TO_YOU } : chat.directMessage(userId);
      const recipient = chat.noticeRecipient(userId);
      const [sent, noticed] = checkAutomationReach(roster, {
        id: "", collection, codeFiles: [], steps: [directMessageReach(chat, userId), { kind: "notify", person: { userId, name } }],
      });
      return {
        userId,
        name,
        you: userId === you,
        dmStopped: "problem" in dm ? dm.problem : sent && !sent.allowed ? sent.reason : null,
        noticeStopped: "problem" in recipient ? recipient.problem : noticed && !noticed.allowed ? noticed.reason : null,
      };
    });
    // You first, then everyone else by name.
    return { status: "listed", people: people.sort((a, b) => Number(b.you) - Number(a.you) || a.name.localeCompare(b.name)) };
  }

  /**
   * The Collections a step in this Collection's automations can add or
   * change records in, for the builder's picker: every Collection the
   * engine lists, with why the reach check (ADR 0012) stops a step there,
   * or null.
   */
  async targetsFor(collectionPath: string): Promise<CollectionAutomationTarget[]> {
    await this.ready();
    const roster = await this.options.cachedRoster();
    const collection = collectionNamed(collectionPath);
    return [...this.collections.keys()].sort().map((path) => {
      const target = collectionNamed(path);
      const [change, find] = checkAutomationReach(roster, {
        id: "", collection, codeFiles: [], steps: [{ kind: "change-records", collection: target }, { kind: "find-records", collection: target }],
      });
      return {
        path,
        name: target.name,
        stopped: change && !change.allowed ? change.reason : null,
        findStopped: find && !find.allowed ? find.reason : null,
      };
    });
  }

  /** Where an automation's Collection is now, once the index has read it, or null when this computer has none. */
  async whereIs(automationId: string): Promise<string | null> {
    await this.indexAutomation(automationId);
    return this.locate(automationId)?.collectionPath ?? null;
  }

  /**
   * The engine id of the automation `id` in the Collection at
   * `collectionPath`, or null when no Collection dohc can index is there.
   */
  async automationIdAt(collectionPath: string, id: string): Promise<string | null> {
    await this.indexCollection(collectionPath);
    const collectionId = this.collectionIdOf(collectionPath);
    return collectionId === null ? null : collectionAutomationId(collectionId, id);
  }

  /** The name an automation has in its Collection's automations.yaml now, for History; null when it has none. */
  async nameForHistory(automationId: string): Promise<string | null> {
    await this.indexAutomation(automationId);
    const id = this.locate(automationId);
    if (id === null) return null;
    const indexed = this.files.get(id.collectionPath) ?? await this.parsedFile(id.collectionPath);
    if (indexed?.file.status !== "read") return null;
    for (const entry of indexed.file.entries) {
      if (entry.status === "valid" && entry.automation.id === id.id) return entry.automation.name;
      if (entry.status === "invalid" && entry.id === id.id) return entry.name;
    }
    return null;
  }

  /** Every step that waits for a current editor to allow it, one per step. */
  holds(): CollectionAutomationHold[] {
    return this.stepsWhere((verdict) => verdict.verdict === "held");
  }

  /**
   * Every switched-on step a narrower share stopped whose notice nobody
   * dismissed, one per step.
   */
  stops(): CollectionAutomationStop[] {
    return this.stepsWhere((verdict, automation) =>
      automation.enabled && verdict.verdict === "stopped" && verdict.narrowed === true);
  }

  /**
   * Someone dismissed the notice for these stopped steps. Each names the
   * verdict they saw by `seq`, so a step that stopped again since keeps its
   * notice.
   */
  async dismissStops(seen: ReadonlyArray<{ automationId: string; definitionHash: string; step: string; seq: number }>): Promise<void> {
    await this.updateVerdicts(() => {
      for (const { automationId, definitionHash: hash, step, seq } of seen) {
        const key = reachVerdictKey(automationId, hash, step);
        const stored = this.verdicts.get(key);
        if (stored?.verdict !== "stopped" || stored.narrowed !== true || stored.seq !== seq) continue;
        const { narrowed: _dismissed, ...kept } = stored;
        this.verdicts.set(key, { ...kept, seq: ++this.verdictSeq });
      }
    });
  }

  /**
   * The switched-on steps that can run now and would stop if this share
   * were made, for the share dialog. Only the owner's computer makes
   * shares, so any other roster stops nothing.
   */
  async shareImpact(share: ReachShare): Promise<CollectionAutomationShareStop[]> {
    await this.ready();
    const writable = this.writableCollections();
    const automations: OwnedAutomation[] = [];
    for (const owned of this.everyAutomation()) {
      if (owned.automation.enabled && (await this.canRun(owned.automationId, owned.collectionPath, owned.automation, writable))) {
        automations.push(owned);
      }
    }
    const reach = automations.map(({ automationId, collectionPath, automation }) => {
      const collection = collectionNamed(collectionPath);
      return { id: automationId, collection, codeFiles: codeFilesOf(automation, collectionPath), steps: this.reachSteps(collectionPath, automation) };
    });
    const stopped = shareImpactOf(await this.options.roster(), share, reach);
    return stopped.flatMap(({ automationId, step }): CollectionAutomationShareStop[] => {
      const index = reach.findIndex((candidate) => candidate.id === automationId);
      const owner = automations[index];
      const reached = reach[index]?.steps[step];
      const target = reached ? reachDestination(reached) : null;
      if (!owner || !target) return [];
      return [{
        automationId,
        automationName: owner.automation.name,
        collectionPath: owner.collectionPath,
        ...target,
      }];
    });
  }

  /** The steps whose stored verdict matches, with what their notice names. */
  private stepsWhere(matches: (verdict: StoredReachVerdict, automation: Automation) => boolean): CollectionAutomationHold[] {
    const steps: CollectionAutomationHold[] = [];
    for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
      const hash = definitionHash(automation);
      const collection = collectionNamed(collectionPath);
      this.reachSteps(collectionPath, automation).forEach((reach, index) => {
        const step = reachStepId(reach, index);
        const stored = this.verdicts.get(reachVerdictKey(automationId, hash, step));
        if (!stored || !matches(stored, automation)) return;
        const held = reachDestination(reach);
        if (held === null) return;
        steps.push({
          automationId, automationName: automation.name, definitionHash: hash, step, seq: stored.seq,
          collection: collection.name, collectionPath, ...held, stoppedFor: stored.stoppedFor, fileUnread: this.fileUnread(stored),
        });
      });
      for (const stored of this.verdicts.values()) {
        if (stored.automationId !== automationId || stored.definitionHash !== hash || !stored.recipient || stored.verdict !== "held" || !matches(stored, automation)) continue;
        steps.push({
          automationId, automationName: automation.name, definitionHash: hash, step: stored.step, seq: stored.seq,
          collection: collection.name, collectionPath, target: stored.recipient.name, action: stored.recipient.action,
          recipient: stored.recipient.id, stoppedFor: stored.stoppedFor, fileUnread: this.fileUnread(stored),
        });
      }
    }
    return steps;
  }

  /**
   * The fields in one Collection that switched-on automations set, from any
   * Collection's automations. Before the workspace opens its automations
   * there are none; `onAutomationsChanged` says when to ask again.
   */
  async fieldMarks(collectionPath: string): Promise<CollectionFieldMark[]> {
    if (this.opened === null) return [];
    await this.opened;
    // A mark says a run writes the field, so it passes the checks a run
    // makes before it writes.
    const writable = this.writableCollections();
    if (!(await writable(collectionPath))) return [];
    return await this.marksOf(writable, ({ collectionPath: home, automation }) =>
      fieldWritesOf(automation).flatMap((write) => ((write.collection ?? home) === collectionPath ? [write.field] : [])));
  }

  /**
   * The fields in one table of a dataset Collection that its switched-on
   * automations set. A dataset's automations change only its own records,
   * so only its own automations.yaml marks them.
   */
  async datasetFieldMarks(datasetId: string, table: string): Promise<CollectionFieldMark[]> {
    if (this.opened === null) return [];
    await this.opened;
    const home = await this.datasetFolder(datasetId);
    const dataset = home === null ? undefined : this.datasets.get(home);
    if (dataset === undefined || dataset.generated === null) return [];
    return await this.marksOf(this.writableCollections(), ({ collectionPath, automation }) => collectionPath !== home ? [] :
      datasetFieldWritesOf(automation, { ...dataset, generated: dataset.generated === true }).flatMap((write) => (write.table === table ? [write.field] : [])));
  }

  /** Each field `fieldsOf` names for a switched-on automation that can run, with those automations' names in file order. */
  private async marksOf(
    writable: (path: string) => Promise<boolean>,
    fieldsOf: (owned: OwnedAutomation) => string[],
  ): Promise<CollectionFieldMark[]> {
    const marks = new Map<string, Map<string, string>>();
    for (const owned of this.everyAutomation()) {
      const { automationId, collectionPath, automation } = owned;
      if (!automation.enabled) continue;
      const fields = fieldsOf(owned);
      if (fields.length === 0 || !(await this.canRun(automationId, collectionPath, automation, writable))) continue;
      for (const field of fields) {
        const names = marks.get(field) ?? new Map<string, string>();
        names.set(automationId, automation.name);
        marks.set(field, names);
      }
    }
    return [...marks].map(([field, names]) => ({ field, automations: [...names.values()] }));
  }

  /**
   * The name an automation has in its Collection's file now, even while the
   * entry cannot be read, or null when the file no longer has it.
   */
  automationName(automationId: string): string | null {
    const parsed = this.locate(automationId);
    const indexed = parsed ? this.files.get(parsed.collectionPath) : undefined;
    if (!parsed || indexed?.file.status !== "read") return null;
    for (const entry of indexed.file.entries) {
      const [id, name] = entry.status === "valid" ? [entry.automation.id, entry.automation.name] : [entry.id, entry.name];
      if (id === parsed.id && name !== null) return name;
    }
    return null;
  }

  /**
   * A current editor allows a held step. `seq` names the hold they saw, so
   * a verdict that changed since does not take their answer.
   */
  async confirmReach(input: {
    automationId: string;
    definitionHash: string;
    step: string;
    seq: number;
    recipient?: string;
  }): Promise<"confirmed" | "changed"> {
    await this.ready();
    const confirmed = await this.updateVerdicts(() => {
      if (this.verdictsUnreadable) return false;
      const key = reachVerdictKey(input.automationId, input.definitionHash, input.step, input.recipient);
      const stored = this.verdicts.get(key);
      if (stored?.verdict !== "held" || stored.seq !== input.seq) return false;
      this.verdicts.set(key, { ...stored, verdict: "allowed", stoppedFor: null, seq: ++this.verdictSeq });
      return true;
    });
    if (!confirmed) return "changed";
    this.clearWaits("held");
    return "confirmed";
  }

  /**
   * Reads a Collection into the index once someone asks about it. A dataset
   * whose host is not open yet opens, as it does for a person looking at it,
   * so its automations and runs come from the dataset's own ledger.
   */
  private async indexCollection(collectionPath: string): Promise<void> {
    await this.ready();
    // A file change the watcher or a panel write already queued lands first.
    await this.chain;
    if (await this.maybeDataset(collectionPath)) await this.enqueue(() => this.indexDatasets(true));
  }

  private async maybeDataset(collectionPath: string): Promise<boolean> {
    return !this.collections.has(collectionPath) && !this.datasets.has(collectionPath) &&
      await this.options.pathExists(`${collectionPath}/${DATASET_FILE_NAME}`);
  }

  /**
   * Waits until the index has read the Collection an automation id names.
   * Before the executor opens there is no index, and run history lists what
   * the engine holds.
   */
  private async indexAutomation(automationId: string): Promise<void> {
    if (parseCollectionAutomationId(automationId) === null || this.opened === null) return;
    await this.ready();
    // A file change the watcher or a panel write already queued lands first.
    await this.chain;
    // A dataset whose host is not open yet may keep it.
    if (this.locate(automationId) === null) await this.enqueue(() => this.indexDatasets(true));
  }

  /**
   * One page of an automation's runs on this computer, newest first, and
   * the `before` of the next page, or null after the oldest.
   */
  async runs(automationId: string, before?: string): Promise<{ runs: CollectionAutomationRun[]; next: string | null }> {
    await this.indexAutomation(automationId);
    const page = await this.claimPage(automationId, { before, limit: RUN_PAGE });
    if (page === null) throw new Error("The workspace engine is not running.");
    const hash = this.currentHash(automationId);
    const runs: CollectionAutomationRun[] = [];
    // Only the runs shown are read.
    for (const claim of page.claims) runs.push(await this.runRow(automationId, claim, hash));
    return { runs, next: page.next };
  }

  /**
   * One of an automation's runs as run history lists it, however old and
   * whether or not its automation is still in the file. Null when this
   * computer has no such run.
   */
  async listedRun(automationId: string, claimId: string): Promise<CollectionAutomationRun | null> {
    await this.indexAutomation(automationId);
    const found = await this.findClaim(automationId, claimId, false);
    if (found === null) throw new Error("The workspace engine is not running.");
    return found === "missing" ? null : await this.runRow(automationId, found.history, this.currentHash(automationId));
  }

  private async runRow(automationId: string, claim: HistoryClaim, hash: string | null): Promise<CollectionAutomationRun> {
    const { stored, run } = await this.runOf(automationId, claim, hash);
    return { ...run, writes: stepWritesOf(stored).map(({ write }) => write) };
  }

  /** One of an automation's runs on this computer, with what each step changed, or null when this computer has no such run. */
  async run(automationId: string, claimId: string): Promise<CollectionAutomationRunDetail | null> {
    await this.indexAutomation(automationId);
    const found = await this.findClaim(automationId, claimId, false);
    if (found === null) throw new Error("The workspace engine is not running.");
    if (found === "missing") return null;
    const claim = found.history;
    const automation = this.definitionFor(automationId);
    const { stored, run } = await this.runOf(automationId, claim, automation ? definitionHash(automation) : null);
    if (run.state !== "failed" || run.neverStarted) return { ...run, steps: stepsOf(stored), failedStep: null, startsOver: false };
    // The run Try again continues, and whether it starts over, by retry's own rule.
    const tryAgain = automation ? tryAgainOf(await runsForClaim(this.options.store, { automationId, claimId }, automation)) : null;
    const readable = tryAgain !== null && !("refused" in tryAgain) ? tryAgain : null;
    return {
      ...run,
      steps: stepsOf(stored),
      failedStep: stoppedAtStep(readable?.current ?? stored.filter((entry) => !entry.superseded).at(-1)),
      startsOver: readable?.startsOver ?? false,
    };
  }

  /** The hash of the automation as its file says now, or null when the file no longer has it. */
  private currentHash(automationId: string): string | null {
    const automation = this.definitionFor(automationId);
    return automation ? definitionHash(automation) : null;
  }

  /** A claim's saved runs, oldest first, and the facts every reader of run history shows. */
  private async runOf(
    automationId: string,
    claim: HistoryClaim,
    hash: string | null,
  ): Promise<{ stored: StoredRun[]; run: Omit<CollectionAutomationRun, "writes"> }> {
    // A run a person started over under a newer definition still changed
    // records, so its writes stay in the list.
    const stored = (await this.options.store.runsOf(automationId, claim.claimId)).runs
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
    const live = stored.filter((run) => !run.superseded);
    return {
      stored,
      run: {
        claimId: claim.claimId,
        state: claim.state,
        error: claim.error ?? null,
        createdAtMs: claim.createdAtMs,
        updatedAtMs: claim.updatedAtMs,
        trigger: claim.trigger,
        definitionChanged: hash !== null && live.some((run) => run.definitionHash !== hash),
        ...stopOf(claim),
        undone: stored.length > 0 && stored.every((run) => run.undo === "done"),
      },
    };
  }

  /**
   * Try again for a failed claim. The caller contract: after the engine
   * queues the claim, this wakes the drain and asks the failure notices to
   * re-read, because the engine's own wake-up event can be dropped and a
   * repeated retry sends none. `startOver` confirms running a changed
   * automation, or a run whose progress is gone, from the beginning. For a
   * press, `watch` runs before the drain wakes, so the window that asked
   * hears how the run settles.
   */
  async retry(
    input: { automationId: string; claimId: string; startOver: boolean },
    watch?: (claimId: string, waiting: PressWaitReason | null) => void,
  ): Promise<CollectionAutomationRetry> {
    await this.ready();
    await this.indexAutomation(input.automationId);
    const parsed = this.locate(input.automationId);
    const automation = this.definitionFor(input.automationId);
    if (parsed === null || automation === null) {
      return { status: "refused", reason: "This automation is no longer in its Collection's automations.yaml." };
    }
    if (!automation.enabled) {
      return { status: "refused", reason: `"${automation.name}" is switched off. Switch it on, then try again.` };
    }
    const cannotRun = this.cannotRun(parsed.collectionPath, automation);
    if (cannotRun !== null) return { status: "refused", reason: cannotRun };
    // The guard is taken before the first read and held to the end, so an
    // Undo of the same run cannot start between this check and the retry.
    if (this.changing.has(input.claimId)) return { status: "refused", reason: BUSY_CLAIM_REFUSAL };
    this.changing.add(input.claimId);
    let press = false;
    try {
      const known = await this.findClaim(input.automationId, input.claimId, false);
      if (known === null) throw new Error("The workspace engine is not running.");
      // Without its run history, dohc cannot tell what the run already did.
      if (known === "missing") {
        return { status: "refused", reason: "Run history no longer shows this run, so dohc will not run it again." };
      }
      // A run that failed before it started has nothing to run again, whoever asks.
      if (known.neverStarted) return { status: "refused", reason: AUTOMATION_NEVER_STARTED_REFUSAL };
      press = known.pressedBy !== undefined;
      if (press && !(await this.options.mayRetryPress(known.pressedBy ?? null))) {
        return { status: "refused", reason: "Only the person who pressed this button, or the workspace's owner, can run it again." };
      }
      const runs = tryAgainOf(await runsForClaim(this.options.store, input, automation));
      if ("refused" in runs) return { status: "refused", reason: runs.refused };
      const { startsOver } = runs;
      if (startsOver && !input.startOver) {
        // Either version may have sent messages that a new run sends again.
        const earlier = runs.current ?? runs.changedSince;
        const repeatsMessages = sendsMessages(automation) ||
          (earlier?.applied.some((effect) => effect.writes.some((write) => (write.kind === "message" || write.kind === "notice"))) ?? false);
        return { status: "definition-changed", repeatsMessages };
      }
      this.waitingFor.delete(input.claimId);
      const retried = known.ledger === "dataset"
        ? await this.withLiveHost((ledger) => ledger.retry(input.claimId))
        : await this.withLiveEngine((engine) => engine.retryAutomationClaim({ claimId: input.claimId }));
      if (retried === null) throw new Error("The workspace engine is not running.");
      if (startsOver) {
        const hash = definitionHash(automation);
        for (const run of (await this.options.store.runsOf(input.automationId, input.claimId)).runs) {
          if (run.superseded || run.definitionHash === hash) continue;
          await this.options.store.save({ ...run, superseded: true, finishedAtMs: run.finishedAtMs ?? this.nowMs() });
        }
      }
    } finally {
      this.changing.delete(input.claimId);
    }
    if (press) watch?.(input.claimId, null);
    this.notifyClaimed();
    this.failuresChanged();
    return { status: "queued", press };
  }

  /**
   * What each Button field shows in one Collection. A button is ready when
   * one switched-on automation uses it, dohc can run that automation, and
   * no step is stopped or waits for an editor to allow it. States read the
   * roster the last listing left, so showing a Collection never waits on
   * the relay. A roster dohc cannot read yet does not stop a press: the
   * run checks reach again before it writes, and waits for the roster.
   */
  async buttons(collectionPath: string, fields: readonly string[]): Promise<CollectionAutomationButton[]> {
    await this.ready();
    const roster = await this.options.cachedRoster();
    const buttons: CollectionAutomationButton[] = [];
    for (const field of fields) buttons.push({ field, state: await this.buttonState(collectionPath, field, roster) });
    return buttons;
  }

  /**
   * Presses a ready button on one record. `pressedBy` is the person main
   * checked; the run acts for them. A press sent again with its `pressId`
   * answers the same claim, even if the button or record changed since: only
   * a new press is checked. `busy` when the button runs on the record for
   * someone else. `watch` gets an unsettled claim, and why it waits, before
   * the drain wakes, so the pressing window hears how the run settles.
   */
  async press(
    input: { collectionPath: string; field: string; recordId: string; pressId: string; pressedBy: string; by: AutomationPressActor },
    watch: (claimId: string, waiting: PressWaitReason | null) => void,
    /** Checks a new press the way the caller must, such as that the field is still a button. */
    checkNew: () => Promise<void> = async () => undefined,
  ): Promise<CollectionAutomationPress> {
    await this.ready();
    const remembered = this.presses.get(input.pressId) ?? await this.pressInEngine(input);
    let automationId: string;
    if (remembered) {
      if (parseCollectionAutomationId(remembered.automationId)?.collectionId !== this.collectionIdOf(input.collectionPath) || remembered.field !== input.field ||
        remembered.recordId !== input.recordId || remembered.pressedBy !== input.pressedBy) {
        throw new Error("This press id already names another press.");
      }
      automationId = remembered.automationId;
    } else {
      await checkNew();
      const state = await this.buttonState(input.collectionPath, input.field, await this.options.cachedRoster());
      if (state.kind !== "ready") throw new Error(state.reason);
      automationId = state.automationId;
    }
    const pressed = await this.withLiveEngine(async (engine) => {
      if (!remembered) {
        try {
          await engine.getCollectionRecord({ collectionPath: input.collectionPath, recordId: input.recordId, historyLimit: 1 });
        } catch (error) {
          if (error instanceof Error && error.message === RECORD_NOT_FOUND) {
            throw new Error(`This record is no longer in ${collectionNamed(input.collectionPath).name}.`);
          }
          throw error;
        }
      }
      return engine.pressAutomation({ pressId: input.pressId, automationId, recordId: input.recordId, pressedBy: input.pressedBy, by: input.by });
    });
    if (pressed === null) throw new Error("The workspace engine is not running.");
    if (pressed.busy) return { busy: true };
    const { claim } = pressed;
    this.presses.delete(input.pressId);
    this.presses.set(input.pressId, { field: input.field, recordId: input.recordId, pressedBy: input.pressedBy, automationId });
    if (this.presses.size > REMEMBERED_PRESSES) this.presses.delete(this.presses.keys().next().value!);
    return await this.answerPress(claim, watch);
  }

  /**
   * How a press's claim stands: how its run ended, or, while it has not,
   * the window watches it and the drain wakes, since a ledger's wake-up
   * event can be dropped.
   */
  private async answerPress(
    claim: Pick<AutomationClaimSummary, "automationId" | "claimId" | "state"> & { error?: string | null },
    watch: (claimId: string, waiting: PressWaitReason | null) => void,
  ): Promise<CollectionAutomationPress> {
    if (claim.state === "failed") {
      const error = claim.error === AUTOMATION_CHAIN_STOPPED ? CHAIN_STOPPED_PRESS : claim.error ?? null;
      return { busy: false, claimId: claim.claimId, settled: { outcome: "failed", error } };
    }
    if (claim.state === "done") return { busy: false, claimId: claim.claimId, settled: { outcome: await this.doneOutcome(claim), error: null } };
    // A press never waits for a dataset to open: its ledger claimed it there.
    const waiting = this.waitingFor.get(claim.claimId) ?? null;
    watch(claim.claimId, waiting === "dataset" ? null : waiting);
    this.notifyClaimed();
    return { busy: false, claimId: claim.claimId, settled: null };
  }

  /**
   * What each Button field shows in a dataset Collection, in order, by its
   * table's name. `description` is the dataset as its host describes it to
   * the person asking, so the access is theirs.
   */
  /**
   * The approved dataset a Collection folder holds, or null for a document
   * Collection or a folder with no approved dataset. A closed dataset host
   * opens, as it does for a person opening the Collection.
   */
  async datasetIn(collectionPath: string): Promise<string | null> {
    await this.indexCollection(collectionPath);
    return this.datasets.get(collectionPath)?.definition.datasetId ?? null;
  }

  /** Whether the dataset ledger remembers a press by this id, so sending it again answers its claim. */
  async datasetPressed(pressId: string): Promise<boolean> {
    await this.ready();
    const known = await this.withLiveHost((ledger) => ledger.pressed(pressId) !== null, true);
    if (known === null) throw new Error("The workspace's dataset host is not open.");
    return known;
  }

  async datasetButtons(
    datasetId: string,
    buttons: ReadonlyArray<{ field: string; table: string }>,
    describe: (datasetId: string) => Promise<DatasetDescription>,
  ): Promise<AutomationButtonState[]> {
    await this.ready();
    const collectionPath = await this.datasetFolder(datasetId);
    const roster = await this.options.cachedRoster();
    const descriptions = this.buttonDescriptions(describe);
    const description = await descriptions(datasetId);
    const states: AutomationButtonState[] = [];
    for (const button of buttons) {
      states.push(collectionPath === null
        ? { kind: "disabled", reason: DATASET_NOT_APPROVED }
        : (await this.datasetButton(collectionPath, button, description, roster, descriptions)).state);
    }
    return states;
  }

  /**
   * Presses a ready button on one record of a dataset Collection, as
   * `press` does in a document Collection. `recordId` is the record's
   * primary key as JSON, and the record must be in the table now. The press
   * claims in the dataset host's ledger, bound to the automation it was
   * checked against. The ledger keeps each press 30 days with what it asked
   * for, so the same press sent again answers its claim whatever changed
   * since, a renamed button included; only a new press is checked.
   */
  async pressDataset(
    input: { datasetId: string; table: string; field: string; recordId: string; pressId: string; pressedBy: string; by: AutomationPressActor;
      /** The names of the actions the person was told can't be undone and chose to run. */
      confirmed: readonly string[] },
    describe: (datasetId: string) => Promise<DatasetDescription>,
    watch: (claimId: string, waiting: PressWaitReason | null) => void,
  ): Promise<CollectionAutomationPress> {
    await this.ready();
    const collectionPath = await this.datasetFolder(input.datasetId);
    if (collectionPath === null) throw new Error(DATASET_NOT_APPROVED);
    const recordId = datasetRecordIdOf(input.recordId);
    if (recordId === null) throw new Error(`This record is not in ${input.table}.`);
    const request = createHash("sha256")
      .update(JSON.stringify(["dohc-dataset-press-v1", input.datasetId, input.table, input.field, recordId, input.pressedBy])).digest("hex");
    const known = await this.withLiveHost((ledger) => ({ press: ledger.pressed(input.pressId) }), true);
    if (known === null) throw new Error("The workspace's dataset host is not open.");
    if (known.press !== null) {
      const { claim } = known.press;
      if (known.press.request !== request || datasetPresser(claim) !== input.pressedBy) throw new Error("This press id already names another press.");
      return await this.answerPress(claim, watch);
    }
    const descriptions = this.buttonDescriptions(describe);
    const description = await descriptions(input.datasetId);
    const button = await this.datasetButton(collectionPath, input, description, await this.options.cachedRoster(), descriptions);
    if (!("checked" in button)) throw new Error(button.state.reason);
    // The automation changed since the button asked: it would run an action nobody agreed to.
    if ((button.state.irreversible ?? []).some((action) => !input.confirmed.includes(action.name))) throw new Error(changedSincePressed(input.field));
    const { datasetId, tableId, fieldId, automation } = button.checked;
    const pressed = await this.withLiveHost(async (ledger) => {
      // A dataset that moved to a server says so before anything reads it.
      ledger.assertPressable(datasetId, { tableId, fieldId });
      // Operations someone wrote are not read for dohc's own checks; the run
      // passes the record's id, and the operation it invokes finds the record.
      if (ledger.generated(datasetId) && !(await datasetRecordExists(ledger, datasetId, automation, recordId))) {
        throw new Error(`This record is no longer in ${input.table}.`);
      }
      return ledger.press(datasetId, {
        pressId: input.pressId, request, automationId: button.state.automationId, definitionHash: definitionDigest(automation),
        tableId, fieldId, recordId, pressedBy: input.pressedBy, by: input.by,
      });
    }, true);
    if (pressed === null) throw new Error("The workspace's dataset host is not open.");
    if (pressed.kind === "busy") return { busy: true };
    // A press the chain cap stopped is a new failure: run history and its notice learn it now.
    if (pressed.kind === "claimed" && pressed.claim.state === "failed") this.failuresChanged();
    return await this.answerPress(pressed.claim, watch);
  }

  /**
   * One dataset button's state, and for a ready one, the automation and the
   * table and field ids it was checked with. Access comes first: the host
   * must let the person write the button's table and use every operation a
   * run of its automation calls, the reads the run makes as the owner
   * included, and a person who cannot learns nothing about the automation.
   * The rest is as for a document Collection's button.
   */
  private buttonDescriptions(describe: (datasetId: string) => Promise<DatasetDescription>) {
    const descriptions = new Map<string, Promise<DatasetDescription>>();
    return (datasetId: string) => {
      let pending = descriptions.get(datasetId);
      if (pending === undefined) { pending = describe(datasetId); descriptions.set(datasetId, pending); }
      return pending;
    };
  }

  private async datasetButton(
    collectionPath: string,
    button: { field: string; table: string | null },
    description: DatasetDescription,
    roster: ReachRoster,
    describe: (datasetId: string) => Promise<DatasetDescription>,
  ): Promise<
    | { state: Exclude<AutomationButtonState, { kind: "ready" }> }
    | { state: Extract<AutomationButtonState, { kind: "ready" }>; checked: { automation: Automation; datasetId: string; tableId: string; fieldId: string } }
  > {
    const disabled = (reason: string) => ({ state: { kind: "disabled" as const, reason } });
    const dataset = this.datasets.get(collectionPath);
    if (dataset === undefined) return disabled(DATASET_NOT_APPROVED);
    const { definition } = dataset;
    const table = datasetTableNamed(definition, button.table);
    // A description of another dataset grants nothing here.
    if (table === undefined || description.datasetId !== definition.datasetId || !datasetButtonAccess(description, table.name, [])) {
      return disabled(noAccessReason(table?.name ?? button.table ?? definition.name));
    }
    const field = table.fields.find((candidate) => candidate.type === "button" && candidate.name === button.field);
    if (field === undefined) return disabled(`${button.field} is not a button in ${table.name}.`);
    // A dataset that moved to a server lists its buttons with the reason a press would get.
    const unpressable = await this.withLiveHost((host) => {
      try {
        host.assertPressable(definition.datasetId, { tableId: table.tableId, fieldId: field.fieldId });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    if (unpressable) return disabled(unpressable);
    const resolved = resolveButton(this.files.get(collectionPath)?.file ?? null, button.field,
      (named) => named === table.name || (named === null && definition.tables.length === 1), definition.name);
    if (resolved.kind === "state") return { state: resolved.state };
    const { automation } = resolved;
    let inventory: AutomationInventory;
    try { inventory = this.inventory(collectionPath, automation); }
    catch (error) { return disabled(errorText(error)); }
    const operations = new Map<string, Set<string>>();
    for (const step of inventory.reach) {
      if (step.kind !== "dataset-operation") continue;
      const names = operations.get(step.datasetId) ?? new Set<string>();
      names.add(step.operation.name);
      operations.set(step.datasetId, names);
    }
    for (const [datasetId, names] of operations) {
      let access: DatasetDescription;
      try { access = await describe(datasetId); }
      catch { return disabled(noAccessReason(table.name)); }
      if (access.datasetId !== datasetId || [...names].some((name) => !access.operations.some((operation) => operation.name === name))) {
        return disabled(noAccessReason(table.name));
      }
    }
    const state = await this.runnableButtonState(collectionPath, automation, roster, inventory.reach);
    if (state.kind !== "ready") return { state };
    // A press that runs an action asks first, since dohc cannot undo what the action did.
    const irreversible = datasetIrreversibleActions(automation, definition);
    return {
      state: irreversible.length === 0 ? state : { ...state, irreversible },
      checked: { automation, datasetId: definition.datasetId, tableId: table.tableId, fieldId: field.fieldId },
    };
  }

  /**
   * The folder of the dataset Collection with this id, which holds its
   * automations.yaml, for the ⚡ panel. Or why dohc cannot run its automations.
   */
  async datasetCollection(datasetId: string): Promise<{ status: "found"; collectionPath: string } | { status: "cannot-run"; reason: string }> {
    await this.ready();
    const collectionPath = await this.datasetFolder(datasetId);
    return collectionPath === null ? { status: "cannot-run", reason: DATASET_NOT_APPROVED } : { status: "found", collectionPath };
  }

  /**
   * The folder of the dataset Collection with this id, or null when no
   * approved dataset has it. A person is asking about it, so a dataset the
   * index lacks opens its host to be indexed.
   */
  private async datasetFolder(datasetId: string): Promise<string | null> {
    const find = () => [...this.datasets].find(([, dataset]) => dataset.definition.datasetId === datasetId)?.[0] ?? null;
    if (find() === null) await this.enqueue(() => this.indexDatasets(true));
    return find();
  }

  /** A dataset Collection the index lacks, whose host may not be open yet: a person is asking about it, so open it. */
  private async openDataset(collectionPath: string): Promise<void> {
    if (!this.collections.has(collectionPath) && !this.datasets.has(collectionPath) &&
      await this.options.pathExists(`${collectionPath}/${DATASET_FILE_NAME}`)) {
      await this.enqueue(() => this.indexDatasets(true));
    }
  }

  /**
   * A press the engine already has, after a restart or once this computer
   * forgot it. The engine keeps presses 30 days, keyed `press:<press id>`,
   * but answers only by automation, so each automation this button could
   * name, switched on or not, is asked. The press it finds is checked
   * against this one before anything joins it. A press whose automation
   * left the file is not found, and is checked as new.
   */
  private async pressInEngine(input: { collectionPath: string; field: string; pressId: string }): Promise<RememberedPress | null> {
    const file = this.files.get(input.collectionPath)?.file;
    const collectionId = this.collectionIdOf(input.collectionPath);
    if (file?.status !== "read" || collectionId === null) return null;
    const ids = file.entries.flatMap((entry) => {
      if (entry.status === "valid") {
        const { when, id } = entry.automation;
        return when.kind === "button" && when.field === input.field && when.table === null ? [id] : [];
      }
      return entry.id !== null && namesButton(entry.raw, input.field) ? [entry.id] : [];
    });
    const key = `press:${input.pressId}`;
    for (const id of new Set(ids)) {
      const automationId = collectionAutomationId(collectionId, id);
      const found = await this.withLiveEngine((engine) => engine.getAutomationClaim({ automationId, key }));
      if (found === null) throw new Error("The workspace engine is not running.");
      const claim = found.claim;
      if (claim === null) continue;
      if (claim.change.kind !== "button" || claim.recordId === null || claim.change.onBehalfOf === null) {
        throw new Error("This press id already names another press.");
      }
      return { field: input.field, recordId: claim.recordId, pressedBy: claim.change.onBehalfOf, automationId };
    }
    return null;
  }

  /**
   * Whether a done claim's run changed anything. A run that wrote keeps its
   * record until run history trims it. A run that stopped before it had a
   * plan, as when its record left, saved none, and neither did a trimmed
   * one, so without a record the run only ended.
   */
  private async doneOutcome(claim: Pick<AutomationClaimSummary, "automationId" | "claimId">): Promise<"done" | "ended"> {
    const { runs } = await this.options.store.runsOf(claim.automationId, claim.claimId);
    return runs.some((run) => !run.superseded && run.outcome?.state === "done") ? "done" : "ended";
  }

  /**
   * A press from a shared view that the relay carried here: `automationId`
   * names the automation the recipient saw, `collectionPath` is where the
   * relay checked they can edit it, and `pressedBy` is the user the relay
   * verified. It runs as a press on this computer, checked the same way,
   * unless the button now runs another automation or its Collection moved.
   * Answers the press and the button's field, for the notice a failure sends.
   */
  async pressRelayed(
    input: { automationId: string; collectionPath: string; definitionHash: string; recordId: string; pressId: string; pressedBy: string },
    watch: (claimId: string, waiting: PressWaitReason | null) => void,
  ): Promise<{ pressed: CollectionAutomationPress; field: string | null }> {
    await this.ready();
    const id = this.locate(input.automationId);
    const automation = this.definitionFor(input.automationId);
    if (id === null || automation === null || automation.when.kind !== "button" || automation.when.table !== null) {
      throw new Error("This button no longer runs an automation in its Collection.");
    }
    // The relay allowed the press for the Collection at this path, so it
    // runs only while the Collection is still there.
    if (id.collectionPath !== input.collectionPath) throw new Error(MOVED_SINCE_PRESSED);
    const field = automation.when.field;
    // The press runs only the automation the person saw when they pressed.
    if (definitionHash(automation) !== input.definitionHash) throw new Error(changedSincePressed(field));
    const resolved = resolveButton(this.files.get(id.collectionPath)?.file ?? null, field, (table) => table === null, collectionNamed(id.collectionPath).name);
    if (resolved.kind === "one" && resolved.automation.id !== automation.id) {
      throw new Error(`${field} now runs another automation. Press it again.`);
    }
    // The engine's press id carries that definition, so the claim stays
    // bound to it through a restart; the run refuses any other.
    const pressId = relayedPressId(input.pressId, input.definitionHash, input.collectionPath);
    await this.markHostClaims();
    // The relay carries a person's press; no agent presses through it.
    const pressed = await this.press({ collectionPath: id.collectionPath, field, recordId: input.recordId, pressId, pressedBy: input.pressedBy, by: { kind: "human" } }, watch);
    return { pressed, field };
  }

  /**
   * The claim the engine already holds for a relayed press, found without
   * making one, or null when it holds none. A host that restarted resumes a
   * press only through this; one with no claim goes back to the relay first.
   */
  async relayedClaim(input: { automationId: string; collectionPath: string; definitionHash: string; pressId: string }): Promise<{
    claimId: string;
    settled: Omit<PressSettled, "claimId"> | null;
  } | null> {
    const key = `press:${relayedPressId(input.pressId, input.definitionHash, input.collectionPath)}`;
    const found = await this.withLiveEngine((engine) => engine.getAutomationClaim({ automationId: input.automationId, key }));
    if (found === null) throw new Error("The workspace engine is not running.");
    const claim = found.claim;
    if (!claim) return null;
    if (claim.state === "failed") return { claimId: claim.claimId, settled: { outcome: "failed", error: claim.error ?? null } };
    if (claim.state === "done") return { claimId: claim.claimId, settled: { outcome: await this.doneOutcome(claim), error: null } };
    return { claimId: claim.claimId, settled: null };
  }

  private async buttonState(
    collectionPath: string,
    field: string,
    roster: ReachRoster,
  ): Promise<AutomationButtonState> {
    const resolved = resolveButton(this.files.get(collectionPath)?.file ?? null, field, (table) => table === null, collectionNamed(collectionPath).name);
    return resolved.kind === "state" ? resolved.state : await this.runnableButtonState(collectionPath, resolved.automation, roster);
  }

  /**
   * The state of a button whose one automation is resolved: ready unless
   * dohc cannot run the automation, or a step is stopped or waits for an
   * editor to allow it. A dataset field formulas cannot see is hidden from
   * them, and stops nothing.
   */
  private async runnableButtonState(collectionPath: string, automation: Automation, roster: ReachRoster, inventory?: readonly ReachStep[]): Promise<AutomationButtonState> {
    const unsupported = inventory === undefined ? this.cannotRun(collectionPath, automation) : null;
    if (unsupported !== null) return { kind: "disabled", reason: unsupported };
    const automationId = this.automationIdIn(collectionPath, automation.id);
    if (roster.kind === "unknown") return { kind: "ready", automationId };
    let steps: readonly ReachStep[];
    try {
      steps = inventory ?? this.reachSteps(collectionPath, automation);
    } catch (error) { return { kind: "disabled", reason: errorText(error) }; }
    for (const [index, reach] of checkAutomationReach(roster, { id: automation.id, collection: collectionNamed(collectionPath), codeFiles: codeFilesOf(automation, collectionPath), steps }).entries()) {
      if (!reach.allowed && steps[index]!.kind !== "dataset-field") return { kind: "disabled", reason: reach.reason };
    }
    if (await this.recordVerdicts(roster, [{ automationId, collectionPath, automation }], steps)) {
      return { kind: "disabled", reason: `Automation "${automation.name}" is waiting. Allow its step in Notices.` };
    }
    return { kind: "ready", automationId };
  }

  /**
   * Undo for a finished run: its fields go back where no one changed them
   * since. In a document Collection the records it added move to the trash
   * through `trash`; in a dataset each reversible edit goes back through its
   * approved edit as the person on this computer, whichever ledger claimed
   * the run. A dataset run that added records first answers what Undo will
   * delete and keep; `deletes` then confirms exactly that preview, with the
   * person's choice of delete where one is needed.
   */
  async undo(
    input: { automationId: string; claimId: string; deletes: DatasetUndoConfirmed | null },
    trash: (path: string) => Promise<void>,
    // Stop and restore undoes only the runs under these definitions.
    definitionHashes?: ReadonlySet<string>,
  ): Promise<CollectionAutomationUndo> {
    await this.ready();
    const parsed = this.locate(input.automationId);
    // Held from before the first read to the end, like Try again's.
    if (this.changing.has(input.claimId)) return { status: "refused", reason: BUSY_CLAIM_REFUSAL };
    this.changing.add(input.claimId);
    try {
      // An expiry batch already sent may not know this claim is being undone.
      await this.historyBatch;
      const claim = await this.findClaim(input.automationId, input.claimId, true);
      if (claim === null) throw new Error("The workspace engine is not running.");
      if (claim === "missing") return { status: "refused", reason: "dohc no longer has this run on this computer." };
      if (claim.state !== "done" && claim.state !== "failed") {
        return { status: "refused", reason: "This run has not finished. Undo it once it finishes." };
      }
      const stored = await this.options.store.runsOf(input.automationId, input.claimId);
      const { unreadable } = stored;
      const runs = definitionHashes
        ? stored.runs.filter((run) => definitionHashes.has(run.definitionHash))
        : stored.runs;
      if (unreadable) {
        return { status: "refused", reason: "dohc could not read this run's saved changes in .dohc/automations, so it undid nothing." };
      }
      if (runs.length > 0 && runs.every((run) => run.undo === "done")) {
        return { status: "refused", reason: "You already undid this run." };
      }
      const hasDatasets = runs.some((run) => run.steps.some((step) => step.effects.some((effect) => "rules" in effect)) ||
        run.applied.some((entry) => entry.writes.some((write) => "rules" in write)));
      if (parsed === null) return { status: "refused", reason: LOST_COLLECTION_ERROR };
      if (hasDatasets && await this.withLiveHost(() => true, true) !== true) {
        throw new Error("The dataset host is unavailable. Reopen the workspace, then try again.");
      }
      const needsReverseReach = datasetUndoDeletesRecorded(runs) || runs.some((run) => run.applied.some((entry) =>
        entry.writes.some((write) => write.kind === "dataset-action" && write.reverseOperationId !== undefined)));
      const source = needsReverseReach ? { roster: await this.options.roster(), collection: collectionNamed(parsed.collectionPath) } : null;
      for (const run of runs) {
        if (rebaseRun(run, (id) => this.collectionPathOf(id)).lost) return { status: "refused", reason: LOST_COLLECTION_ERROR };
      }
      let reverseReach: ReachStep[];
      try {
        const reach = (host: DatasetUndoHost | null) => automationUndoReach(runs, this.targetResolver(), (id) => this.collectionPathOf(id), source, host);
        const checked = hasDatasets ? await this.withLiveHost(reach, true) : await reach(null);
        if (checked === null) throw new Error("The dataset host is unavailable. Reopen the workspace, then try again.");
        reverseReach = checked;
      }
      catch (error) { return { status: "refused", reason: errorText(error) }; }
      const denied = source && checkAutomationReach(source.roster, {
        id: parsed.id, collection: collectionNamed(parsed.collectionPath), codeFiles: [], steps: reverseReach,
      }).find((verdict) => !verdict.allowed);
      if (denied && !denied.allowed) return { status: "refused", reason: denied.reason };
      // Every run of the claim changed records, one a person started over
      // under a newer definition too. One whose Undo stopped part way is
      // undone again: what is already back stays as it is.
      const pending = runs.filter((run) => run.undo !== "done");
      // Kept with the claim's newest run, whichever runs are saved undone.
      const newest = () => runs.reduce((latest, run) => (run.startedAtMs > latest.startedAtMs ? run : latest));
      // Dataset Undo checks everything before anything below is saved or
      // sent. It reads every run of the claim, those saved undone too, so a
      // retry after only some were saved done sends the same requests as
      // before and replays their receipts instead of writing again.
      const checked = hasDatasets ? await this.datasetUndoCheck(input, collectionNamed(parsed.collectionPath), stored.runs, runs, pending) : null;
      if (checked !== null && "status" in checked) return checked;
      // Saved before anything is reversed, so no run resumes over what this
      // puts back, even if it stops part way.
      for (const run of pending) {
        if (run.undo === null) await this.options.store.updateState(run, { undo: "started" });
      }
      // Every reverse and delete is saved, in one line with the runs it
      // covers, before the first is sent, so an Undo that stops part way
      // never chooses again. They are kept with the newest of those runs.
      if (checked !== null && checked.covers.length > 0) {
        const holder = checked.covers.reduce((latest, run) => (run.startedAtMs > latest.startedAtMs ? run : latest));
        const covers = checked.covers.map((run) => run.keySeed);
        await this.options.store.recordUndoCalls(holder, covers, checked.calls);
        holder.undoCovers.push(...covers);
        holder.undoCalls.push(...checked.calls);
      }
      const reverse = (host: DatasetUndoHost | null) => undoAutomationRuns({
        withReads: (work) => this.withLiveEngine(work), withRecordWrites: this.options.withRecordWrites,
        trash, collectionPathOf: (id) => this.collectionPathOf(id),
      }, host, collectionNamed(parsed.collectionPath), async () => {
        const roster = await this.options.cachedRoster();
        if (roster.kind === "unknown") throw new Error(rosterProblem(roster, collectionNamed(parsed.collectionPath)));
        return roster;
      }, input.claimId, runs, async (request) => {
        await this.options.store.recordUndoRequest(newest(), request);
        newest().undoRequests.push(request);
      }, this.runAbort.signal);
      const undone = hasDatasets ? await this.withLiveHost(reverse, true) : await reverse(null);
      if (undone === null) throw new Error("dohc could not open this Collection. Reopen the workspace, then try again.");
      for (const run of pending) await this.options.store.updateState(run, { undo: "done" });
      return { status: "undone", ...undone };
    } finally {
      this.changing.delete(input.claimId);
    }
  }

  /**
   * A dataset Undo's checks before it saves or sends anything: the rules
   * every edit, added record, and action ran under still resolve, every
   * saved reverse still has the run of its action, and who can edit is
   * known wherever a delete may run. Then the reverses and
   * deletes to send for the runs this Undo has not finished that no saved
   * list covers yet, such as those a Stop and restore of one definition
   * left out; runs a saved list covers send what it saved. A run that
   * added records sends only those of the preview the person
   * confirmed; without a confirmation, or when what Undo would do changed
   * since the person read it, it answers the preview. Any other run sends
   * its actions' reverses without one, since it deletes nothing.
   */
  private async datasetUndoCheck(
    input: { claimId: string; deletes: DatasetUndoConfirmed | null },
    collection: ReachCollection,
    /** Every saved run of the claim, those this Undo leaves out too. */
    claimRuns: readonly StoredRun[],
    runs: readonly StoredRun[],
    pending: readonly StoredRun[],
  ): Promise<DatasetUndoChecked> {
    // Reach (ADR 0012) as it is now, for the editors of the automation the runs' saved id names.
    const roster = await this.options.roster();
    if (roster.kind === "unknown" && datasetUndoDeletesRecorded(runs)) return { status: "refused", reason: rosterProblem(roster, collection) };
    const covered = new Set(runs.flatMap((run) => run.undoCovers));
    const unplanned = pending.filter((run) => !covered.has(run.keySeed));
    const added = unplanned.some((run) => run.applied.some(({ writes }) => writes.some((write) => write.kind === "dataset-created")));
    const checked = await this.withLiveHost(async (host): Promise<DatasetUndoChecked> => {
      // A dataset change goes back only under the rules it ran under.
      if (datasetUndoRulesChanged(host, runs)) return { status: "refused", reason: DATASET_UNDO_RULES_CHANGED };
      const lost = datasetUndoLostRun(host, claimRuns);
      if (lost !== null) return { status: "refused", reason: lost };
      if (unplanned.length === 0) return { collection, covers: [], calls: [] };
      const planned = await planDatasetUndo(host, { roster, collection }, input.claimId, runs, unplanned, this.runAbort.signal);
      const confirmed = !added ? { token: planned.preview.token, chosen: [] } : input.deletes;
      const calls = confirmed?.token === planned.preview.token ? planned.send(confirmed.chosen) : null;
      return calls === null ? { status: "confirm", preview: planned.preview } : { collection, covers: unplanned, calls };
    }, true);
    if (checked === null) throw new Error("dohc could not open this Collection. Reopen the workspace, then try again.");
    return checked;
  }

  /**
   * Stop and restore: undoes every finished run in this computer's run
   * history under one of these definitions, as Undo on each would, newest
   * first as run history lists them, so each field goes back in turn. A
   * claim's runs under other definitions stay. `left` counts the runs Undo
   * refused, such as one still running. `kept` counts the changes undone
   * runs made that stay as they are: dataset records and actions Undo cannot
   * reverse, and fields someone changed since or whose record is gone.
   * A failure part way stops there and answers what went before, with it.
   * Each definition names its automation by the Collection its file was in
   * and its id there.
   */
  async undoRunsOf(
    definitions: ReadonlyArray<{ collectionPath: string; id: string; definitionHash: string }>,
    trash: (path: string) => Promise<void>,
  ): Promise<{ undone: number; left: number; kept: number; errorMessage: string | null }> {
    const hashes = new Map<string, Set<string>>();
    for (const { collectionPath, id, definitionHash: hash } of definitions) {
      const automationId = await this.automationIdAt(collectionPath, id);
      if (automationId !== null) hashes.set(automationId, (hashes.get(automationId) ?? new Set()).add(hash));
    }
    const result = { undone: 0, left: 0, kept: 0 };
    try {
      await this.undoEachRun(hashes, trash, result);
    } catch (error) {
      return { ...result, errorMessage: error instanceof Error ? error.message : String(error) };
    }
    return { ...result, errorMessage: null };
  }

  private async undoEachRun(
    hashes: ReadonlyMap<string, ReadonlySet<string>>,
    trash: (path: string) => Promise<void>,
    result: { undone: number; left: number; kept: number },
  ): Promise<void> {
    for (const [automationId, wanted] of hashes) {
      // A dataset's runs are in its host's ledger, which may not be open yet.
      await this.indexAutomation(automationId);
      const listed = await this.everyClaim(automationId);
      if (listed === null) throw new Error("The workspace engine is not running.");
      for (const claim of listed) {
        const runs = (await this.options.store.runsOf(automationId, claim.claimId)).runs
          .filter((run) => wanted.has(run.definitionHash));
        if (runs.length === 0 || runs.every((run) => run.undo === "done")) continue;
        const target = { automationId, claimId: claim.claimId };
        let undone = await this.undo({ ...target, deletes: null }, trash, wanted);
        // Records a run added are deleted only after a person reads the
        // preview in its run history, so a run that would delete any is left.
        if (undone.status === "confirm" && undone.preview.deletes + undone.preview.unchecked === 0) {
          undone = await this.undo({ ...target, deletes: { token: undone.preview.token, chosen: [] } }, trash, wanted);
        }
        if (undone.status !== "undone") {
          result.left += 1;
          continue;
        }
        result.undone += 1;
        result.kept += undone.kept + undone.keptChanged + undone.irreversible + undone.actions + undone.changedSince + undone.missing;
      }
    }
  }

  /** The name an engine automation id's automation has in its file, or null. */
  nameOf(automationId: string): string | null {
    return this.definitionFor(automationId)?.name ?? null;
  }

  /** Waits for the open that reads the index. Only the workspace's own open starts one. */
  private async ready(): Promise<void> {
    if (this.opened === null) throw new Error("dohc is still opening this workspace's automations. Try again in a moment.");
    await this.opened;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.state !== "disposed") await work();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private withLiveEngine<T>(work: (engine: CollectionAutomationEngine) => Promise<T>): Promise<T | null> {
    if (this.state === "disposed" || this.state === "paused") return Promise.resolve(null);
    return this.options.withEngine(work);
  }

  /** The dataset host, only while the executor runs. With `open`, opens it for what a person asked. */
  private withLiveHost<T>(work: (host: DatasetAutomationHost) => T | Promise<T>, open = false): Promise<T | null> {
    if (this.state === "disposed" || this.state === "paused") return Promise.resolve(null);
    return this.options.withDatasetHost(work, open);
  }

  /**
   * One page of an automation's claims in each ledger that can hold them,
   * newest first, both ledgers merged. The engine claims schedules, Group
   * messages, and a document's changes and presses. A dataset's own ledger
   * claims its record changes and presses. An automation whose trigger
   * changed between those kinds has claims in both. Null when either ledger
   * cannot be read.
   */
  private async claimPage(automationId: string, page: { before?: string; limit: number }): Promise<ClaimPage | null> {
    const id = this.locate(automationId);
    const engine = await this.withLiveEngine(async (live): Promise<ClaimPage> => {
      const listed = await live.listAutomationClaims({ automationId, ...page });
      return { claims: listed.claims.map(engineHistoryClaim), next: listed.next };
    });
    if (engine === null) return null;
    const pages = [engine];
    if (id !== null && this.datasets.has(id.collectionPath)) {
      const dataset = await this.withLiveHost((ledger): ClaimPage => {
        const listed = ledger.claims(automationId, page);
        return { claims: listed.claims.map(datasetHistoryClaim), next: listed.next };
      });
      if (dataset === null) return null;
      pages.push(dataset);
    }
    // Both ledgers page by when a claim was made, so either goes on after the last claim shown.
    const merged = newestFirst(pages.flatMap((listed) => listed.claims));
    const claims = merged.slice(0, page.limit);
    const last = claims.at(-1);
    const more = merged.length > page.limit || pages.some((listed) => listed.next !== null);
    return { claims, next: more && last !== undefined ? `${last.createdAtMs}:${last.claimId}` : null };
  }

  /** Every claim of one automation that either ledger keeps on this computer, newest first. Null when either ledger cannot be read. */
  private async everyClaim(automationId: string): Promise<HistoryClaim[] | null> {
    const claims: HistoryClaim[] = [];
    let before: string | undefined;
    do {
      const page = await this.claimPage(automationId, { before, limit: CLAIM_PAGE_LIMIT });
      if (page === null) return null;
      claims.push(...page.claims);
      before = page.next ?? undefined;
    } while (before !== undefined);
    return claims;
  }

  /**
   * One of an automation's claims, from the ledger that holds it: a dataset
   * Collection's own ledger first, then the engine. With `open`, opens the
   * dataset host for what a person asked. Null when a ledger cannot be read.
   */
  private async findClaim(automationId: string, claimId: string, open: boolean): Promise<LedgerClaim | "missing" | null> {
    const id = this.locate(automationId);
    if (id !== null && this.datasets.has(id.collectionPath)) {
      const inLedger = await this.withLiveHost((ledger): LedgerClaim | "missing" => {
        const claim = ledger.claim(automationId, claimId);
        if (claim === null) return "missing";
        return {
          ledger: "dataset",
          state: claim.state,
          pressedBy: claim.fact?.kind === "button" ? datasetPresser(claim) : undefined,
          neverStarted: stopOf(claim).neverStarted,
          history: datasetHistoryClaim(claim),
        };
      }, open);
      if (inLedger !== "missing") return inLedger;
    }
    const found = await this.withLiveEngine((engine) => engine.getAutomationClaim({ claimId }));
    if (found === null) return null;
    const claim = found.claim;
    if (claim === null || claim.automationId !== automationId) return "missing";
    return {
      ledger: "engine",
      state: claim.state,
      pressedBy: claim.change.kind === "button" ? claim.change.onBehalfOf : undefined,
      neverStarted: stopOf(claim).neverStarted,
      history: engineHistoryClaim(claim),
    };
  }

  private stopRuns(): void {
    this.runAbort.abort();
    this.runAbort = new AbortController();
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = null;
    // The next open expires run history again, and keeps doing so hourly.
    this.historyPrunedAtMs = null;
  }

  /** Each document Collection the engine lists once it has recorded the watcher's changes, with its Collection id. */
  private async listedCollections(): Promise<Map<string, string>> {
    await this.options.recorded?.();
    const listed = await this.options.withEngine((engine) => engine.listCollections());
    if (listed === null) throw new Error("The workspace engine is not running.");
    return new Map(listed.collections.map((collection) => [collection.path, collection.objectId]));
  }

  private async loadIndex(): Promise<void> {
    this.targetRevision += 1;
    this.collections = await this.listedCollections();
    this.files.clear();
    this.schemaFields.clear();
    for (const path of this.collections.keys()) await this.readFile(path);
    // A dataset's schedules run with the host closed, so the index opens it
    // whenever this workspace has a dataset store. It does so before the
    // schedules are noted, so one seen now is not taken as switched on now.
    const datasets = await this.datasetFolders(true);
    if (datasets !== null) this.datasets.clear();
    for (const [path, definition] of datasets ?? this.datasets) {
      if (this.collections.has(path)) continue;
      this.datasets.set(path, definition);
      await this.readFile(path);
    }
    await this.readNamedSchemas();
    this.targetRevision += 1;
  }

  /** Reads the field names of every Collection an automation names that the index lacks. */
  private async readNamedSchemas(): Promise<void> {
    for (const [collectionPath, indexed] of this.files) {
      if (indexed.file.status !== "read") continue;
      for (const entry of indexed.file.entries) {
        if (entry.status !== "valid") continue;
        for (const { collection } of fieldsNamedBy(entry.automation, collectionPath)) {
          if (this.schemaFields.has(collection)) continue;
          const fields = await this.readSchemaFields(collection);
          if (fields !== null) this.schemaFields.set(collection, fields);
        }
      }
    }
  }

  /**
   * The field names a Collection's schema defines, or the reason dohc cannot
   * read them; null when it has no schema.
   */
  private async readSchemaFields(collection: string): Promise<Set<string> | string | null> {
    const read = await this.options.readText(`${collection}/${COLLECTION_SCHEMA_FILENAME}`);
    if (read === null) return null;
    const parsed = read.truncated ? null : parseCollectionSchema(read.text);
    const versionError = parsed && collectionVersionError(parsed.reasons, `${collection}/${COLLECTION_SCHEMA_FILENAME}`);
    if (versionError) return versionError;
    // A degraded schema still lists the fields it could read; a file that is
    // not a schema at all lists none.
    const unreadable = parsed === null ||
      parsed.reasons.some((reason) => reason.code === "invalid-yaml" || reason.code === "root-not-mapping");
    return unreadable ? unreadableSchema(collection) : new Set(parsed.schema.fields.map((field) => field.name));
  }

  /**
   * Why dohc does not run an automation now, or null. A field its
   * Collection does not have keeps it off until someone fixes the file or
   * the Collection: a write would add a field nobody defined.
   */
  private cannotRun(collectionPath: string, automation: Automation): string | null {
    const unsupported = this.unsupportedIn(collectionPath, automation);
    if (unsupported !== null) return unsupported;
    for (const { collection, field } of fieldsNamedBy(automation, collectionPath)) {
      const fields = this.schemaFields.get(collection);
      if (typeof fields === "string") return fields;
      if (fields && !fields.has(field)) return `${field} is not a field in ${collectionNamed(collection).name}.`;
    }
    return null;
  }

  private async readFile(collectionPath: string): Promise<void> {
    const parsed = await this.parsedFile(collectionPath);
    // Read after the file, so the executor's own switch off, which changes
    // the index at once, is not taken for a person's.
    if (parsed === undefined) this.files.delete(collectionPath);
    else this.files.set(collectionPath, parsed);
    const collectionId = this.collectionIdOf(collectionPath);
    if (collectionId !== null && this.unprovenPaths.has(collectionPath)) this.unprovenFolders.add(collectionId);
    if (collectionId !== null && this.unprovenFolders.has(collectionId)) await this.proveFolder(collectionPath, parsed?.file);
  }

  /**
   * A Collection whose automations a take over could not list reads again.
   * Its definitions join `unproven`, each held once, and once its file reads
   * in every version it leaves `unprovenFolders`, so an automation written
   * after that runs as usual.
   */
  private async proveFolder(collectionPath: string, here: AutomationsFileParseResult | undefined): Promise<void> {
    const collectionId = this.collectionIdOf(collectionPath);
    const found = await this.automationFiles(collectionPath).catch((error: unknown) => {
      this.options.onError("list a Collection's automations in every version", error);
      return null;
    });
    await this.updateVerdicts(() => {
      if (collectionId !== null && here?.status === "read") this.addUnprovenDefinitions(collectionId, here.entries);
      const hereReads = here === undefined || (here.status === "read" && here.entries.every((entry) => entry.status === "valid"));
      const listed = found === null ? null : this.addListedDefinitions(found);
      for (const id of listed?.unread ?? []) this.unprovenFolders.add(id);
      if (hereReads && found !== null && listed?.unread.size === 0 && !found.some((file) => file.collectionId === null)) {
        this.unprovenPaths.delete(collectionPath);
        if (collectionId !== null) this.unprovenFolders.delete(collectionId);
      }
    }, true);
  }

  /**
   * Each automations file in each version, as the engine holds it, or only
   * the one in `folder`, read where it would be rather than found in each
   * version's list. A file that is not text, or text the engine did not give,
   * is null. Null when the engine is not running.
   */
  private automationFiles(folder?: string): Promise<Array<{ folder: string; collectionId: string | null; text: string | null }> | null> {
    return this.withLiveEngine(async (engine) => {
      const { workspaceId } = engine;
      const files: Array<{ folder: string; collectionId: string | null; text: string | null }> = [];
      for (const version of await engine.listVersions({ workspaceId })) {
        const datasetId = async (path: string): Promise<string | null> => {
          const descriptor = await engine.readTextFile({ workspaceId, versionId: version.id, path: `${path}/${DATASET_FILE_NAME}` });
          let data: unknown = null;
          try {
            data = descriptor?.contentKind === "text" && descriptor.text !== null ? JSON.parse(descriptor.text) : null;
          } catch {
            return null;
          }
          return typeof data === "object" && data !== null && "datasetId" in data && typeof data.datasetId === "string" ? data.datasetId : null;
        };
        let versionFolder = folder;
        if (folder !== undefined) {
          const wanted = this.collectionIdOf(folder);
          const schema = await engine.readTextFile({ workspaceId, versionId: version.id, path: `${folder}/${COLLECTION_SCHEMA_FILENAME}` });
          const isDataset = this.datasets.has(folder);
          const atPath = schema?.objectId ?? await datasetId(folder);
          if (wanted !== null && atPath !== wanted) {
            if (this.unprovenPaths.has(folder) || atPath === null) {
              const read = await engine.readTextFile({ workspaceId, versionId: version.id, path: `${folder}/${AUTOMATIONS_FILE_NAME}` });
              if (read !== null) files.push({ folder, collectionId: atPath, text: read.contentKind === "text" ? read.text : null });
            }
            const listed = await engine.listTextFileMetadata({ workspaceId, versionId: version.id });
            let found = listed.find((file) => file.objectId === wanted && posix.basename(file.path) === COLLECTION_SCHEMA_FILENAME);
            if (isDataset) {
              found = undefined;
              for (const file of listed) {
                if (posix.basename(file.path) === DATASET_FILE_NAME && await datasetId(posix.dirname(file.path)) === wanted) {
                  found = file;
                  break;
                }
              }
            }
            if (found === undefined) continue;
            versionFolder = posix.dirname(found.path);
          }
        }
        const paths = versionFolder !== undefined
          ? [`${versionFolder}/${AUTOMATIONS_FILE_NAME}`]
          : (await engine.listTextFileMetadata({ workspaceId, versionId: version.id }))
            .map((file) => file.path)
            .filter((path) => posix.basename(path) === AUTOMATIONS_FILE_NAME && posix.dirname(path) !== ".");
        for (const path of paths) {
          const read = await engine.readTextFile({ workspaceId, versionId: version.id, path });
          // A version without this Collection's file has nothing to hold.
          if (read === null && folder !== undefined) continue;
          // The engine gives a binary file as empty text, which would read as no automations.
          const collectionPath = posix.dirname(path);
          const schema = await engine.readTextFile({ workspaceId, versionId: version.id, path: `${collectionPath}/${COLLECTION_SCHEMA_FILENAME}` });
          let collectionId = schema?.objectId;
          if (collectionId === undefined) {
            collectionId = await datasetId(collectionPath) ?? undefined;
          }
          files.push({ folder: collectionPath, collectionId: collectionId ?? null, text: read?.contentKind === "text" ? read.text : null });
        }
      }
      return files;
    });
  }

  /**
   * Compares each Collection's switched-on automations with the ones this
   * computer last saved, reports each that is now off, and saves the new
   * set. The first read of a workspace only saves. A Collection this read
   * did not index, as a dataset whose host is closed, or whose file dohc
   * cannot read, keeps its saved set, so its switch off still shows later.
   */
  private async noteSwitches(): Promise<void> {
    this.enabledSaved ??= await this.options.store.readEnabledAutomations();
    const saved = this.enabledSaved;
    const next = new Map(saved ?? []);
    let changed = saved === null;
    for (const [collectionPath, indexed] of this.files) {
      const collectionId = this.collectionIdOf(collectionPath);
      if (indexed.file.status !== "read" || collectionId === null) continue;
      const valid = indexed.file.entries.flatMap((entry) => (entry.status === "valid" ? [entry.automation] : []));
      const on = valid.filter((automation) => automation.enabled).map((automation) => automation.id);
      // Saved by Collection id, so a Collection that moved keeps its set.
      const before = saved?.get(collectionId);
      for (const { id, name, enabled } of valid) {
        if (enabled || !before?.includes(id)) continue;
        this.options.onSwitchedOff({ collectionPath, id, automationId: collectionAutomationId(collectionId, id), name });
      }
      if (before !== undefined && isDeepStrictEqual(before, on)) continue;
      next.set(collectionId, on);
      changed = true;
    }
    if (!changed) return;
    this.enabledSaved = next;
    await this.options.store.saveEnabledAutomations(next);
  }

  private async parsedFile(collectionPath: string): Promise<IndexedFile | undefined> {
    const read = await this.options.readText(`${collectionPath}/${AUTOMATIONS_FILE_NAME}`);
    if (read === null) return undefined;
    return {
      file: read.truncated
        ? { status: "unreadable", diagnostic: { code: "file-too-large", path: "" } }
        : parseAutomationsFile(read.text),
      contentHash: read.contentHash,
    };
  }

  /**
   * Each dataset Collection folder, with its approved rules. Null when dohc
   * cannot run dataset automations, or the workspace has no dataset host. A
   * dataset's descriptor sits beside its schema, in its Collection's folder.
   * Store and rule errors are reported. Once identified, a folder stays
   * indexed even if its operation metadata is temporarily unavailable.
   */
  private async datasetFolders(open = false): Promise<Map<string, IndexedDataset> | null> {
    let listed: Awaited<ReturnType<DatasetAutomationHost["datasets"]>> | null;
    try {
      listed = await this.withLiveHost((host) => host.datasets(), open);
      this.datasetStoreFailed = false;
    } catch (error) {
      this.datasetStoreFailed = true;
      this.options.onError("open this workspace's dataset store", error);
      return null;
    }
    if (listed === null) return null;
    for (const { datasetId, error } of listed.failures) this.options.onError(`read dataset ${datasetId}'s rules`, error);
    const folders = new Map<string, IndexedDataset>();
    const unplaced = new Set<string>();
    for (const definition of listed.definitions) {
      const folder = posix.dirname(definition.schemaPath);
      if (folder === "." || (await this.describedDatasetId(folder)) !== definition.datasetId) {
        unplaced.add(definition.datasetId);
        continue;
      }
      // Index approved destinations even when they have no automations file.
      folders.set(folder, { definition, approved: null, generated: null, grants: { workspaceId: "", grants: [] } });
      try {
        const metadata = await this.withLiveHost((host) => ({ approved: host.revision(definition.datasetId), generated: host.generated(definition.datasetId), grants: host.dataGrants(definition.datasetId) }));
        if (metadata === null) throw new Error(`The dataset host for ${folder} is unavailable.`);
        folders.set(folder, { definition, ...metadata });
      } catch (error) {
        this.options.onError(`read dataset ${definition.datasetId}'s operations`, error);
      }
    }
    this.unplacedDatasets = unplaced;
    return folders;
  }

  /** The dataset id a folder's dataset.json names, or null. */
  private async describedDatasetId(folder: string): Promise<string | null> {
    const read = await this.options.readText(`${folder}/${DATASET_FILE_NAME}`);
    let described: unknown = null;
    try {
      described = read === null || read.truncated ? null : JSON.parse(read.text);
    } catch {
      // A descriptor that is not JSON names no dataset.
    }
    return typeof described === "object" && described !== null && "datasetId" in described && typeof described.datasetId === "string"
      ? described.datasetId
      : null;
  }

  /** Why dohc cannot run an automation in this indexed Collection yet, or null. */
  private inventory(collectionPath: string, automation: Automation): AutomationInventory {
    const cached = this.inventories.get(automation);
    if (cached?.revision === this.targetRevision && cached.chat === this.chat && cached.source === collectionPath) {
      if (cached.result instanceof Error) throw cached.result;
      return cached.result;
    }
    let result: AutomationInventory | Error;
    try { result = this.buildInventory(collectionPath, automation); }
    catch (error) { result = error instanceof Error ? error : new Error(String(error)); }
    this.inventories.set(automation, { revision: this.targetRevision, chat: this.chat, source: collectionPath, result });
    if (result instanceof Error) throw result;
    return result;
  }

  private buildInventory(collectionPath: string, automation: Automation): AutomationInventory {
    return automationInventory(automation, collectionPath, (path) => {
      const dataset = this.datasets.get(path);
      if (dataset !== undefined) {
        if (dataset.generated === null || dataset.approved === null) throw new AutomationRunWait(`The dataset host for ${path} is unavailable.`);
        return { kind: "dataset", collection: collectionNamed(path), approved: dataset.approved,
          generated: dataset.generated, grants: dataset.grants };
      }
      if (!this.collections.has(path)) throw new Error(`dohc cannot find an approved Collection at ${path}. Check its files and rules.`);
      const fields = this.schemaFields.get(path) ?? null;
      if (typeof fields === "string") throw new Error(fields);
      return { kind: "document", collection: collectionNamed(path), fields };
    }, this.chat);
  }

  private unsupportedIn(collectionPath: string, automation: Automation): string | null {
    const dataset = this.datasets.get(collectionPath);
    if (dataset !== undefined) {
      const subscription = datasetSubscriptionFor(automation, dataset.definition);
      if (subscription !== null && "problem" in subscription) return subscription.problem;
    }
    try { this.inventory(collectionPath, automation); return null; }
    catch (error) { return errorText(error); }
  }

  /** Uses the indexed destination metadata, as every reach consumer does. */
  private reachSteps(collectionPath: string, automation: Automation): ReachStep[] {
    try { return this.inventory(collectionPath, automation).reach; }
    catch (error) { return [{ kind: "unavailable", reason: errorText(error), identity: "unavailable" }]; }
  }

  private definitionFor(automationId: string): Automation | null {
    const id = this.locate(automationId);
    const indexed = id ? this.files.get(id.collectionPath) : undefined;
    if (indexed?.file.status !== "read") return null;
    const entry = indexed.file.entries.find(
      (candidate): candidate is Extract<AutomationEntry, { status: "valid" }> =>
        candidate.status === "valid" && candidate.automation.id === id?.id,
    );
    return entry?.automation ?? null;
  }

  /**
   * Whether a run may write records in a Collection: this index knows it,
   * and it keeps its records in documents, not a dataset. Each answer is
   * kept for the one question it serves.
   */
  private writableCollections(): (path: string) => Promise<boolean> {
    const datasets = new Map<string, Promise<boolean>>();
    return async (path) => {
      if (!this.collections.has(path)) return false;
      const known = datasets.get(path) ?? this.options.pathExists(`${path}/dataset.json`);
      datasets.set(path, known);
      return !(await known);
    };
  }

  /**
   * Whether a run would get past the checks it makes before its first write,
   * as far as this computer knows now: no step's saved reach verdict is
   * stopped or held, and `writable` accepts every Collection a step names.
   * Verdicts are saved at every roster listing, and a change to one raises
   * `onAutomationsChanged`.
   */
  private async canRun(
    automationId: string,
    collectionPath: string,
    automation: Automation,
    writable: (path: string) => Promise<boolean>,
  ): Promise<boolean> {
    // Saved verdicts dohc cannot read hold every run until someone resets them.
    if (this.verdictsUnreadable) return false;
    const hash = definitionHash(automation);
    const steps = this.reachSteps(collectionPath, automation);
    for (const [index, reach] of steps.entries()) {
      if (reach.kind === "unavailable") return false;
      const step = reachStepId(reach, index);
      // A stopped step fails the run, and a held one waits for a current editor.
      const verdict = this.verdicts.get(reachVerdictKey(automationId, hash, step))?.verdict;
      if (verdict === "stopped" || verdict === "held") return false;
      if ("collection" in reach && !this.datasets.has(reach.collection.path) && !(await writable(reach.collection.path))) return false;
    }
    return true;
  }

  // Records when each schedule was added or switched on, at the index read
  // that saw it, so a quick switch off and on between steps still counts.
  private noteEnabledSchedules(opening: boolean): void {
    const now = this.nowMs();
    const next = new Map<string, number | null>();
    for (const { automationId, automation } of this.everyAutomation()) {
      if (!automation.enabled || automation.when.kind !== "schedule") continue;
      const known = this.enabledSince.get(automationId);
      next.set(automationId, known !== undefined ? known : opening ? null : now);
    }
    this.enabledSince = next;
  }

  /** Every automation dohc can run, whether or not it is switched on. */
  private everyAutomation(): OwnedAutomation[] {
    const automations: OwnedAutomation[] = [];
    for (const [collectionPath, indexed] of this.files) {
      if (indexed.file.status !== "read") continue;
      for (const entry of indexed.file.entries) {
        if (entry.status !== "valid" || this.cannotRun(collectionPath, entry.automation) !== null) continue;
        const automationId = this.automationIdIn(collectionPath, entry.automation.id);
        automations.push({ automationId, collectionPath, automation: entry.automation });
      }
    }
    return automations;
  }

  private desiredSubscriptions(): Map<string, StoredSubscription> {
    const desired = new Map<string, StoredSubscription>();
    for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
      if (!automation.enabled) continue;
      const trigger = automation.when;
      // The engine claims a Group message for either kind of Collection.
      if (trigger.kind === "group-message") {
        if (!this.groupTriggersHere) continue;
        const group = this.groups?.group(trigger.group);
        if (!group || "problem" in group) continue;
        desired.set(automationId, {
          automationId, groupId: group.channelId, ...(trigger.startsWith !== null ? { startsWith: trigger.startsWith } : {}),
        });
        continue;
      }
      // A dataset's record changes claim in its own ledger.
      if (this.datasets.has(collectionPath)) continue;
      const subscription = subscriptionFor(trigger);
      if (subscription !== null) desired.set(automationId, { automationId, path: collectionPath, ...subscription });
    }
    return desired;
  }

  private desiredDatasetSubscriptions(): Map<string, { datasetId: string; subscription: DatasetAutomationSubscription }> {
    const desired = new Map<string, { datasetId: string; subscription: DatasetAutomationSubscription }>();
    for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
      const definition = this.datasets.get(collectionPath)?.definition;
      if (definition === undefined || !automation.enabled) continue;
      // A button claims when pressed, so it watches nothing.
      const watched = datasetSubscriptionFor(automation, definition);
      if (watched === null || "problem" in watched) continue;
      desired.set(automationId, { datasetId: definition.datasetId, subscription: { automationId, ...watched, definitionHash: definitionDigest(automation) } });
    }
    return desired;
  }

  /** Whether the executor wants the ledger that served this claim to keep claiming for its automation. */
  private isSubscribed(held: HeldClaim): boolean {
    return held.source === "engine"
      ? this.desiredSubscriptions().has(held.claim.automationId)
      : this.desiredDatasetSubscriptions().get(held.claim.automationId)?.datasetId === held.claim.datasetId;
  }

  /** Why a Group-message automation's Group cannot start it, or null. */
  private groupProblem(automation: Automation): string | null {
    // A Group only a draft names was never looked up, so it is unknown here, not missing.
    if (automation.when.kind !== "group-message" || !this.groupsLookedUp.has(automation.when.group)) return null;
    const group = this.groups?.group(automation.when.group);
    return group && "problem" in group ? group.problem : null;
  }

  /** Finds each Group a Group-message automation names, for its subscription. */
  private async loadGroups(): Promise<void> {
    const groups = new Set(this.everyAutomation().flatMap(({ automation }) =>
      automation.when.kind === "group-message" ? [automation.when.group] : []));
    if (groups.size === 0) return;
    try {
      // Only Groups are read, so no roster is needed.
      const directory = await this.options.chat.directory(
        { kind: "owner", ownerUserId: null, grants: [] }, { groups, people: new Set() });
      if (directory) {
        this.groups = directory;
        this.groupsLookedUp = groups;
      }
    } catch (error) {
      this.options.onError("find the Groups automations watch", error);
    }
  }

  /**
   * Runs `update` on the verdicts in order and saves them when it changed
   * any. A step that starts or stops waiting for a current editor raises
   * the hold notices once.
   */
  private updateVerdicts<T>(update: () => T, save = false): Promise<T> {
    const next = this.verdictChain.then(async () => {
      const before = this.verdictSeq;
      const result = update();
      // Nothing overwrites a file dohc could not read until someone resets it.
      if (!this.verdictsUnreadable && (save || this.verdictSeq !== before)) {
        // An edited automation starts its verdicts again, so the old
        // definition's go.
        const hashes = new Map(this.everyAutomation().map(({ automationId, automation }) => [automationId, definitionHash(automation)]));
        for (const [key, verdict] of this.verdicts) {
          const hash = hashes.get(verdict.automationId);
          if (hash !== undefined && hash !== verdict.definitionHash) this.verdicts.delete(key);
        }
        const pending = this.reachPending;
        await this.options.store.saveReachVerdicts({
          verdicts: [...this.verdicts.values()], hostRecord: this.hostRecord, unproven: [...this.unproven],
          unprovenAll: this.unprovenAll, unprovenFolders: [...this.unprovenFolders], unprovenPaths: [...this.unprovenPaths],
          pending, taken: this.reachTakenAt,
        });
        this.savedPending = pending;
        // A step that stops, waits, or runs again changes which fields its
        // automation sets.
        this.options.onAutomationsChanged();
      }
      this.publishHolds();
      return result;
    });
    this.verdictChain = next.catch(() => undefined);
    return next;
  }

  /**
   * A step with no verdict yet, in a definition this computer could not
   * take the last host's verdicts for, waits for a current editor instead
   * of running: the last host may have stopped it.
   */
  private unprovenHold(
    automationId: string,
    hash: string,
    previous: StoredReachVerdict | undefined,
    next: ReturnType<typeof nextReachVerdict>,
  ): ReturnType<typeof nextReachVerdict> {
    return previous === undefined && next.verdict === "allowed" && (this.unprovenAll ||
      this.unproven.has(definitionKey(automationId, hash)) || inUnprovenFolder(this.unprovenFolders, automationId))
      ? { verdict: "held", stoppedFor: null }
      : next;
  }

  /**
   * Every valid definition in these files joins `unproven`. Returns the
   * automation ids they name, and the Collections whose file did not read
   * or holds an entry that did not.
   */
  private addListedDefinitions(files: ReadonlyArray<{ folder: string; collectionId: string | null; text: string | null }>): { named: Set<string>; unread: Set<string> } {
    const named = new Set<string>();
    const unread = new Set<string>();
    const paths = new Set(files.filter((file) => file.collectionId === null).map((file) => file.folder));
    for (const { folder, collectionId, text } of files) {
      if (collectionId === null) {
        this.unprovenPaths.add(folder);
        const indexed = this.collectionIdOf(folder);
        if (indexed !== null) unread.add(indexed);
        continue;
      }
      if (paths.has(folder)) unread.add(collectionId);
      const file = text === null ? null : parseAutomationsFile(text);
      if (file?.status !== "read") {
        unread.add(collectionId);
        continue;
      }
      this.addUnprovenDefinitions(collectionId, file.entries);
      for (const entry of file.entries) {
        const id = entry.status === "valid" ? entry.automation.id : entry.id;
        if (id !== null) named.add(collectionAutomationId(collectionId, id));
        if (entry.status !== "valid") unread.add(collectionId);
      }
    }
    return { named, unread };
  }

  /** Every valid definition in a Collection's file joins `unproven`, whether it can run yet or not. */
  private addUnprovenDefinitions(collectionId: string, entries: Extract<AutomationsFileParseResult, { status: "read" }>["entries"]): void {
    for (const entry of entries) {
      if (entry.status === "valid") {
        this.unproven.add(definitionKey(collectionAutomationId(collectionId, entry.automation.id), definitionHash(entry.automation)));
      }
    }
  }

  /**
   * Before this computer runs anything as the automation host at a new
   * generation, it takes the verdicts the last host released. When it
   * starts with none, after a take over, it cannot prove its own are
   * current: in a workspace that was ever shared, it holds every step it
   * would allow until a current editor confirms it. Resolves false when the
   * relay did not answer, so nothing runs until it does.
   */
  private async takeHostVerdicts(generation: number | null): Promise<boolean> {
    // The host moved on before the relay answered for a generation this
    // computer hosted at: that record is gone, so the claims it made then,
    // such as a handover's last schedule runs, run under the hold instead.
    if (this.reachPending !== null && this.reachPending !== generation) {
      await this.updateVerdicts(() => {
        this.holdUnproven();
        this.reachPending = null;
      }, true);
      this.clearWaits("roster");
    }
    if (generation === null || generation === 0 || generation === this.reachTakenAt) return true;
    let record: ReachRelayRecord;
    try {
      await this.markHostClaims(generation);
      record = await this.options.reachRelayRecord(generation);
    } catch (error) {
      this.options.onError("read the last automation host's reach verdicts", error);
      return false;
    }
    await this.updateVerdicts(() => {
      this.reachPending = null;
      this.reachTakenAt = generation;
      if (record.generation === this.hostRecord) return;
      // Generations only rise at one relay. A lower one comes from a relay
      // restored from an earlier copy, which may have lost a take over.
      if (record.generation < this.hostRecord) {
        this.hostRecord = record.generation;
        if (record.everShared) this.holdUnproven();
        return;
      }
      this.hostRecord = record.generation;
      const { reach } = record;
      if (reach !== null) {
        const taken = new Map(reach.verdicts.map((verdict) =>
          [reachVerdictKey(verdict.automationId, verdict.definitionHash, verdict.step, verdict.recipient?.id), verdict]));
        for (const [key, verdict] of taken) {
          const merged = mergedReachVerdict(this.verdicts.get(key), verdict);
          if (merged) this.verdicts.set(key, { ...merged, seq: ++this.verdictSeq });
        }
        // The last host could not prove these definitions either: what only
        // this computer allowed there waits too.
        const unproven = new Set(reach.unproven);
        const folders = new Set(reach.unprovenFolders);
        for (const path of reach.unprovenPaths) {
          this.unprovenPaths.add(path);
          const id = this.collectionIdOf(path);
          if (id !== null) folders.add(id);
        }
        this.holdAllowed((key, verdict) => !taken.has(key) && (reach.unprovenAll ||
          unproven.has(definitionKey(verdict.automationId, verdict.definitionHash)) || inUnprovenFolder(folders, verdict.automationId)));
        for (const key of unproven) this.unproven.add(key);
        for (const folder of folders) this.unprovenFolders.add(folder);
        if (reach.unprovenAll) {
          this.unprovenAll = true;
          this.markEpoch += 1;
        }
      } else if (record.everShared) {
        this.holdUnproven();
      }
    }, true);
    this.clearWaits("roster", "held");
    return true;
  }

  /**
   * Before this computer makes a claim as the host: until it took the last
   * host's verdicts at its generation, that generation is saved as pending
   * first, so a claim a restart finds after the host moved on runs held.
   */
  private async markHostClaims(generation?: number | null): Promise<void> {
    const at = generation === undefined ? await this.options.groupHost() : generation;
    if (at === null || at === 0 || at === this.reachTakenAt || at === this.savedPending) return;
    // A save that fails throws, so the claim is not made.
    await this.updateVerdicts(() => {
      if (at !== this.reachTakenAt) this.reachPending = at;
    }, true);
  }

  /** Nothing proves this computer's verdicts current: hold every step it would allow until a current editor confirms it. */
  private holdUnproven(): void {
    this.holdAllowed(() => true);
    for (const { automationId, automation } of this.everyAutomation()) {
      this.unproven.add(definitionKey(automationId, definitionHash(automation)));
    }
    // A definition this computer has not read yet, such as one still on its
    // way or in a dataset not indexed here, waits too, and the listing starts
    // again: an earlier one may name a Collection that does not read now.
    this.unprovenAll = true;
    this.markEpoch += 1;
  }

  /** Whether a step waits only because its Collection's automations file does not read in some version. */
  private fileUnread(verdict: StoredReachVerdict): boolean {
    return verdict.verdict === "held" && verdict.stoppedFor === null && inUnprovenFolder(this.unprovenFolders, verdict.automationId);
  }

  /** Holds each allowed verdict `unproven` picks until a current editor confirms it. */
  private holdAllowed(unproven: (key: string, verdict: StoredReachVerdict) => boolean): void {
    for (const [key, verdict] of this.verdicts) {
      if (verdict.verdict === "allowed" && unproven(key, verdict)) {
        this.verdicts.set(key, { ...verdict, verdict: "held", stoppedFor: null, seq: ++this.verdictSeq });
      }
    }
  }

  /** Raises the reach notices when the held or stopped steps differ from what they last showed. */
  private publishHolds(): void {
    const shown = this.verdictsUnreadable
      ? ["unreadable"]
      : [
          ...this.heldUnprovenPaths().map((path) => `unidentified ${path}`),
          ...this.holds().map((hold) => `held ${reachVerdictKey(hold.automationId, hold.definitionHash, hold.step, hold.recipient)} ${hold.seq} ${hold.fileUnread}`),
          ...this.stops().map((stop) => `stopped ${reachVerdictKey(stop.automationId, stop.definitionHash, stop.step)} ${stop.seq}`),
        ].sort();
    if (isDeepStrictEqual(shown, this.publishedHolds)) return;
    this.publishedHolds = shown;
    this.options.onHoldsChanged();
  }

  /** What held these waiting claims cleared: the next drain runs them. */
  private clearWaits(...reasons: WaitReason[]): void {
    for (const [claimId, reason] of [...this.waitingFor]) {
      if (reasons.includes(reason)) this.waitingFor.delete(claimId);
    }
    this.notifyClaimed();
  }

  /**
   * Records each step's verdict under the roster. Returns whether any step
   * of these automations is held. A step that starts to wait raises its
   * notice once.
   */
  private async recordVerdicts(roster: Exclude<ReachRoster, { kind: "unknown" }>, automations?: readonly OwnedAutomation[], resolved?: readonly ReachStep[]): Promise<boolean> {
    await this.loadChat(roster);
    automations ??= this.everyAutomation();
    const owned = automations;
    const inventories = new Map<string, readonly ReachStep[]>();
    for (const { automationId, collectionPath, automation } of owned) {
      try { inventories.set(automationId, resolved ?? this.inventory(collectionPath, automation).reach); }
      catch (error) {
        if (!(error instanceof AutomationRunWait)) inventories.set(automationId, [{ kind: "unavailable", reason: errorText(error), identity: "unavailable" }]);
      }
    }
    return await this.updateVerdicts(() => {
      // Without the saved verdicts every step waits.
      if (this.verdictsUnreadable) return owned.length > 0;
      let held = false;
      for (const { automationId, collectionPath, automation } of owned) {
        const collection = collectionNamed(collectionPath);
        const hash = definitionHash(automation);
        const steps = inventories.get(automationId);
        if (steps === undefined) continue;
        checkAutomationReach(roster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collectionPath), steps }).forEach((reach, index) => {
          const step = reachStepId(steps[index]!, index);
          const key = reachVerdictKey(automationId, hash, step);
          const previous = this.verdicts.get(key);
          const next = this.unprovenHold(automationId, hash, previous, nextReachVerdict(previous, reach, automation.enabled));
          if (next.verdict === "held") held = true;
          if (sameReachVerdict(previous, next)) return;
          this.verdicts.set(key, { automationId, definitionHash: hash, step, ...next, seq: ++this.verdictSeq });
        });
      }
      return held;
    });
  }

  /**
   * Diffs the automations that can run against the engine's subscriptions.
   * `all` subscribes every one again, which heals a subscription the engine
   * lost; subscribing replaces a pair's filter, so it is safe to repeat.
   */
  private async reconcile(all: boolean): Promise<void> {
    await this.loadGroups();
    // Asked first, so a computer the relay names no host for yet claims it
    // before this decides, and does not drop its Group subscriptions only
    // to add them again. Once a host is named this waits for nothing.
    if (this.everyAutomation().some(({ automation }) => automation.enabled && automation.when.kind === "group-message")) {
      await this.options.requestHost();
    }
    // Only a computer the relay names watches Groups.
    const generation = await this.options.groupHost();
    this.groupTriggersHere = generation !== null;
    const verdictsTaken = await this.takeHostVerdicts(generation);
    const desired = this.desiredSubscriptions();
    let changed = false;
    for (const [automationId, subscription] of [...this.subscribed]) {
      if (isGroupSubscription(subscription)) continue;
      // A subscription to another path goes; the same path is replaced in place.
      const wanted = desired.get(automationId);
      if (wanted && !isGroupSubscription(wanted) && wanted.path === subscription.path) continue;
      const removed = await this.withLiveEngine((engine) =>
        engine.unsubscribeAutomation({ automationId, path: subscription.path }),
      );
      // Engine unavailable: keep the entry so the next reconcile retries it.
      if (removed === null) continue;
      this.subscribed.delete(automationId);
      changed = true;
    }
    for (const [automationId, subscription] of desired) {
      if (isGroupSubscription(subscription)) continue;
      if (!all && isDeepStrictEqual(this.subscribed.get(automationId), subscription)) continue;
      const subscribed = await this.withLiveEngine((engine) => engine.subscribeAutomation(subscription));
      if (subscribed === null) continue;
      this.subscribed.set(automationId, subscription);
      changed = true;
    }
    if (changed) await this.options.store.saveSubscriptions([...this.subscribed.values()]);
    // Group coverage moves with the verdicts: until this host took the last
    // host's, its engine watches no Groups, as off the host, so a release it
    // makes is stale and the relay keeps the last host's handover for the
    // next computer.
    await this.reconcileGroups(verdictsTaken ? generation : null, [...desired.values()].filter(isGroupSubscription), all);
    await this.reconcileDatasets(all);
  }

  /**
   * Off the host, the engine's Group subscriptions stop; on it, the engine
   * watches exactly the Groups the automations watch, taking a new host
   * generation's handover first. The engine is asked only when its set may
   * differ from the one wanted.
   */
  private async reconcileGroups(generation: number | null, wanted: GroupSubscription[], all: boolean): Promise<void> {
    const tracked = [...this.subscribed.values()].filter(isGroupSubscription);
    if (generation === null) {
      if (all || this.groupSubscriptionsUncertain || tracked.length > 0) await this.releaseEngineGroups();
      return;
    }
    const byAutomation = (left: GroupSubscription, right: GroupSubscription) => left.automationId.localeCompare(right.automationId);
    const same = isDeepStrictEqual([...tracked].sort(byAutomation), [...wanted].sort(byAutomation));
    if (all || this.groupSubscriptionsUncertain || !same || this.watchedGeneration !== generation) {
      await this.watchEngineGroups(generation, wanted);
    }
  }

  /**
   * The engine watches exactly these Groups at this host generation. A new
   * generation first needs the relay's record: the engine changes nothing
   * until it arrives, then takes a handover left here and claims each
   * stored message no host decided, in one write.
   */
  private async watchEngineGroups(generation: number, wanted: GroupSubscription[]): Promise<void> {
    // A watch may land even when its answer is lost.
    this.groupSubscriptionsUncertain = true;
    const input = {
      generation,
      subscriptions: wanted.map(({ automationId, groupId, startsWith }) =>
        startsWith === undefined ? { automationId, groupId } : { automationId, groupId, startsWith }),
    };
    let answer = await this.withLiveEngine((engine) => engine.watchAutomationGroups(input));
    if (answer?.needsHandover) {
      let relay: AutomationGroupRelayRecord;
      try {
        relay = await this.options.groupRelayRecord(generation);
      } catch (error) {
        // Nothing changed in the engine. The next sync pull asks again.
        this.handoverUnread = true;
        this.options.onError("read the Group handover", error);
        return;
      }
      this.handoverUnread = false;
      answer = await this.withLiveEngine((engine) => engine.watchAutomationGroups({ ...input, relay }));
    }
    if (answer === null || answer.needsHandover) return;
    for (const [automationId, subscription] of [...this.subscribed]) {
      if (isGroupSubscription(subscription)) this.subscribed.delete(automationId);
    }
    for (const subscription of wanted) this.subscribed.set(subscription.automationId, subscription);
    this.watchedGeneration = generation;
    this.groupSubscriptionsUncertain = false;
    await this.options.store.saveSubscriptions([...this.subscribed.values()]);
    // A replay can skip a message too.
    void this.groupMessagesArrived();
  }

  /**
   * Group messages may have reached this computer. While it runs Group
   * triggers, a message that started nothing because it was dated ahead of
   * this computer's clock, or arrived after the coverage floor passed it,
   * reaches the owner as one notice a day.
   */
  async groupMessagesArrived(): Promise<void> {
    if (this.watchedGeneration === null) return;
    let skips: Awaited<ReturnType<CollectionAutomationEngine["readAutomationGroupSkips"]>> | null;
    try {
      skips = await this.withLiveEngine((engine) => engine.readAutomationGroupSkips());
    } catch (error) {
      this.options.onError("read which Group messages started nothing", error);
      return;
    }
    if (skips === null) return;
    const newest: Array<[GroupMessagesSkipped, number | null]> = [["ahead", skips.aheadAtMs], ["late", skips.lateAtMs]];
    for (const [reason, atMs] of newest) {
      if (atMs === null || atMs <= this.groupSkipsTold[reason]) continue;
      try {
        await this.options.groupMessagesSkipped(reason, atMs);
        this.groupSkipsTold[reason] = Math.max(this.groupSkipsTold[reason], atMs);
      } catch (error) {
        this.options.onError("tell the owner which Group messages started nothing", error);
      }
    }
  }

  /**
   * Stops every Group subscription the engine holds for this workspace,
   * tracked or not, in one engine write. Answers the Group handover, or null
   * when the engine did not answer.
   */
  private async releaseEngineGroups(): Promise<AutomationReleaseGroupsResult | null> {
    // The release may land even when its answer is lost.
    this.groupSubscriptionsUncertain = true;
    const released = await this.withLiveEngine((engine) => engine.releaseAutomationGroups());
    if (released === null) return null;
    const tracked = [...this.subscribed].filter(([, subscription]) => isGroupSubscription(subscription));
    for (const [automationId] of tracked) this.subscribed.delete(automationId);
    this.watchedGeneration = null;
    this.groupSubscriptionsUncertain = false;
    if (tracked.length > 0) await this.options.store.saveSubscriptions([...this.subscribed.values()]);
    return released;
  }

  /** The same diff against the dataset ledger, which keeps its own subscriptions. */
  private async reconcileDatasets(all: boolean): Promise<void> {
    const desired = this.desiredDatasetSubscriptions();
    // A dataset store that cannot open stops only dataset automations.
    await this.withLiveHost((ledger) => {
      for (const { datasetId, ...current } of ledger.subscriptions()) {
        if (!current.automationId.startsWith(COLLECTION_AUTOMATION_PREFIX)) continue;
        const wanted = desired.get(current.automationId);
        if (wanted?.datasetId === datasetId) {
          if (!all && isDeepStrictEqual(current, wanted.subscription)) desired.delete(current.automationId);
          continue;
        }
        ledger.unsubscribe(datasetId, current.automationId);
      }
      for (const { datasetId, subscription } of desired.values()) ledger.subscribe(datasetId, subscription);
    }).catch((error: unknown) => this.options.onError("update dataset automation subscriptions", error));
  }

  private async drain(): Promise<void> {
    // This drain's lifetime: a pause or close aborts it, and nothing it
    // started writes or settles after that.
    const stop = this.runAbort.signal;
    const release: HeldClaim[] = [];
    try {
      // What the ledgers have not heard yet goes first.
      await this.payOwed(true);
      while (!stop.aborted) {
        const held = await this.nextClaim();
        if (held === null) return;
        const { claimId } = held.claim;
        // From here this drain owns the claim: it settles, waits, or is left
        // to its ledger's recovery. One that still waits goes straight back.
        const action = stop.aborted || this.waitingFor.has(claimId)
          ? { kind: "release" as const }
          : await this.execute(held, stop);
        if (action === null) continue;
        // Released at the end, so this drain does not take the claim again.
        if (action.kind === "release") {
          release.push(held);
          if (action.waitsFor) {
            this.waitingFor.set(claimId, action.waitsFor);
            if (isPress(held) && action.waitsFor !== "dataset") this.options.onPressWaiting({ claimId, reason: action.waitsFor });
          }
          continue;
        }
        this.waitingFor.delete(claimId);
        this.owed.set(claimId, { held, action });
        if (!stop.aborted) await this.payOwed(true, claimId);
      }
    } catch (error) {
      this.options.onError("drain Collection automation claims", error);
    } finally {
      for (const held of release) this.owed.set(held.claim.claimId, { held, action: { kind: "release" } });
      if (!stop.aborted) await this.payOwed(true);
    }
  }

  /** The engine's oldest pending claim, else the dataset ledger's. */
  private async nextClaim(): Promise<HeldClaim | null> {
    const claim = await this.withLiveEngine((engine) => engine.claimNextAutomation({ automationIdPrefix: COLLECTION_AUTOMATION_PREFIX }));
    if (claim !== null) return { source: "engine", claim };
    const dataset = await this.withLiveHost((ledger) => ledger.next());
    return dataset === null ? null : { source: "dataset", claim: dataset };
  }

  /**
   * Sends each owed release and settle, or only the one for `claimId`. The
   * claim stays owed while the engine gives no answer. When the engine
   * refuses and its claim list shows the claim no longer running, its
   * recovery took the claim back, so nothing is owed and nothing settled.
   */
  private async payOwed(live: boolean, claimId?: string): Promise<void> {
    for (const [id, { held, action }] of [...this.owed]) {
      if (claimId !== undefined && id !== claimId) continue;
      let answered: boolean;
      try {
        answered = (await this.answer(held, action, live)) === true;
      } catch (error) {
        // The dataset ledger refuses only an attempt that is no longer current.
        if ((held.source === "dataset" || isInvalidInputRefusal(error)) && (await this.stillRunning(held, live)) === false) {
          this.owed.delete(id);
          this.waitingFor.delete(id);
        } else {
          this.options.onError(`${action.kind} automation claim "${id}"`, error);
        }
        continue;
      }
      if (!answered) continue;
      this.owed.delete(id);
      if (action.kind === "settle" && action.input.state === "failed") this.failuresChanged();
      if (action.kind === "settle") {
        await action.settled();
        if (isPress(held)) {
          this.options.onPressSettled({
            claimId: id,
            outcome: action.outcome,
            error: action.input.state === "failed" ? errorText(action.input.error) : null,
          });
        }
      }
    }
  }

  /** Tells the claim's ledger to release or settle it. Null when that ledger is unavailable. */
  private answer(held: HeldClaim, action: ClaimAction, live: boolean): Promise<true | null> {
    const settle: SettleInput | null = action.kind === "release" ? null
      : action.input.state === "failed" ? { state: "failed", error: errorText(action.input.error) } : { state: "done" };
    if (held.source === "dataset") {
      return this.withLedger(live, (ledger) => {
        if (settle === null) ledger.release(held.claim);
        else ledger.settle(held.claim, settle);
        return true as const;
      });
    }
    const claimId = held.claim.claimId;
    return this.withEngineAt(live, async (engine) => {
      if (settle === null) await engine.releaseAutomationClaim({ claimId });
      else await engine.settleAutomationClaim(settle.state === "failed" ? { claimId, state: "failed", error: settle.error } : { claimId, state: "done" });
      return true as const;
    });
  }

  /** The engine, or at close any engine still answering. */
  private withEngineAt<T>(live: boolean, work: (engine: CollectionAutomationEngine) => Promise<T>): Promise<T | null> {
    return live ? this.withLiveEngine(work) : this.options.withEngine(work);
  }

  /** The dataset ledger, or at close any ledger still open. */
  private withLedger<T>(live: boolean, work: (ledger: DatasetAutomationHost) => T | Promise<T>): Promise<T | null> {
    return live ? this.withLiveHost(work) : this.options.withDatasetHost(work, false);
  }

  /** Whether the claim's ledger still holds this attempt as running, or null when it cannot say. */
  private async stillRunning(held: HeldClaim, live: boolean): Promise<boolean | null> {
    const { automationId, claimId } = held.claim;
    try {
      if (held.source === "dataset") {
        const found = await this.withLedger(live, (ledger) => ledger.claim(automationId, claimId));
        return found === null ? null : found.state === "running" && found.attempts === held.claim.attempts;
      }
      const found = await this.withEngineAt(live, (engine) => engine.getAutomationClaim({ claimId }));
      return found?.claim == null ? null : found.claim.state === "running";
    } catch {
      return null;
    }
  }

  /**
   * Runs one claim this drain holds, and says what the engine must hear.
   * Null leaves the claim running for the engine's recovery: a write that
   * outlived the deadline may still land.
   */
  /**
   * Whether an engine claim may be this document Collection's, now at
   * `collectionPath`. A press names only its automation. An added or changed
   * record runs only if the Collection holds it now, which the run reads
   * first, so a claim made before the Collection moved runs here, and one
   * from a Collection inside this folder, which the subscription's path also
   * covers, starts nothing. A removed record cannot be read: it counts only
   * where the Collection is now, because a move takes every record out of
   * the old path.
   */
  private inDocumentCollection(claim: AutomationClaim, collectionPath: string): boolean {
    if (claim.collectionPath === null) return claim.change.kind === "button";
    return claim.change.kind !== "removed" || claim.collectionPath === collectionPath;
  }

  /** Whether a claim's run saved steps it has not finished: it resumes wherever its Collection is now. */
  private async hasSavedPlan(claim: Pick<AutomationClaim, "automationId" | "claimId">): Promise<boolean> {
    const { runs } = await this.options.store.runsOf(claim.automationId, claim.claimId);
    return runs.some((run) => run.outcome?.state !== "done" && !run.superseded);
  }

  private async execute(held: HeldClaim, stop: AbortSignal): Promise<ClaimAction | null> {
    try {
      return await this.executeHeld(held, stop);
    } catch (error) {
      this.options.onError(`run automation claim "${held.claim.claimId}"`, error);
      return { kind: "release" };
    }
  }

  private async executeHeld(held: HeldClaim, stop: AbortSignal): Promise<ClaimAction | null> {
    const release = { kind: "release" } as const;
    const { claim } = held;
    if (this.changing.has(claim.claimId)) return release;
    // Found by its Collection id, so a claim made before its Collection
    // moved runs where the Collection is now.
    const id = this.locate(claim.automationId);
    // The definition is read before the roster: a pull that lands while the
    // roster lists cannot bring a step from an editor the roster lacks.
    const automation = this.definitionFor(claim.automationId);
    const definition = id ? this.datasets.get(id.collectionPath)?.definition : undefined;
    // A due time or a Group message names only its Collection, of either kind.
    const recordless = held.source === "engine" && (held.claim.change.kind === "schedule" || held.claim.change.kind === "message");
    const inCollection = id !== null && (held.source === "engine"
      ? recordless || (definition === undefined &&
        (this.inDocumentCollection(held.claim, id.collectionPath) || await this.hasSavedPlan(held.claim)))
      : definition?.datasetId === held.claim.datasetId);
    // A due time or a message for a dataset whose store failed to open, or
    // whose folder's descriptor no longer names it, waits for the dataset
    // instead of being lost.
    const collectionId = parseCollectionAutomationId(claim.automationId)?.collectionId;
    if (recordless && id === null && collectionId !== undefined && this.waitsForDataset(collectionId)) {
      this.datasetWaits.set(claim.claimId, collectionId);
      void this.enqueue(() => this.indexDatasets(true))
        .catch((error: unknown) => this.options.onError("open this workspace's dataset store", error));
      return { kind: "release", waitsFor: "dataset" };
    }
    if (id === null || automation === null || !automation.enabled || !inCollection) {
      // The automation is gone or off, so its subscription is stale.
      if (id !== null && !this.isSubscribed(held)) void this.enqueue(() => this.dropStaleSubscription(held));
      return { kind: "settle", input: { state: "done" }, outcome: "skipped", settled: () => this.afterSettle() };
    }
    // A record change or a press on a dataset cannot start an automation
    // that now starts on a schedule or a Group message, as a document's
    // change that no longer matches its trigger starts nothing.
    if (held.source === "dataset" && !("table" in automation.when)) {
      return { kind: "settle", input: { state: "done" }, outcome: "skipped", settled: () => this.markSettled(claim, automation) };
    }
    // A relayed press runs only the automation its presser saw, and only in
    // the folder the relay allowed it in, however long it waited.
    const bound = held.source === "engine" ? boundPress(held.claim) : null;
    if (bound !== null && bound.definition !== definitionHash(automation) && automation.when.kind === "button") {
      return { kind: "settle", input: { state: "failed", error: changedSincePressed(automation.when.field) }, outcome: "failed", settled: () => this.afterSettle() };
    }
    if (bound !== null && bound.place !== placeHash(id.collectionPath)) {
      return { kind: "settle", input: { state: "failed", error: MOVED_SINCE_PRESSED }, outcome: "failed", settled: () => this.afterSettle() };
    }
    // A claim this version cannot run, or that names a field its Collection
    // lacks, fails with the reason the panel shows, so it reaches the failure
    // notice and Try again runs it once that is fixed.
    if (this.datasets.get(id.collectionPath)?.generated === null) {
      this.datasetWaits.set(claim.claimId, id.collectionPath);
      return { kind: "release", waitsFor: "dataset" };
    }
    const resuming = await this.hasSavedPlan(claim);
    if (!resuming) {
      try { this.inventory(id.collectionPath, automation); }
      catch (error) {
        if (error instanceof AutomationRunWait) {
          this.datasetWaits.set(claim.claimId, collectionId ?? id.collectionPath);
          return { kind: "release", waitsFor: "dataset" };
        }
      }
      const unsupported = this.cannotRun(id.collectionPath, automation);
      if (unsupported !== null) {
        return { kind: "settle", input: { state: "failed", error: unsupported }, outcome: "failed", settled: () => this.afterSettle() };
      }
    }
    // Every step needs the roster, even one inside the Collection: someone
    // with Edit on the file alone is an editor who cannot edit its records.
    const roster = await this.options.roster();
    if (stop.aborted) return release;
    if (roster.kind === "unknown") {
      // A step that acts as you needs to know who you are now; waiting could
      // mean waiting for a sign-in, so it fails with the reason instead.
      if (wakesAgent(automation)) {
        const collection = collectionNamed(id.collectionPath);
        const steps = this.reachSteps(id.collectionPath, automation);
        const stopped = checkAutomationReach(roster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, id.collectionPath), steps })
          .find((reach) => !reach.allowed);
        const error = stopped && !stopped.allowed ? stopped.reason : "dohc could not check who can edit this Collection.";
        return { kind: "settle", input: { state: "failed", error }, outcome: "failed", settled: () => this.afterSettle() };
      }
      return { kind: "release", waitsFor: "roster" };
    }
    // The host runs nothing until it took the last host's verdicts.
    if (!(await this.takeHostVerdicts(await this.options.groupHost()))) return { kind: "release", waitsFor: "roster" };
    // The coordinator follows saved destinations before it records reach.
    if (stop.aborted) return release;
    // A relayed press runs only on the computer that still runs the
    // workspace's automations, and holds off a handover while its run
    // writes, new or resumed after a restart. After a handover it runs
    // nowhere. A claim that waits never gets here, so it holds nothing.
    let hostHold: (() => void) | undefined;
    if (bound !== null && this.options.holdForHost) {
      const taken = this.options.holdForHost();
      if (taken === null) {
        return {
          kind: "settle",
          input: { state: "failed", error: "This workspace's automations moved to another computer before this press ran." },
          outcome: "failed",
          settled: () => this.afterSettle(),
        };
      }
      hostHold = taken;
    }
    const collection = collectionNamed(id.collectionPath);
    const runner = runnerOf(held, definition?.datasetId);
    const outcome = await this.runWithDeadline(claim.claimId, stop, (signal) => runner.kind === "document"
      ? runCollectionAutomation(this.runDependencies({ automationId: claim.automationId, collectionPath: collection.path, automation }), { claim: runner.claim, automation, collection, roster, signal, stopped: stop })
      : runDatasetAutomation({ ...this.runDependencies({ automationId: claim.automationId, collectionPath: collection.path, automation }), withHost: (work) => this.withLiveHost(work), cachedRoster: () => this.options.cachedRoster() },
        { held: runner.held, automation, collection, roster, signal, stopped: stop }), hostHold);
    if (outcome === null) return null;
    // A pause or close stopped the run; its progress is saved, and the next
    // drain resumes it.
    if (stop.aborted) return release;
    switch (outcome.kind) {
      case "wait":
        // A synced workspace with no session waits for one: a post written
        // now would reach nobody.
        if (outcome.reason === "session") return { kind: "release", waitsFor: "session" };
        if (outcome.reason === "held") return { kind: "release", waitsFor: "held" };
        if (outcome.reason === "roster") return { kind: "release", waitsFor: "roster" };
        if (outcome.reason !== "busy") return release;
        this.scheduleBusyRetry();
        return { kind: "release", waitsFor: "busy" };
      case "done":
      case "skipped":
        await this.countTimeout(claim.automationId, false);
        return { kind: "settle", input: { state: "done" }, outcome: outcome.kind, settled: () => this.markSettled(claim, automation) };
      case "failed-before":
        // Its run was counted when it failed.
        return { kind: "settle", input: { state: "failed", error: outcome.error }, outcome: "failed", settled: () => this.afterSettle() };
      case "failed": {
        let error = outcome.error;
        if (await this.countTimeout(claim.automationId, outcome.timedOut) >= TIMEOUTS_BEFORE_SWITCH_OFF) {
          const note = await this.switchOff(id.collectionPath, automation, stop);
          if (note === null) return release;
          error = `${error} ${note}`;
        }
        return { kind: "settle", input: { state: "failed", error }, outcome: "failed", settled: () => this.afterSettle() };
      }
    }
  }

  /**
   * Counts a run that timed out, or clears the count, and returns it. The
   * count stays until the automation is switched off.
   */
  private async countTimeout(automationId: string, timedOut: boolean): Promise<number> {
    const count = timedOut ? (this.timeouts.get(automationId) ?? 0) + 1 : 0;
    if (count === (this.timeouts.get(automationId) ?? 0)) return count;
    if (count === 0) this.timeouts.delete(automationId);
    else this.timeouts.set(automationId, count);
    await this.options.store.saveTimeouts(this.timeouts);
    return count;
  }

  /** The engine has the claim as done, so its saved run can leave run history in time. */
  private async markSettled(claim: Pick<AutomationClaim, "automationId" | "claimId">, automation: Automation): Promise<void> {
    try {
      const runs = await runsForClaim(this.options.store, claim, automation);
      if (!runs.unreadable && runs.done && !runs.done.settled) await this.options.store.updateState(runs.done, { settled: true });
    } catch (error) {
      this.options.onError(`record automation claim "${claim.claimId}" as done`, error);
    }
    void this.pruneHistory();
  }

  /**
   * Expires run history past 30 days in both ledgers, except each
   * automation's newest failure, then in the saved runs: at open, then at
   * most hourly after a run settles or while the workspace stays open, for
   * every automation, including those whose definitions were deleted. A run
   * an unfinished Undo still names stays. The ledgers expire nothing while
   * the list of unfinished Undos cannot be read. Each call to a ledger
   * expires one batch in its own transaction, and each call to the run store
   * reads one batch of saved runs.
   */
  private pruneHistory(): Promise<void> {
    const now = this.nowMs();
    // A settle paid while the workspace closes starts no pass and no timer.
    if (this.state !== "open") return this.historyPruning;
    if (this.historyPrunedAtMs !== null && now - this.historyPrunedAtMs < HISTORY_PRUNE_INTERVAL_MS) return this.historyPruning;
    this.historyPrunedAtMs = now;
    // An automation that stopped running expires too, while the workspace stays open.
    if (this.historyTimer) clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null;
      this.historyPrunedAtMs = null;
      if (this.state === "open") void this.pruneHistory();
    }, HISTORY_PRUNE_INTERVAL_MS);
    this.historyTimer.unref?.();
    // A pass an engine restart or a close left stops at its next batch.
    const generation = this.generation;
    this.historyPruning = this.historyPruning
      .then(() => this.expireHistory(generation))
      .catch((error: unknown) => this.options.onError("expire automation run history", error));
    return this.historyPruning;
  }

  private async expireHistory(generation: number): Promise<void> {
    const current = () => this.generation === generation && this.state === "open";
    // Runs one batch, which an Undo waits for; the event loop runs after it.
    const batch = async <T>(work: Promise<T>): Promise<T> => {
      this.historyBatch = work.catch(() => undefined);
      const done = await work;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return done;
    };
    // Read again before each batch: an Undo or Try again under way keeps its claim too.
    const keep = async () => {
      const undoing = await this.options.store.unfinishedUndos();
      if (undoing === null) return null;
      const kept = [...new Set([...undoing, ...this.changing])];
      if (kept.length > MAX_HISTORY_KEEP) {
        throw new Error(`${kept.length} runs have an unfinished Undo or change, more than the ${MAX_HISTORY_KEEP} a prune can keep, so run history keeps everything until some finish.`);
      }
      return kept;
    };
    // Each batch is its own transaction; the event loop runs between them.
    const batches = async (prune: (keep: string[]) => Promise<{ more: boolean } | null>) => {
      for (let more = true; more && current();) {
        const kept = await keep();
        if (kept === null || !current()) return;
        more = (await batch(prune(kept)))?.more === true;
      }
    };
    await batches((kept) => this.withLiveEngine((engine) => engine.pruneAutomationHistory({ keep: kept })));
    await batches((kept) => this.withLiveHost((host) => host.pruneHistory(kept)));
    // Saved runs last, so a failed claim's runs stay until its ledger lets it go.
    const now = this.nowMs();
    let from: string | null = null;
    while (current()) {
      from = await batch(this.options.store.expire(now, (claim) => this.standingOf(claim, current), from));
      if (from === null) break;
    }
  }

  /** After a run settles, run history expires, at most hourly, without holding up the drain. */
  private async afterSettle(): Promise<void> {
    void this.pruneHistory();
  }

  /**
   * What the ledgers say of a claim whose saved runs expiry weighs. An Undo
   * or Try again changing it keeps it open.
   */
  private async standingOf(claim: ExpiringClaim, current: () => boolean): Promise<ClaimStanding> {
    if (this.changing.has(claim.claimId)) return "open";
    // A pass the workspace closed under asks no ledger, even one it waited
    // for: each ledger is asked only once it is at hand.
    const dataset = await this.withLiveHost((ledger) => (current() ? { held: ledger.claim(claim.automationId, claim.claimId) } : "stale"));
    if (dataset === "stale") return "unknown";
    // Only a dataset Collection's claim can be in its dataset's ledger, which cannot say while its host is closed.
    if (dataset === null && claim.datasetId !== null) return "unknown";
    let state = dataset?.held?.state;
    if (state === undefined) {
      const engine = await this.withLiveEngine(async (live) => (current() ? await live.getAutomationClaim({ claimId: claim.claimId }) : "stale"));
      if (engine === null || engine === "stale") return "unknown";
      if (engine.claim === null) return "gone";
      state = engine.claim.state;
    }
    return state === "pending" || state === "running" ? "open" : "settled";
  }

  /**
   * The run, with a deadline that aborts the signal every write receives.
   * The claim settles only after the run has returned, so no write lands
   * after it. Null when the executor stopped, or when a write outlived the
   * deadline's grace: the claim stays running for the engine's recovery.
   */
  private async runWithDeadline(
    claimId: string,
    stopped: AbortSignal,
    runClaim: (signal: AbortSignal) => Promise<CollectionAutomationRunOutcome>,
    /** Called once the run's writes have really stopped. */
    onStopped?: () => void,
  ): Promise<CollectionAutomationRunOutcome | null> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    let started = false;
    stopped.addEventListener("abort", abort, { once: true });
    const cancelDeadline = (this.options.deadline ?? startDeadline)(abort);
    let grace: ReturnType<typeof setTimeout> | undefined;
    const outlived = new Promise<"outlived">((resolve) => {
      controller.signal.addEventListener("abort", () => {
        grace = setTimeout(() => resolve("outlived"), DEADLINE_GRACE_MS);
      }, { once: true });
    });
    try {
      const run = Promise.resolve().then(() => runClaim(controller.signal)).catch((error: unknown): CollectionAutomationRunOutcome => ({
        kind: "failed",
        error: errorText(error),
        timedOut: controller.signal.aborted,
      }));
      // The hold ends only when the run's writes have really stopped, even
      // after the deadline's grace, or a close, gave up waiting for them.
      started = true;
      void run.finally(() => onStopped?.());
      const outcome = await Promise.race([run, outlived]);
      if (outcome === "outlived") {
        this.options.onError(`run automation claim "${claimId}"`, new Error("A write did not stop after the deadline."));
        return null;
      }
      return outcome;
    } finally {
      cancelDeadline();
      clearTimeout(grace);
      stopped.removeEventListener("abort", abort);
      if (!started) onStopped?.();
    }
  }

  /**
   * Keeps each formula-named person's verdict under the roster, as
   * recordVerdicts does for steps. A person an editor's leaving allowed
   * waits for Allow.
   */
  private async recipientVerdicts(input: Parameters<CollectionAutomationRunDependencies["recipientVerdicts"]>[0]) {
    return await this.updateVerdicts(() => input.recipients.map(({ step: ordinal, id, name, action, reach }) => {
      const step = String(ordinal);
      // Without the saved verdicts every step waits.
      if (this.verdictsUnreadable) return "held" as const;
      const key = reachVerdictKey(input.automationId, input.definitionHash, step, id);
      const previous = this.verdicts.get(key);
      const next = this.unprovenHold(input.automationId, input.definitionHash, previous, nextReachVerdict(previous, reach, true));
      if (!sameReachVerdict(previous, next)) {
        this.verdicts.set(key, {
          automationId: input.automationId, definitionHash: input.definitionHash, step,
          recipient: { id, name, action }, ...next, seq: ++this.verdictSeq,
        });
      }
      return next.verdict;
    }));
  }

  /** Finds where automations post again, when any automation does. */
  private async loadChat(roster: Exclude<ReachRoster, { kind: "unknown" }>): Promise<void> {
    const sending = [...this.files.values()].flatMap((indexed) => indexed.file.status === "read"
      ? indexed.file.entries.flatMap((entry) => entry.status === "valid" ? [entry.automation] : []) : [])
      .filter((automation) => sendsMessages(automation) || automation.when.kind === "group-message");
    if (sending.length === 0) return;
    try {
      this.chat = (await this.options.chat.directory(roster, chatNeedsOf(sending))) ?? this.chat;
    } catch (error) {
      this.options.onError("read where automations post", error);
    }
  }

  private targetResolver() {
    return createAutomationTargets({
      readText: this.options.readText,
      revisionOf: () => this.targetRevision,
      readSchemaFields: (path) => this.readSchemaFields(path),
      isCollection: (path) => this.collections.has(path),
      withHost: (work) => this.withLiveHost(work),
    });
  }

  private runDependencies(owned?: OwnedAutomation): CollectionAutomationRunDependencies {
    return {
      targets: this.targetResolver(),
      withHost: (work) => this.withLiveHost(work),
      cachedRoster: () => this.options.cachedRoster(),
      checkReach: async (steps, roster) => {
        return owned === undefined ? false : this.recordVerdicts(roster, [owned], steps);
      },
      withReads: (work) => this.withLiveEngine(work),
      withRecordWrites: this.options.withRecordWrites,
      collectionIdOf: (path) => this.collections.get(path) ?? null,
      collectionPathOf: (collectionId) => this.collectionPathOf(collectionId),
      readCode: async (path) => {
        const read = await this.options.readText(path);
        return read === null ? null : { text: read.text, truncated: read.truncated };
      },
      personName: this.options.personName,
      evaluator: this.options.evaluator,
      store: this.options.store,
      nowMs: this.nowMs,
      chat: this.options.chat,
      readMessageBody: this.options.readMessageBody,
      recipientVerdicts: (input) => this.recipientVerdicts(input),
      postNotice: this.options.postNotice,
    };
  }

  private scheduleBusyRetry(): void {
    if (this.busyTimer) return;
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      this.clearWaits("busy");
    }, BUSY_RETRY_MS);
    this.busyTimer.unref?.();
  }

  /**
   * Writes `enabled: false` for an automation whose runs keep timing out,
   * so it cannot hold the workspace's drain. The index takes the change at
   * once, so a claim already waiting does not run it again. Returns the
   * sentence the failure notice adds, or null when a pause or close stopped
   * the run before the write.
   */
  private async switchOff(collectionPath: string, automation: Automation, stop: AbortSignal): Promise<string | null> {
    const path = `${collectionPath}/${AUTOMATIONS_FILE_NAME}`;
    const name = `"${automation.name}"`;
    try {
      const read = await this.options.readText(path);
      const parsed = read && !read.truncated ? parseAutomationsFile(read.text) : null;
      if (read && !read.truncated && parsed?.status === "read") {
        const off = (entries: readonly AutomationEntry[]) => entries.map((entry): AutomationEntry =>
          entry.status === "valid" && entry.automation.id === automation.id
            ? { status: "valid", automation: { ...entry.automation, enabled: false } }
            : entry);
        const written = writeAutomationsFile(off(parsed.entries));
        if (stop.aborted) return null;
        const automationId = this.automationIdIn(collectionPath, automation.id);
        if (written.status === "ok" && (await this.options.writeText(path, written.text, read.contentHash, automationId)).status === "written") {
          this.timeouts.delete(automationId);
          await this.options.store.saveTimeouts(this.timeouts);
          const indexed = this.files.get(collectionPath);
          if (indexed?.file.status === "read") {
            this.files.set(collectionPath, { ...indexed, file: { status: "read", entries: off(indexed.file.entries) } });
          }
          // Its own switch off is no person's, so no notice names one.
          const saved = this.enabledSaved?.get(collectionPath);
          if (saved?.includes(automation.id)) {
            this.enabledSaved!.set(collectionPath, saved.filter((id) => id !== automation.id));
            await this.options.store.saveEnabledAutomations(this.enabledSaved!);
          }
          return `dohc switched off ${name} after ${TIMEOUTS_BEFORE_SWITCH_OFF} runs in a row took too long. Fix it, then switch it on again.`;
        }
      }
    } catch (error) {
      this.options.onError(`switch off automation "${automation.id}"`, error);
    }
    return `${name} took too long ${TIMEOUTS_BEFORE_SWITCH_OFF} times in a row, and dohc could not switch it off. Switch it off in ${path}.`;
  }

  private async dropStaleSubscription(held: HeldClaim): Promise<void> {
    if (this.isSubscribed(held)) return;
    const { automationId } = held.claim;
    if (held.source === "dataset") {
      await this.withLiveHost((ledger) => ledger.unsubscribe(held.claim.datasetId, automationId));
      return;
    }
    // A Group's subscriptions go as a whole at the next reconcile.
    if (held.claim.change.kind === "message") return;
    const stored = this.subscribed.get(automationId);
    const path = stored && !isGroupSubscription(stored) ? stored.path : held.claim.collectionPath;
    if (path === null) return;
    const removed = await this.withLiveEngine((engine) => engine.unsubscribeAutomation({ automationId, path }));
    if (removed !== null && this.subscribed.delete(automationId)) {
      await this.options.store.saveSubscriptions([...this.subscribed.values()]);
    }
  }
}

const unreadableSchema = (collection: string) =>
  `dohc cannot read the fields of ${collectionNamed(collection).name}. Fix ${collection}/${COLLECTION_SCHEMA_FILENAME} to run this automation.`;

type RecordSubscription = Extract<StoredSubscription, { path: string }>;
type GroupSubscription = Extract<StoredSubscription, { groupId: string }>;
const isGroupSubscription = (subscription: StoredSubscription): subscription is GroupSubscription => "groupId" in subscription;

function reachDestination(reach: ReachStep): Pick<CollectionAutomationHold, "target" | "action"> | null {
  return reach.kind === "post"
    ? { target: reach.group.name, action: "post" as const }
    : reach.kind === "read-group"
      ? { target: reach.group.name, action: "read" }
    : reach.kind === "notify"
      ? { target: reach.person.name, action: "notify" }
    : reach.kind === "personal"
      ? { target: "your agent", action: "wake" }
    : "collection" in reach
      ? { target: reach.collection.name, action: reach.kind === "find-records" || reach.kind === "dataset-field" ? "find" as const : "change" as const }
      : null;
}
