import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseAutomationsFile,
  writeAutomationsFile,
  type Automation,
  type AutomationDiagnostic,
  type AutomationEntry,
  type AutomationsFileParseResult,
} from "@dohc/workspace-contracts/automations";
import { COLLECTION_SCHEMA_FILENAME, type CollectionListResult } from "@dohc/workspace-contracts/collection";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import type { DatasetAutomationClaim, DatasetAutomationFailure, DatasetAutomationSubscription } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import type { WatcherEvent } from "@dohc/workspace-core";
import {
  isInvalidInputRefusal,
  type AutomationChangeKind,
  type AutomationClaim,
  type AutomationClaimSummary,
} from "@dohc/workspace-engine-client";
import type { AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import {
  collectionAutomationId,
  COLLECTION_AUTOMATION_PREFIX,
  datasetSubscriptionFor,
  definitionDigest,
  definitionHash,
  fieldWritesOf,
  fieldsNamedBy,
  parseCollectionAutomationId,
  reachStepsOf,
  subscriptionFor,
  unsupportedReason,
} from "./automationPlan";
import {
  checkAutomationReach,
  shareImpactOf,
  type ReachCollection,
  type ReachRoster,
  type ReachShare,
} from "./automationReach";
import type { AutomationRunStore, RunWrite, StoredRun, StoredSubscription } from "./automationRunStore";
import {
  runCollectionAutomation,
  runsForClaim,
  UNDONE_RUN_ERROR,
  UNREADABLE_RUN_ERROR,
  type CollectionAutomationReads,
  type CollectionAutomationRunDependencies,
  type CollectionAutomationRunOutcome,
} from "./collectionAutomationRun";
import { undoCollectionAutomationRuns, type CollectionAutomationUndone } from "./collectionAutomationUndo";
import { datasetAutomationProblem, pinDatasetOperations } from "./datasetAutomationPlan";
import { datasetReachSteps, runDatasetAutomation, type DatasetRunHost } from "./datasetAutomationRun";
import { nextReachVerdict, reachVerdictKey, type StoredReachVerdict } from "./reachVerdicts";

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
// It shares the engine with the plugin executor until plugins are removed.
// Each drains only its own namespace.
//
// A dataset Collection's claims come from its dataset host's ledger instead,
// where the host claims each commit it makes (ADR 0011). The drain takes
// engine claims first, then dataset claims, one at a time, and treats both
// the same way; a dataset run's steps go through the dataset's approved
// operations (datasetAutomationRun.ts). The executor uses the dataset host
// only while something else has it open, as the Collections list does, or
// when a person asks about a dataset's automations. A workspace whose
// datasets nobody uses never opens it for automations.

export const AUTOMATIONS_FILE_NAME = "automations.yaml";
const DATASET_FILE_NAME = "dataset.json";
const WATCHED_FILES = new Set([AUTOMATIONS_FILE_NAME, "collection.yaml", DATASET_FILE_NAME]);
const DATASET_NOT_APPROVED = "This Collection's rules are not approved yet, so its automations cannot run.";

const AUTOMATION_RUN_DEADLINE_MS = 5 * 60_000;
// After the deadline, a run's writes stop at their next check. A write
// still running after this long is not settled at all, so nothing can land
// after the claim settles; the engine's recovery requeues the claim.
const DEADLINE_GRACE_MS = 30_000;
// Runs that time out this many times in a row switch their automation off.
export const TIMEOUTS_BEFORE_SWITCH_OFF = 3;
// A claim the evaluator had no room for runs again after this long, if
// nothing else wakes the drain first.
const BUSY_RETRY_MS = 2_000;
// The engine bounds a settle error at 4096 bytes; stay well under it.
const MAX_SETTLE_ERROR_CHARS = 1000;

/** The engine RPC subset the executor drives. VersionedLiveAdapter satisfies it. */
export interface CollectionAutomationEngine extends CollectionAutomationReads {
  listCollections(): Promise<CollectionListResult>;
  subscribeAutomation(input: {
    automationId: string;
    path: string;
    kinds: AutomationChangeKind[];
    fields?: string[];
  }): Promise<unknown>;
  unsubscribeAutomation(input: { automationId: string; path: string }): Promise<unknown>;
  claimNextAutomation(input: { automationIdPrefix: string }): Promise<AutomationClaim | null>;
  settleAutomationClaim(input: { claimId: string; state: "done" | "failed"; error?: string }): Promise<unknown>;
  retryAutomationClaim(input: { claimId: string }): Promise<AutomationClaimSummary>;
  listAutomationClaims(input: { automationId: string }): Promise<{ claims: AutomationClaimSummary[] }>;
  /** Each automation's newest failed claim, the one its failure notice offers to try again. */
  listAutomationFailures(): Promise<{ failures: Array<{ automationId: string; claimId: string }> }>;
  /** Hands a running claim this computer holds back to pending, without counting an attempt. */
  releaseAutomationClaim(input: { claimId: string }): Promise<unknown>;
}

/** The dataset host's automation surface, as the executor drives it. LocalDatasetHost's `automations` satisfies it. */
export interface DatasetAutomationHost extends DatasetRunHost {
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
  /** One automation's newest claims, newest first. */
  claims(automationId: string): DatasetAutomationClaim[];
  /** One of an automation's claims however old, or null. */
  claim(automationId: string, claimId: string): DatasetAutomationClaim | null;
  failures(): DatasetAutomationFailure[];
}

export interface CollectionAutomationsOptions {
  /** Engine adapter runner; resolves null when the engine is unavailable. */
  withEngine<T>(work: (engine: CollectionAutomationEngine) => Promise<T>): Promise<T | null>;
  withRecordWrites: CollectionAutomationRunDependencies["withRecordWrites"];
  /** A workspace text file, or null when it does not exist. */
  readText(relativePath: string): Promise<
    { text: string; truncated: false; contentHash: string } | { text: string; truncated: true; contentHash: null } | null
  >;
  /** Replaces a text file whose content still hashes to `expectedContentHash`. */
  writeText(relativePath: string, text: string, expectedContentHash: string): Promise<{ status: "written" | "conflict" }>;
  pathExists(relativePath: string): Promise<boolean>;
  /** Who can edit what in this workspace, listed again when stale, for a run's reach check. */
  roster(): Promise<ReachRoster>;
  /** What the roster says now, without listing again, for showing reach. */
  cachedRoster(): Promise<ReachRoster>;
  evaluator: AutomationFormulaEvaluator;
  store: AutomationRunStore;
  /** A claim settled failed, or a retry cleared one: the failure notices re-read. */
  onFailuresChanged(): void;
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
/** A dataset Collection's approved rules, and whether dohc generated its operations. */
type IndexedDataset = { definition: DatasetDefinition; generated: boolean };

/** One step's reach as the ⚡ panel shows it. */
export type CollectionAutomationStepReach =
  | { verdict: "allowed" }
  | { verdict: "stopped"; reason: string }
  // Allowed now, but stopped before under the same definition: it waits
  // for a current editor to confirm it with `seq`. `target` is the
  // Collection the step reaches.
  | { verdict: "held"; stoppedFor: string | null; seq: number; target: string; action: "change" | "find" };

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

export type CollectionAutomationsFile =
  | { status: "missing" }
  | { status: "unreadable"; diagnostic: AutomationDiagnostic }
  | { status: "read"; contentHash: string | null; automations: CollectionAutomationSummary[] };

/** One field that switched-on automations set, with their names in file order. */
export interface CollectionFieldMark {
  field: string;
  automations: string[];
}

/** A Collection a step can reach, or why it cannot, for the builder. */
export interface CollectionAutomationTarget {
  path: string;
  name: string;
  stopped: string | null;
}

/**
 * A step whose reach changed, for its notice: one that waits for a current
 * editor to allow it, or one a narrower share stopped.
 */
export interface CollectionAutomationHold {
  automationId: string;
  automationName: string;
  definitionHash: string;
  step: number;
  seq: number;
  /** The Collection the automation belongs to, and the one the step reaches. */
  collection: string;
  target: string;
  action: "change" | "find";
  /** The editor whose reach stopped the step. */
  stoppedFor: string | null;
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
  /** The Collection the step reaches, by the name the UI shows. */
  target: string;
  action: "change" | "find";
}

export interface CollectionAutomationRun {
  claimId: string;
  state: AutomationClaimSummary["state"];
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  /** What the run's effects did on this computer, oldest first. */
  writes: RunWrite[];
  /** The run began under another version of the automation. */
  definitionChanged: boolean;
  /** The chain depth cap stopped it before it ran, so Try again cannot run it. */
  chainStopped: boolean;
  /** A person undid what it changed. */
  undone: boolean;
}

export type CollectionAutomationRetry =
  | { status: "queued" }
  // The automation changed since the run began. Running it again starts
  // from the beginning and can repeat what it already did, so the person
  // must choose that.
  | { status: "definition-changed" }
  // The run failed so long ago that dohc dropped its progress. Running it
  // again starts from the beginning, and the person must choose that too.
  | { status: "progress-gone" }
  | { status: "refused"; reason: string };

export type CollectionAutomationUndo =
  | ({ status: "undone" } & CollectionAutomationUndone)
  | { status: "refused"; reason: string };

const BUSY_CLAIM_REFUSAL = "dohc is already changing this run. Try again in a moment.";

/**
 * What runs did, oldest first. A record a run created before it stopped
 * has no write yet, so it is listed from `created`, once.
 */
function writesOf(runs: readonly StoredRun[]): RunWrite[] {
  const writes = runs.flatMap((run) => run.applied.flatMap((effect) => effect.writes));
  const listed = new Set(writes.flatMap((write) => (write.kind === "created" ? [write.recordId] : [])));
  for (const run of runs) {
    for (const created of run.created) {
      if (listed.has(created.recordId)) continue;
      listed.add(created.recordId);
      writes.push({ kind: "created", recordId: created.recordId, path: created.path });
    }
  }
  return writes;
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

function collectionNamed(path: string): ReachCollection {
  return { path, name: path.split("/").at(-1) ?? path };
}

type OwnedAutomation = { automationId: string; collectionPath: string; automation: Automation };

type SettleInput = { state: "done" } | { state: "failed"; error: string };
/** A claim this computer holds, from the ledger that made it. */
type HeldClaim = { source: "engine"; claim: AutomationClaim } | { source: "dataset"; claim: DatasetAutomationClaim };
/** One automation's run history and the failure its notice offers, whichever ledger holds its claims. */
type ClaimHistory = {
  claims: Array<Pick<AutomationClaimSummary, "claimId" | "state" | "createdAtMs" | "updatedAtMs" | "attempts"> & { error?: string | null }>;
  failure: string | null;
};
/** What a released claim waits for; later drains pass it by until that clears. */
type WaitReason = "roster" | "held" | "busy";
/**
 * What the engine must hear about a claim this computer holds: hand it back
 * to wait, or settle it. `settled` runs once the engine takes the settle.
 */
type ClaimAction =
  | { kind: "release"; waitsFor?: WaitReason }
  | { kind: "settle"; input: SettleInput; settled: () => Promise<void> };
// Run history shows this many runs, and their failures keep what Try again needs.
const RESUMABLE_FAILURES = 20;

export class CollectionAutomations {
  /** Every Collection the engine lists, and those a watcher batch added. */
  private collections = new Set<string>();
  /** Collections that hold an automations.yaml, with what it says. */
  private readonly files = new Map<string, IndexedFile>();
  /**
   * The field names of each Collection with a collection.yaml that an
   * automation names, or "unreadable" when that file is not YAML dohc can
   * read as a schema. A Collection without one, such as a dataset, is not
   * listed.
   */
  private readonly schemaFields = new Map<string, ReadonlySet<string> | "unreadable">();
  /** Dataset Collections, with their approved rules. Only when dohc can run dataset automations. */
  private readonly datasets = new Map<string, IndexedDataset>();
  /** The engine subscriptions this computer holds, by engine automation id. */
  private subscribed = new Map<string, StoredSubscription>();
  /** Each step's last reach verdict. */
  private readonly verdicts = new Map<string, StoredReachVerdict>();
  /** Orders verdicts and confirmations; it only rises. */
  private verdictSeq = 0;
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
  /** Consecutive timed-out runs per automation, saved so a restart keeps them. */
  private timeouts = new Map<string, number>();
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
  private runAbort = new AbortController();
  private readonly nowMs: () => number;

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
      const { verdicts, unreadable } = await this.options.store.readReachVerdicts();
      const timeouts = await this.options.store.readTimeouts();
      if (!current()) return;
      this.subscribed = new Map(subscriptions.map((entry) => [entry.automationId, entry]));
      this.timeouts = timeouts;
      this.verdictsUnreadable = unreadable;
      for (const verdict of verdicts) {
        this.verdicts.set(reachVerdictKey(verdict.automationId, verdict.definitionHash, verdict.step), verdict);
        this.verdictSeq = Math.max(this.verdictSeq, verdict.seq);
      }
      await this.loadIndex();
      if (!current()) return;
      this.state = "open";
      this.waitingFor.clear();
      await this.reconcile(true);
      this.publishHolds();
    }).then(
      () => {
        if (!current()) return;
        this.options.onAutomationsChanged();
        this.rosterChanged();
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
    void this.enqueue(async () => {
      let datasets: Promise<Map<string, IndexedDataset> | null> | undefined;
      for (const folder of folders) {
        this.schemaFields.delete(folder);
        this.datasets.delete(folder);
        if (await this.options.pathExists(`${folder}/collection.yaml`)) {
          this.collections.add(folder);
          await this.readFile(folder);
          continue;
        }
        this.collections.delete(folder);
        // A new automations.yaml beside a dataset is a reason to open its host.
        const open = await this.options.pathExists(`${folder}/${DATASET_FILE_NAME}`) &&
          await this.options.pathExists(`${folder}/${AUTOMATIONS_FILE_NAME}`);
        const dataset = (await (datasets ??= this.datasetFolders(open)))?.get(folder);
        if (dataset === undefined) {
          this.files.delete(folder);
        } else {
          this.datasets.set(folder, dataset);
          await this.readFile(folder);
        }
      }
      await this.readNamedSchemas();
      await this.reconcile(false);
      // An edited or removed automation's held steps leave the notices.
      this.publishHolds();
    })
      // A new or changed step gets its verdict now, while the people who
      // could have written it can still edit the Collection.
      .then(() => {
        this.options.onAutomationsChanged();
        this.rosterChanged();
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
        this.options.onFailuresChanged();
      })
      .catch((error: unknown) => this.options.onError("reload dataset automations", error));
  }

  private async indexDatasets(open: boolean): Promise<void> {
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
    await this.reconcile(false);
    this.publishHolds();
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
      .then((roster) => roster.kind === "unknown" ? undefined : this.recordVerdicts(roster, this.everyAutomation()))
      .catch((error: unknown) => this.options.onError("check who can edit automations", error))
      .finally(() => this.clearWaits("roster", "held"));
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

  /** The automations in one Collection's file, with why each can or cannot run. */
  async automationsIn(collectionPath: string): Promise<CollectionAutomationsFile> {
    await this.ready();
    // A file change the watcher or a panel write already queued lands first.
    await this.chain;
    const maybeDataset = () => !this.collections.has(collectionPath) && !this.datasets.has(collectionPath) &&
      this.options.pathExists(`${collectionPath}/${DATASET_FILE_NAME}`);
    // A dataset whose host is not open yet: a person is looking at it, so open it.
    if (await maybeDataset()) await this.enqueue(() => this.indexDatasets(true));
    // A dataset whose rules are not approved is not in the index.
    const unapproved = await maybeDataset();
    const indexed = unapproved ? await this.parsedFile(collectionPath) : this.files.get(collectionPath);
    if (!indexed) return { status: "missing" };
    if (indexed.file.status === "unreadable") return { status: "unreadable", diagnostic: indexed.file.diagnostic };
    const unsupported = (automation: Automation) =>
      unapproved ? DATASET_NOT_APPROVED : this.cannotRun(collectionPath, automation);
    const roster = await this.options.cachedRoster();
    const collection = collectionNamed(collectionPath);
    const runnable = indexed.file.entries.flatMap((entry) => entry.status === "valid" && unsupported(entry.automation) === null
      ? [{ automationId: collectionAutomationId(collectionPath, entry.automation.id), collectionPath, automation: entry.automation }]
      : []);
    // Without a roster, the reason is the same for every step: dohc cannot
    // check who can edit the Collection yet.
    const [waiting] = roster.kind === "unknown"
      ? checkAutomationReach(roster, { id: "", collection, codeFiles: [], steps: [{ kind: "change-records", collection }] })
      : [];
    if (roster.kind !== "unknown") await this.recordVerdicts(roster, runnable);
    // One engine read per automation, together; the newest claim comes first.
    const lastRuns = new Map(await Promise.all(indexed.file.entries.flatMap((entry) => entry.status === "valid"
      ? [collectionAutomationId(collectionPath, entry.automation.id)]
      : []).map(async (automationId) => {
      const listed = await this.withLiveEngine((engine) => engine.listAutomationClaims({ automationId }));
      const [newest] = listed?.claims ?? [];
      return [automationId, newest ? { state: newest.state, atMs: newest.updatedAtMs } : null] as const;
    })));
    const automations = indexed.file.entries.map((entry): CollectionAutomationSummary => {
      if (entry.status === "invalid") {
        return { valid: false, id: entry.id, name: entry.name, diagnostics: entry.diagnostics };
      }
      const { automation } = entry;
      const automationId = collectionAutomationId(collectionPath, automation.id);
      const hash = definitionHash(automation);
      const summary = {
        valid: true as const, automationId, automation, definitionHash: hash, cannotRun: unsupported(automation),
        lastRun: lastRuns.get(automationId) ?? null,
      };
      if (this.verdictsUnreadable) return { ...summary, reach: { kind: "waiting", reason: UNREADABLE_REACH } };
      if (roster.kind === "unknown") {
        return { ...summary, reach: { kind: "waiting", reason: waiting && !waiting.allowed ? waiting.reason : "" } };
      }
      const reachSteps = this.reachSteps(collectionPath, automation);
      const steps = checkAutomationReach(roster, {
        id: automation.id, collection, codeFiles: [], steps: reachSteps,
      }).map((reach, step): CollectionAutomationStepReach => {
        if (!reach.allowed) return { verdict: "stopped", reason: reach.reason };
        const stored = this.verdicts.get(reachVerdictKey(automationId, hash, step));
        const reached = reachSteps[step];
        return stored?.verdict === "held" && reached && "collection" in reached
          ? {
              verdict: "held", stoppedFor: stored.stoppedFor, seq: stored.seq,
              target: reached.collection.name, action: reached.kind === "find-records" ? "find" : "change",
            }
          : { verdict: "allowed" };
      });
      return { ...summary, reach: { kind: "checked", steps } };
    });
    return { status: "read", contentHash: indexed.contentHash, automations };
  }

  /**
   * Each dataset automation's newest failure, for the failure notices, while
   * the dataset host is open. It does not open the host.
   */
  async datasetFailures(): Promise<DatasetAutomationFailure[]> {
    try {
      return (await this.withLiveHost((host) => host.failures())) ?? [];
    } catch (error) {
      this.options.onError("list dataset automation failures", error);
      return [];
    }
  }

  /**
   * The automations the ⚡ panel saves, with each dataset step pinned to the
   * approved operation it prefers (datasetAutomationPlan.ts).
   */
  async pinOperations(collectionPath: string, automations: readonly Automation[]): Promise<Automation[]> {
    await this.ready();
    if (!this.collections.has(collectionPath) && !this.datasets.has(collectionPath) &&
      await this.options.pathExists(`${collectionPath}/${DATASET_FILE_NAME}`)) {
      await this.enqueue(() => this.indexDatasets(true));
    }
    const dataset = this.datasets.get(collectionPath);
    return dataset === undefined ? [...automations] : automations.map((automation) => pinDatasetOperations(automation, dataset.definition));
  }

  /** Every step that waits for a current editor, and whether dohc could read what was allowed. */
  holdState(): CollectionAutomationHolds {
    return { holds: this.holds(), stops: this.stops(), unreadable: this.verdictsUnreadable };
  }

  /**
   * Starts the verdicts again after they could not be read: every step the
   * roster allows now is held for Allow, and every other is stopped.
   */
  async resetHolds(): Promise<"reset" | "roster-unknown"> {
    await this.ready();
    const roster = await this.options.cachedRoster();
    if (roster.kind === "unknown") return "roster-unknown";
    await this.updateVerdicts(() => {
      this.verdicts.clear();
      for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
        const collection = collectionNamed(collectionPath);
        const hash = definitionHash(automation);
        const steps = this.reachSteps(collectionPath, automation);
        checkAutomationReach(roster, { id: automation.id, collection, codeFiles: [], steps }).forEach((reach, step) => {
          this.verdicts.set(reachVerdictKey(automationId, hash, step), {
            automationId, definitionHash: hash, step,
            ...(reach.allowed ? { verdict: "held", stoppedFor: null } : { verdict: "stopped", stoppedFor: reach.person ?? null }),
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
   * The Collections a step in this Collection's automations can add or
   * change records in, for the builder's picker: every Collection the
   * engine lists, with why the reach check (ADR 0012) stops a step there,
   * or null.
   */
  async targetsFor(collectionPath: string): Promise<CollectionAutomationTarget[]> {
    await this.ready();
    const roster = await this.options.cachedRoster();
    const collection = collectionNamed(collectionPath);
    return [...this.collections].sort().map((path) => {
      const target = collectionNamed(path);
      const [reach] = checkAutomationReach(roster, {
        id: "", collection, codeFiles: [], steps: [{ kind: "change-records", collection: target }],
      });
      return { path, name: target.name, stopped: reach && !reach.allowed ? reach.reason : null };
    });
  }

  /** The name an automation has in its Collection's automations.yaml now, for History; null when it has none. */
  async nameForHistory(automationId: string): Promise<string | null> {
    const id = parseCollectionAutomationId(automationId);
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
  async dismissStops(seen: ReadonlyArray<{ automationId: string; definitionHash: string; step: number; seq: number }>): Promise<void> {
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
      return { id: automationId, collection, codeFiles: [], steps: reachStepsOf(automation, collection, collectionNamed) };
    });
    const stopped = shareImpactOf(await this.options.roster(), share, reach);
    return stopped.flatMap(({ automationId, step }): CollectionAutomationShareStop[] => {
      const index = reach.findIndex((candidate) => candidate.id === automationId);
      const owner = automations[index];
      const target = reach[index]?.steps[step];
      if (!owner || !target || !("collection" in target)) return [];
      return [{
        automationId,
        automationName: owner.automation.name,
        collectionPath: owner.collectionPath,
        target: target.collection.name,
        action: target.kind === "find-records" ? "find" : "change",
      }];
    });
  }

  /** The steps whose stored verdict matches, with what their notice names. */
  private stepsWhere(matches: (verdict: StoredReachVerdict, automation: Automation) => boolean): CollectionAutomationHold[] {
    const steps: CollectionAutomationHold[] = [];
    for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
      const hash = definitionHash(automation);
      const collection = collectionNamed(collectionPath);
      this.reachSteps(collectionPath, automation).forEach((reach, step) => {
        const stored = this.verdicts.get(reachVerdictKey(automationId, hash, step));
        if (!stored || !matches(stored, automation) || !("collection" in reach)) return;
        steps.push({
          automationId, automationName: automation.name, definitionHash: hash, step, seq: stored.seq,
          collection: collection.name, target: reach.collection.name,
          action: reach.kind === "find-records" ? "find" : "change", stoppedFor: stored.stoppedFor,
        });
      });
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
    const marks = new Map<string, Map<string, string>>();
    for (const { automationId, collectionPath: home, automation } of this.everyAutomation()) {
      if (!automation.enabled) continue;
      const writes = fieldWritesOf(automation).filter((write) => (write.collection ?? home) === collectionPath);
      if (writes.length === 0 || !(await this.canRun(automationId, home, automation, writable))) continue;
      for (const write of writes) {
        const names = marks.get(write.field) ?? new Map<string, string>();
        names.set(automationId, automation.name);
        marks.set(write.field, names);
      }
    }
    return [...marks].map(([field, names]) => ({ field, automations: [...names.values()] }));
  }

  /**
   * The name an automation has in its Collection's file now, even while the
   * entry cannot be read, or null when the file no longer has it.
   */
  automationName(automationId: string): string | null {
    const parsed = parseCollectionAutomationId(automationId);
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
  async confirmReach(input: { automationId: string; definitionHash: string; step: number; seq: number }): Promise<"confirmed" | "changed"> {
    await this.ready();
    const confirmed = await this.updateVerdicts(() => {
      if (this.verdictsUnreadable) return false;
      const key = reachVerdictKey(input.automationId, input.definitionHash, input.step);
      const stored = this.verdicts.get(key);
      if (stored?.verdict !== "held" || stored.seq !== input.seq) return false;
      this.verdicts.set(key, { ...stored, verdict: "allowed", stoppedFor: null, seq: ++this.verdictSeq });
      return true;
    });
    if (!confirmed) return "changed";
    this.clearWaits("held");
    return "confirmed";
  }

  /** One automation's newest runs on this computer, newest first. */
  async runs(automationId: string, limit = 20): Promise<CollectionAutomationRun[]> {
    const listed = await this.claimHistory(automationId, false);
    if (listed === null) throw new Error("The workspace engine is not running.");
    const parsed = parseCollectionAutomationId(automationId);
    const automation = parsed ? this.definitionFor(parsed) : null;
    const hash = automation ? definitionHash(automation) : null;
    const runs: CollectionAutomationRun[] = [];
    // Only the runs shown are read.
    for (const claim of listed.claims.slice(0, limit)) {
      // Oldest first. A run a person started over under a newer definition
      // still changed records, so its writes stay in the list.
      const stored = (await this.options.store.runsOf(automationId, claim.claimId)).runs
        .sort((left, right) => left.startedAtMs - right.startedAtMs);
      const live = stored.filter((run) => !run.superseded);
      runs.push({
        claimId: claim.claimId,
        state: claim.state,
        error: claim.error ?? null,
        createdAtMs: claim.createdAtMs,
        updatedAtMs: claim.updatedAtMs,
        writes: writesOf(stored),
        definitionChanged: hash !== null && live.some((run) => run.definitionHash !== hash),
        // The engine's rule: a chain stop is inserted failed and never served.
        chainStopped: claim.state === "failed" && claim.attempts === 0,
        undone: stored.length > 0 && stored.every((run) => run.undo === "done"),
      });
    }
    return runs;
  }

  /**
   * Try again for a failed claim. The caller contract: after the engine
   * queues the claim, this wakes the drain and asks the failure notices to
   * re-read, because the engine's own wake-up event can be dropped and a
   * repeated retry sends none. `startOver` confirms running a changed
   * automation, or a run whose progress is gone, from the beginning.
   */
  async retry(input: { automationId: string; claimId: string; startOver: boolean }): Promise<CollectionAutomationRetry> {
    await this.ready();
    const parsed = parseCollectionAutomationId(input.automationId);
    const automation = parsed ? this.definitionFor(parsed) : null;
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
    try {
      const known = this.datasets.has(parsed.collectionPath)
        ? await this.withLiveHost((ledger) => ledger.claim(input.automationId, input.claimId) !== null)
        : await this.withLiveEngine(async (engine) =>
          (await engine.listAutomationClaims({ automationId: input.automationId })).claims.some((claim) => claim.claimId === input.claimId));
      if (known === null) throw new Error("The workspace engine is not running.");
      // Without its run history, dohc cannot tell what the run already did.
      if (!known) {
        return { status: "refused", reason: "Run history no longer shows this run, so dohc will not run it again." };
      }
      const runs = await runsForClaim(this.options.store, input, automation);
      if (runs.unreadable) return { status: "refused", reason: UNREADABLE_RUN_ERROR };
      // An undone run's keys and record ids are spent, so it cannot run again.
      if (runs.undo) return { status: "refused", reason: UNDONE_RUN_ERROR };
      const progressGone = runs.done === null && runs.current?.compacted === true;
      const startsOver = progressGone || (runs.current === null && runs.changedSince !== null);
      if (startsOver && !input.startOver) return { status: progressGone ? "progress-gone" : "definition-changed" };
      this.waitingFor.delete(input.claimId);
      const retried = this.datasets.has(parsed.collectionPath)
        ? await this.withLiveHost((ledger) => ledger.retry(input.claimId))
        : await this.withLiveEngine((engine) => engine.retryAutomationClaim({ claimId: input.claimId }));
      if (retried === null) throw new Error("The workspace engine is not running.");
      if (startsOver) {
        const hash = definitionHash(automation);
        for (const run of (await this.options.store.runsOf(input.automationId, input.claimId)).runs) {
          if (run.superseded || (!progressGone && run.definitionHash === hash)) continue;
          await this.options.store.save({ ...run, superseded: true, updatedAtMs: this.nowMs() });
        }
      }
    } finally {
      this.changing.delete(input.claimId);
    }
    this.notifyClaimed();
    this.options.onFailuresChanged();
    return { status: "queued" };
  }

  /**
   * Undo for a finished run: its fields go back where no one changed them
   * since, and the records it added move to the trash through `trash`.
   */
  async undo(
    input: { automationId: string; claimId: string },
    trash: (path: string) => Promise<void>,
    // Stop and restore undoes only the runs under these definitions.
    definitionHashes?: ReadonlySet<string>,
  ): Promise<CollectionAutomationUndo> {
    await this.ready();
    // Held from before the first read to the end, like Try again's.
    if (this.changing.has(input.claimId)) return { status: "refused", reason: BUSY_CLAIM_REFUSAL };
    this.changing.add(input.claimId);
    try {
      const listed = await this.withLiveEngine((engine) => engine.listAutomationClaims({ automationId: input.automationId }));
      if (listed === null) throw new Error("The workspace engine is not running.");
      const claim = listed.claims.find((candidate) => candidate.claimId === input.claimId);
      if (!claim) return { status: "refused", reason: "dohc no longer has this run on this computer." };
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
      // Every run of the claim changed records, one a person started over
      // under a newer definition too. One whose Undo stopped part way is
      // undone again: what is already back stays as it is.
      const pending = runs.filter((run) => run.undo !== "done");
      // Saved before anything is reversed, so no run resumes over what this
      // puts back, even if it stops part way.
      for (const run of pending) {
        if (run.undo === null) await this.options.store.save({ ...run, undo: "started", updatedAtMs: this.nowMs() });
      }
      const undone = await undoCollectionAutomationRuns({
        withReads: (work) => this.withLiveEngine(work),
        withRecordWrites: this.options.withRecordWrites,
        trash,
      }, pending, this.runAbort.signal);
      for (const run of pending) await this.options.store.save({ ...run, undo: "done", updatedAtMs: this.nowMs() });
      return { status: "undone", ...undone };
    } finally {
      this.changing.delete(input.claimId);
    }
  }

  /**
   * Stop and restore: undoes every finished run in this computer's run
   * history under one of these definitions, as Undo on each would, newest
   * first as run history lists them, so each field goes back in turn. A
   * claim's runs under other definitions stay. `left` counts the runs Undo
   * refused, such as one still running.
   */
  async undoRunsOf(
    definitions: ReadonlyArray<{ automationId: string; definitionHash: string }>,
    trash: (path: string) => Promise<void>,
  ): Promise<{ undone: number; left: number }> {
    const hashes = new Map<string, Set<string>>();
    for (const { automationId, definitionHash: hash } of definitions) {
      hashes.set(automationId, (hashes.get(automationId) ?? new Set()).add(hash));
    }
    const result = { undone: 0, left: 0 };
    for (const [automationId, wanted] of hashes) {
      const listed = await this.withLiveEngine((engine) => engine.listAutomationClaims({ automationId }));
      if (listed === null) throw new Error("The workspace engine is not running.");
      for (const claim of listed.claims) {
        const runs = (await this.options.store.runsOf(automationId, claim.claimId)).runs
          .filter((run) => wanted.has(run.definitionHash));
        if (runs.length === 0 || runs.every((run) => run.undo === "done")) continue;
        const undone = await this.undo({ automationId, claimId: claim.claimId }, trash, wanted);
        result[undone.status === "undone" ? "undone" : "left"] += 1;
      }
    }
    return result;
  }

  /** The name an engine automation id's automation has in its file, or null. */
  nameOf(automationId: string): string | null {
    const parsed = parseCollectionAutomationId(automationId);
    return parsed ? (this.definitionFor(parsed)?.name ?? null) : null;
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

  /** One automation's run history, and optionally the failure its notice offers, from the ledger that holds its claims. */
  private async claimHistory(automationId: string, withFailure: boolean): Promise<ClaimHistory | null> {
    const id = parseCollectionAutomationId(automationId);
    const failureOf = (failures: ReadonlyArray<{ automationId: string; claimId: string }>) =>
      failures.find((failure) => failure.automationId === automationId)?.claimId ?? null;
    if (id !== null && this.datasets.has(id.collectionPath)) {
      return await this.withLiveHost((ledger) => ({
        claims: ledger.claims(automationId),
        failure: withFailure ? failureOf(ledger.failures()) : null,
      }));
    }
    return await this.withLiveEngine(async (engine) => ({
      claims: (await engine.listAutomationClaims({ automationId })).claims,
      failure: withFailure ? failureOf((await engine.listAutomationFailures()).failures) : null,
    }));
  }

  private stopRuns(): void {
    this.runAbort.abort();
    this.runAbort = new AbortController();
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
  }

  private async loadIndex(): Promise<void> {
    const listed = await this.options.withEngine((engine) => engine.listCollections());
    if (listed === null) throw new Error("The workspace engine is not running.");
    this.collections = new Set(listed.collections.map((collection) => collection.path));
    this.files.clear();
    this.schemaFields.clear();
    this.datasets.clear();
    for (const path of this.collections) await this.readFile(path);
    for (const [path, definition] of (await this.datasetFolders()) ?? []) {
      if (this.collections.has(path)) continue;
      this.datasets.set(path, definition);
      await this.readFile(path);
    }
    await this.readNamedSchemas();
  }

  /** Reads the field names of every Collection an automation names that the index lacks. */
  private async readNamedSchemas(): Promise<void> {
    for (const [collectionPath, indexed] of this.files) {
      if (indexed.file.status !== "read") continue;
      for (const entry of indexed.file.entries) {
        if (entry.status !== "valid") continue;
        for (const { collection } of fieldsNamedBy(entry.automation, collectionPath)) {
          if (this.schemaFields.has(collection)) continue;
          const read = await this.options.readText(`${collection}/${COLLECTION_SCHEMA_FILENAME}`);
          if (read === null) continue;
          const parsed = read.truncated ? null : parseCollectionSchema(read.text);
          // A degraded schema still lists the fields it could read; a file
          // that is not a schema at all lists none.
          const unreadable = parsed === null ||
            parsed.reasons.some((reason) => reason.code === "invalid-yaml" || reason.code === "root-not-mapping");
          this.schemaFields.set(
            collection,
            unreadable ? "unreadable" : new Set(parsed.schema.fields.map((field) => field.name)),
          );
        }
      }
    }
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
      if (fields === "unreadable") {
        return `dohc cannot read the fields of ${collectionNamed(collection).name}. Fix ${collection}/${COLLECTION_SCHEMA_FILENAME} to run this automation.`;
      }
      if (fields && !fields.has(field)) return `${field} is not a field in ${collectionNamed(collection).name}.`;
    }
    return null;
  }

  private async readFile(collectionPath: string): Promise<void> {
    const parsed = await this.parsedFile(collectionPath);
    if (parsed === undefined) this.files.delete(collectionPath);
    else this.files.set(collectionPath, parsed);
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
   * A dataset store that cannot open, or a dataset whose rules cannot be
   * read, is reported and left out, so document automations still run.
   */
  private async datasetFolders(open = false): Promise<Map<string, IndexedDataset> | null> {
    let listed: Awaited<ReturnType<DatasetAutomationHost["datasets"]>> | null;
    try {
      listed = await this.withLiveHost((host) => host.datasets(), open);
    } catch (error) {
      this.options.onError("open this workspace's dataset store", error);
      return null;
    }
    if (listed === null) return null;
    for (const { datasetId, error } of listed.failures) this.options.onError(`read dataset ${datasetId}'s rules`, error);
    const folders = new Map<string, IndexedDataset>();
    for (const definition of listed.definitions) {
      const folder = posix.dirname(definition.schemaPath);
      if (folder === ".") continue;
      const read = await this.options.readText(`${folder}/${DATASET_FILE_NAME}`);
      let described: unknown = null;
      try {
        described = read === null || read.truncated ? null : JSON.parse(read.text);
      } catch {
        // A descriptor that is not JSON names no dataset.
      }
      if (typeof described !== "object" || described === null || !("datasetId" in described) || described.datasetId !== definition.datasetId) continue;
      // Only a dataset with automations needs its operation source read.
      const generated = await this.options.pathExists(`${folder}/${AUTOMATIONS_FILE_NAME}`) &&
        await this.withLiveHost((host) => host.generated(definition.datasetId)).catch((error: unknown) => {
          this.options.onError(`read dataset ${definition.datasetId}'s operations`, error);
          return false;
        }) === true;
      folders.set(folder, { definition, generated });
    }
    return folders;
  }

  /** Why dohc cannot run an automation in this indexed Collection yet, or null. */
  private unsupportedIn(collectionPath: string, automation: Automation): string | null {
    const dataset = this.datasets.get(collectionPath);
    if (dataset === undefined) return unsupportedReason(automation);
    const subscription = datasetSubscriptionFor(automation, dataset.definition);
    return "problem" in subscription ? subscription.problem : datasetAutomationProblem(automation, dataset);
  }

  /** The Collections each step reaches, for the reach check. */
  private reachSteps(collectionPath: string, automation: Automation) {
    const collection = collectionNamed(collectionPath);
    return this.datasets.has(collectionPath)
      ? datasetReachSteps(automation, collection)
      : reachStepsOf(automation, collection, collectionNamed);
  }

  private definitionFor(id: { collectionPath: string; id: string }): Automation | null {
    const indexed = this.files.get(id.collectionPath);
    if (indexed?.file.status !== "read") return null;
    const entry = indexed.file.entries.find(
      (candidate): candidate is Extract<AutomationEntry, { status: "valid" }> =>
        candidate.status === "valid" && candidate.automation.id === id.id,
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
    const steps = reachStepsOf(automation, collectionNamed(collectionPath), collectionNamed);
    for (const [step, reach] of steps.entries()) {
      // A stopped step fails the run, and a held one waits for a current editor.
      const verdict = this.verdicts.get(reachVerdictKey(automationId, hash, step))?.verdict;
      if (verdict === "stopped" || verdict === "held") return false;
      if ("collection" in reach && !(await writable(reach.collection.path))) return false;
    }
    return true;
  }

  /** Every automation dohc can run, whether or not it is switched on. */
  private everyAutomation(): OwnedAutomation[] {
    const automations: OwnedAutomation[] = [];
    for (const [collectionPath, indexed] of this.files) {
      if (indexed.file.status !== "read") continue;
      for (const entry of indexed.file.entries) {
        if (entry.status !== "valid" || this.cannotRun(collectionPath, entry.automation) !== null) continue;
        const automationId = collectionAutomationId(collectionPath, entry.automation.id);
        automations.push({ automationId, collectionPath, automation: entry.automation });
      }
    }
    return automations;
  }

  private desiredSubscriptions(): Map<string, StoredSubscription> {
    const desired = new Map<string, StoredSubscription>();
    for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
      if (!automation.enabled || this.datasets.has(collectionPath)) continue;
      desired.set(automationId, { automationId, path: collectionPath, ...subscriptionFor(automation.when) });
    }
    return desired;
  }

  private desiredDatasetSubscriptions(): Map<string, { datasetId: string; subscription: DatasetAutomationSubscription }> {
    const desired = new Map<string, { datasetId: string; subscription: DatasetAutomationSubscription }>();
    for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
      const definition = this.datasets.get(collectionPath)?.definition;
      if (definition === undefined || !automation.enabled) continue;
      const watched = datasetSubscriptionFor(automation, definition);
      if ("problem" in watched) continue;
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
        await this.options.store.saveReachVerdicts([...this.verdicts.values()]);
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

  /** Raises the reach notices when the held or stopped steps differ from what they last showed. */
  private publishHolds(): void {
    const shown = this.verdictsUnreadable
      ? ["unreadable"]
      : [
          ...this.holds().map((hold) => `held ${reachVerdictKey(hold.automationId, hold.definitionHash, hold.step)} ${hold.seq}`),
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
  private async recordVerdicts(roster: Exclude<ReachRoster, { kind: "unknown" }>, automations: readonly OwnedAutomation[]): Promise<boolean> {
    return await this.updateVerdicts(() => {
      // Without the saved verdicts every step waits.
      if (this.verdictsUnreadable) return automations.length > 0;
      let held = false;
      for (const { automationId, collectionPath, automation } of automations) {
        const collection = collectionNamed(collectionPath);
        const hash = definitionHash(automation);
        const steps = this.reachSteps(collectionPath, automation);
        checkAutomationReach(roster, { id: automation.id, collection, codeFiles: [], steps }).forEach((reach, step) => {
          const key = reachVerdictKey(automationId, hash, step);
          const previous = this.verdicts.get(key);
          const next = nextReachVerdict(previous, reach, automation.enabled);
          if (next.verdict === "held") held = true;
          if (previous?.verdict === next.verdict && previous.stoppedFor === next.stoppedFor && previous.narrowed === next.narrowed) return;
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
    const desired = this.desiredSubscriptions();
    let changed = false;
    for (const [automationId, subscription] of [...this.subscribed]) {
      if (desired.has(automationId)) continue;
      const removed = await this.withLiveEngine((engine) =>
        engine.unsubscribeAutomation({ automationId, path: subscription.path }),
      );
      // Engine unavailable: keep the entry so the next reconcile retries it.
      if (removed === null) continue;
      this.subscribed.delete(automationId);
      changed = true;
    }
    for (const [automationId, subscription] of desired) {
      if (!all && isDeepStrictEqual(this.subscribed.get(automationId), subscription)) continue;
      const subscribed = await this.withLiveEngine((engine) => engine.subscribeAutomation(subscription));
      if (subscribed === null) continue;
      this.subscribed.set(automationId, subscription);
      changed = true;
    }
    if (changed) await this.options.store.saveSubscriptions([...this.subscribed.values()]);
    await this.reconcileDatasets(all);
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
          if (action.waitsFor) this.waitingFor.set(claimId, action.waitsFor);
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
      if (action.kind === "settle" && action.input.state === "failed") this.options.onFailuresChanged();
      if (action.kind === "settle") await action.settled();
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
        const listed = await this.withLedger(live, (ledger) => ledger.claims(automationId));
        const found = listed?.find((candidate) => candidate.claimId === claimId);
        return found === undefined ? null : found.state === "running" && found.attempts === held.claim.attempts;
      }
      const listed = await this.withEngineAt(live, (engine) => engine.listAutomationClaims({ automationId }));
      const found = listed?.claims.find((candidate) => candidate.claimId === claimId);
      return found === undefined ? null : found.state === "running";
    } catch {
      return null;
    }
  }

  /**
   * Runs one claim this drain holds, and says what the engine must hear.
   * Null leaves the claim running for the engine's recovery: a write that
   * outlived the deadline may still land.
   */
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
    const id = parseCollectionAutomationId(claim.automationId);
    // The definition is read before the roster: a pull that lands while the
    // roster lists cannot bring a step from an editor the roster lacks.
    const automation = id ? this.definitionFor(id) : null;
    const definition = id ? this.datasets.get(id.collectionPath)?.definition : undefined;
    // An engine claim's change is in a document Collection, and not in a
    // Collection inside this one, which the subscription's path also covers.
    // A dataset claim's change is in the dataset this Collection keeps.
    const inCollection = id !== null && (held.source === "engine"
      ? definition === undefined && held.claim.collectionPath === id.collectionPath
      : definition?.datasetId === held.claim.datasetId);
    if (id === null || automation === null || !automation.enabled || !inCollection) {
      // The automation is gone or off, so its subscription is stale.
      if (id !== null && !this.isSubscribed(held)) void this.enqueue(() => this.dropStaleSubscription(held));
      return { kind: "settle", input: { state: "done" }, settled: async () => undefined };
    }
    // A claim this version cannot run, or that names a field its Collection
    // lacks, fails with the reason the panel shows, so it reaches the failure
    // notice and Try again runs it once that is fixed.
    const unsupported = this.cannotRun(id.collectionPath, automation);
    if (unsupported !== null) {
      return { kind: "settle", input: { state: "failed", error: unsupported }, settled: () => this.pruneRuns(claim.automationId) };
    }
    // Every step needs the roster, even one inside the Collection: someone
    // with Edit on the file alone is an editor who cannot edit its records.
    const roster = await this.options.roster();
    if (stop.aborted) return release;
    if (roster.kind === "unknown") return { kind: "release", waitsFor: "roster" };
    const stepHeld = await this.recordVerdicts(roster, [{ automationId: claim.automationId, collectionPath: id.collectionPath, automation }]);
    // A step that reach allows only because an editor left waits for a
    // current editor to confirm it.
    if (stop.aborted) return release;
    if (stepHeld) return { kind: "release", waitsFor: "held" };
    const collection = collectionNamed(id.collectionPath);
    const outcome = await this.runWithDeadline(claim.claimId, stop, (signal) => held.source === "engine"
      ? runCollectionAutomation(this.runDependencies(), { claim: held.claim, automation, collection, roster, signal, stopped: stop })
      : runDatasetAutomation({
        withHost: (work) => this.withLiveHost(work),
        evaluator: this.options.evaluator,
        store: this.options.store,
        nowMs: () => this.nowMs(),
      }, { claim: held.claim, automation, collection, roster, signal, stopped: stop }));
    if (outcome === null) return null;
    // A pause or close stopped the run; its progress is saved, and the next
    // drain resumes it.
    if (stop.aborted) return release;
    switch (outcome.kind) {
      case "wait":
        if (outcome.reason !== "busy") return release;
        this.scheduleBusyRetry();
        return { kind: "release", waitsFor: "busy" };
      case "done":
      case "skipped":
        await this.countTimeout(claim.automationId, false);
        return { kind: "settle", input: { state: "done" }, settled: () => this.markSettled(claim, automation) };
      case "failed-before":
        // Its run was counted when it failed.
        return { kind: "settle", input: { state: "failed", error: outcome.error }, settled: () => this.pruneRuns(claim.automationId) };
      case "failed": {
        let error = outcome.error;
        if (await this.countTimeout(claim.automationId, outcome.timedOut) >= TIMEOUTS_BEFORE_SWITCH_OFF) {
          const note = await this.switchOff(id.collectionPath, automation, stop);
          if (note === null) return release;
          error = `${error} ${note}`;
        }
        return { kind: "settle", input: { state: "failed", error }, settled: () => this.pruneRuns(claim.automationId) };
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
      if (!runs.unreadable && runs.done && !runs.done.settled) {
        await this.options.store.save({ ...runs.done, settled: true });
      }
    } catch (error) {
      this.options.onError(`record automation claim "${claim.claimId}" as done`, error);
    }
    await this.pruneRuns(claim.automationId);
  }

  /**
   * Trims the automation's saved runs. A failed run keeps what Try again
   * needs while run history shows its claim among the newest, or while its
   * failure notice offers it.
   */
  private async pruneRuns(automationId: string): Promise<void> {
    try {
      await this.options.store.prune(automationId, async () => {
        const read = await this.claimHistory(automationId, true);
        if (read === null) return null;
        return new Set([
          ...read.claims.slice(0, RESUMABLE_FAILURES).map((claim) => claim.claimId),
          ...(read.failure === null ? [] : [read.failure]),
        ]);
      });
    } catch (error) {
      this.options.onError(`prune runs of "${automationId}"`, error);
    }
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
  ): Promise<CollectionAutomationRunOutcome | null> {
    const controller = new AbortController();
    const abort = () => controller.abort();
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
    }
  }

  private runDependencies(): CollectionAutomationRunDependencies {
    return {
      withReads: (work) => this.withLiveEngine(work),
      withRecordWrites: this.options.withRecordWrites,
      isCollection: (path) => this.collections.has(path),
      isDatasetCollection: (path) => this.options.pathExists(`${path}/dataset.json`),
      evaluator: this.options.evaluator,
      store: this.options.store,
      nowMs: this.nowMs,
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
        if (written.status === "ok" && (await this.options.writeText(path, written.text, read.contentHash)).status === "written") {
          const automationId = collectionAutomationId(collectionPath, automation.id);
          this.timeouts.delete(automationId);
          await this.options.store.saveTimeouts(this.timeouts);
          const indexed = this.files.get(collectionPath);
          if (indexed?.file.status === "read") {
            this.files.set(collectionPath, { ...indexed, file: { status: "read", entries: off(indexed.file.entries) } });
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
    const id = parseCollectionAutomationId(automationId);
    if (id === null) return;
    const removed = await this.withLiveEngine((engine) => engine.unsubscribeAutomation({ automationId, path: id.collectionPath }));
    if (removed !== null && this.subscribed.delete(automationId)) {
      await this.options.store.saveSubscriptions([...this.subscribed.values()]);
    }
  }
}
