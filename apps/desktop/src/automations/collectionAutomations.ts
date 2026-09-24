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
import type { CollectionListResult } from "@dohc/workspace-contracts/collection";
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
  definitionHash,
  fieldWritesOf,
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
import type { AutomationRunStore, RunWrite, StoredSubscription } from "./automationRunStore";
import {
  runCollectionAutomation,
  runsForClaim,
  UNREADABLE_RUN_ERROR,
  type CollectionAutomationReads,
  type CollectionAutomationRunDependencies,
  type CollectionAutomationRunOutcome,
} from "./collectionAutomationRun";
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

export const AUTOMATIONS_FILE_NAME = "automations.yaml";
const WATCHED_FILES = new Set([AUTOMATIONS_FILE_NAME, "collection.yaml"]);

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
  nowMs?: () => number;
  /** Starts a run's deadline, which calls `abort`; returns its cancel. Five minutes unless a test sets it. */
  deadline?: (abort: () => void) => () => void;
}

type IndexedFile = { file: AutomationsFileParseResult; contentHash: string | null };

/** One step's reach as the ⚡ panel shows it. */
export type CollectionAutomationStepReach =
  | { verdict: "allowed" }
  | { verdict: "stopped"; reason: string }
  // Allowed now, but stopped before under the same definition: it waits
  // for a current editor to confirm it with `seq`.
  | { verdict: "held"; stoppedFor: string | null; seq: number };

/** One automation as the ⚡ panel reads it. */
export type CollectionAutomationSummary =
  | {
      valid: true;
      automation: Automation;
      definitionHash: string;
      /** Why dohc cannot run it yet, or null. */
      unsupported: string | null;
      /** Each step's reach in step order, or why dohc cannot check who can edit yet. */
      reach: { kind: "checked"; steps: CollectionAutomationStepReach[] } | { kind: "waiting"; reason: string };
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
export type CollectionAutomationShareStop = Pick<CollectionAutomationHold, "automationName" | "collection" | "target" | "action">;

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
  private readonly owed = new Map<string, { claim: AutomationClaim; action: ClaimAction }>();
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
  /** Claims a Try again is changing; they wait until it is done. */
  private readonly retrying = new Set<string>();
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
    const folders = new Set<string>();
    for (const event of events) {
      for (const path of [event.path, event.fromPath]) {
        if (path === undefined || !WATCHED_FILES.has(posix.basename(path))) continue;
        const folder = posix.dirname(path);
        if (folder !== ".") folders.add(folder);
      }
    }
    if (folders.size === 0 || this.opened === null) return;
    void this.enqueue(async () => {
      for (const folder of folders) {
        if (await this.options.pathExists(`${folder}/collection.yaml`)) {
          this.collections.add(folder);
          await this.readFile(folder);
        } else {
          this.collections.delete(folder);
          this.files.delete(folder);
        }
      }
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
    await Promise.allSettled([this.draining]);
    await this.payOwed((work) => this.options.withEngine(work));
    this.state = "disposed";
    await Promise.allSettled([this.chain, this.verdictChain]);
  }

  /** The automations in one Collection's file, with why each can or cannot run. */
  async automationsIn(collectionPath: string): Promise<CollectionAutomationsFile> {
    await this.ready();
    const indexed = this.files.get(collectionPath);
    if (!indexed) return { status: "missing" };
    if (indexed.file.status === "unreadable") return { status: "unreadable", diagnostic: indexed.file.diagnostic };
    const roster = await this.options.cachedRoster();
    const collection = collectionNamed(collectionPath);
    const runnable = indexed.file.entries.flatMap((entry) => entry.status === "valid" && unsupportedReason(entry.automation) === null
      ? [{ automationId: collectionAutomationId(collectionPath, entry.automation.id), collectionPath, automation: entry.automation }]
      : []);
    // Without a roster, the reason is the same for every step: dohc cannot
    // check who can edit the Collection yet.
    const [waiting] = roster.kind === "unknown"
      ? checkAutomationReach(roster, { id: "", collection, codeFiles: [], steps: [{ kind: "change-records", collection }] })
      : [];
    if (roster.kind !== "unknown") await this.recordVerdicts(roster, runnable);
    const automations = indexed.file.entries.map((entry): CollectionAutomationSummary => {
      if (entry.status === "invalid") {
        return { valid: false, id: entry.id, name: entry.name, diagnostics: entry.diagnostics };
      }
      const { automation } = entry;
      const automationId = collectionAutomationId(collectionPath, automation.id);
      const hash = definitionHash(automation);
      const summary = { valid: true as const, automation, definitionHash: hash, unsupported: unsupportedReason(automation) };
      if (this.verdictsUnreadable) return { ...summary, reach: { kind: "waiting", reason: UNREADABLE_REACH } };
      if (roster.kind === "unknown") {
        return { ...summary, reach: { kind: "waiting", reason: waiting && !waiting.allowed ? waiting.reason : "" } };
      }
      const steps = checkAutomationReach(roster, {
        id: automation.id, collection, codeFiles: [], steps: reachStepsOf(automation, collection, collectionNamed),
      }).map((reach, step): CollectionAutomationStepReach => {
        if (!reach.allowed) return { verdict: "stopped", reason: reach.reason };
        const stored = this.verdicts.get(reachVerdictKey(automationId, hash, step));
        return stored?.verdict === "held"
          ? { verdict: "held", stoppedFor: stored.stoppedFor, seq: stored.seq }
          : { verdict: "allowed" };
      });
      return { ...summary, reach: { kind: "checked", steps } };
    });
    return { status: "read", contentHash: indexed.contentHash, automations };
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
        const steps = reachStepsOf(automation, collection, collectionNamed);
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

  /** Every step that waits for a current editor to allow it, one per step. */
  holds(): CollectionAutomationHold[] {
    return this.stepsWhere((verdict) => verdict.verdict === "held");
  }

  /** Every step a narrower share stopped whose notice nobody dismissed, one per step. */
  stops(): CollectionAutomationStop[] {
    return this.stepsWhere((verdict) => verdict.verdict === "stopped" && verdict.narrowed === true);
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
        automationName: owner.automation.name,
        collection: collectionNamed(owner.collectionPath).name,
        target: target.collection.name,
        action: target.kind === "find-records" ? "find" : "change",
      }];
    });
  }

  /** The steps whose stored verdict matches, with what their notice names. */
  private stepsWhere(matches: (verdict: StoredReachVerdict) => boolean): CollectionAutomationHold[] {
    const steps: CollectionAutomationHold[] = [];
    for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
      const hash = definitionHash(automation);
      const collection = collectionNamed(collectionPath);
      reachStepsOf(automation, collection, collectionNamed).forEach((reach, step) => {
        const stored = this.verdicts.get(reachVerdictKey(automationId, hash, step));
        if (!stored || !matches(stored) || !("collection" in reach)) return;
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
    const listed = await this.withLiveEngine((engine) => engine.listAutomationClaims({ automationId }));
    if (listed === null) throw new Error("The workspace engine is not running.");
    const parsed = parseCollectionAutomationId(automationId);
    const automation = parsed ? this.definitionFor(parsed) : null;
    const hash = automation ? definitionHash(automation) : null;
    const runs: CollectionAutomationRun[] = [];
    // Only the runs shown are read.
    for (const claim of listed.claims.slice(0, limit)) {
      const stored = (await this.options.store.runsOf(automationId, claim.claimId)).runs.filter((run) => !run.superseded);
      runs.push({
        claimId: claim.claimId,
        state: claim.state,
        error: claim.error ?? null,
        createdAtMs: claim.createdAtMs,
        updatedAtMs: claim.updatedAtMs,
        writes: stored.flatMap((run) => run.applied.flatMap((effect) => effect.writes)),
        definitionChanged: hash !== null && stored.some((run) => run.definitionHash !== hash),
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
    if (automation === null) return { status: "refused", reason: "This automation is no longer in its Collection's automations.yaml." };
    if (!automation.enabled) {
      return { status: "refused", reason: `"${automation.name}" is switched off. Switch it on, then try again.` };
    }
    const unsupported = unsupportedReason(automation);
    if (unsupported !== null) return { status: "refused", reason: unsupported };
    const listed = await this.withLiveEngine((engine) => engine.listAutomationClaims({ automationId: input.automationId }));
    if (listed === null) throw new Error("The workspace engine is not running.");
    // Without its run history, dohc cannot tell what the run already did.
    if (!listed.claims.some((claim) => claim.claimId === input.claimId)) {
      return { status: "refused", reason: "Run history no longer shows this run, so dohc will not run it again." };
    }
    const runs = await runsForClaim(this.options.store, input, automation);
    if (runs.unreadable) return { status: "refused", reason: UNREADABLE_RUN_ERROR };
    const progressGone = runs.done === null && runs.current?.compacted === true;
    const startsOver = progressGone || (runs.current === null && runs.changedSince !== null);
    if (startsOver && !input.startOver) return { status: progressGone ? "progress-gone" : "definition-changed" };
    this.retrying.add(input.claimId);
    this.waitingFor.delete(input.claimId);
    try {
      const retried = await this.withLiveEngine((engine) => engine.retryAutomationClaim({ claimId: input.claimId }));
      if (retried === null) throw new Error("The workspace engine is not running.");
      if (startsOver) {
        const hash = definitionHash(automation);
        for (const run of (await this.options.store.runsOf(input.automationId, input.claimId)).runs) {
          if (run.superseded || (!progressGone && run.definitionHash === hash)) continue;
          await this.options.store.save({ ...run, superseded: true, updatedAtMs: this.nowMs() });
        }
      }
    } finally {
      this.retrying.delete(input.claimId);
    }
    this.notifyClaimed();
    this.options.onFailuresChanged();
    return { status: "queued" };
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
    for (const path of this.collections) await this.readFile(path);
  }

  private async readFile(collectionPath: string): Promise<void> {
    const read = await this.options.readText(`${collectionPath}/${AUTOMATIONS_FILE_NAME}`);
    if (read === null) {
      this.files.delete(collectionPath);
      return;
    }
    this.files.set(collectionPath, {
      file: read.truncated
        ? { status: "unreadable", diagnostic: { code: "file-too-large", path: "" } }
        : parseAutomationsFile(read.text),
      contentHash: read.contentHash,
    });
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
        if (entry.status !== "valid" || unsupportedReason(entry.automation) !== null) continue;
        const automationId = collectionAutomationId(collectionPath, entry.automation.id);
        automations.push({ automationId, collectionPath, automation: entry.automation });
      }
    }
    return automations;
  }

  private desiredSubscriptions(): Map<string, StoredSubscription> {
    const desired = new Map<string, StoredSubscription>();
    for (const { automationId, collectionPath, automation } of this.everyAutomation()) {
      if (!automation.enabled) continue;
      desired.set(automationId, { automationId, path: collectionPath, ...subscriptionFor(automation.when) });
    }
    return desired;
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
        const steps = reachStepsOf(automation, collection, collectionNamed);
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
  }

  private async drain(): Promise<void> {
    // This drain's lifetime: a pause or close aborts it, and nothing it
    // started writes or settles after that.
    const stop = this.runAbort.signal;
    const release: AutomationClaim[] = [];
    try {
      // What the engine has not heard yet goes first.
      await this.payOwed((work) => this.withLiveEngine(work));
      while (!stop.aborted) {
        const claim = await this.withLiveEngine((engine) =>
          engine.claimNextAutomation({ automationIdPrefix: COLLECTION_AUTOMATION_PREFIX }),
        );
        if (claim === null) return;
        // From here this drain owns the claim: it settles, waits, or is left
        // to the engine's recovery. One that still waits goes straight back.
        const action = stop.aborted || this.waitingFor.has(claim.claimId)
          ? { kind: "release" as const }
          : await this.execute(claim, stop);
        if (action === null) continue;
        // Released at the end, so this drain does not take the claim again.
        if (action.kind === "release") {
          release.push(claim);
          if (action.waitsFor) this.waitingFor.set(claim.claimId, action.waitsFor);
          continue;
        }
        this.waitingFor.delete(claim.claimId);
        this.owed.set(claim.claimId, { claim, action });
        if (!stop.aborted) await this.payOwed((work) => this.withLiveEngine(work), claim.claimId);
      }
    } catch (error) {
      this.options.onError("drain Collection automation claims", error);
    } finally {
      for (const claim of release) this.owed.set(claim.claimId, { claim, action: { kind: "release" } });
      if (!stop.aborted) await this.payOwed((work) => this.withLiveEngine(work));
    }
  }

  /**
   * Sends each owed release and settle, or only the one for `claimId`. The
   * claim stays owed while the engine gives no answer. When the engine
   * refuses and its claim list shows the claim no longer running, its
   * recovery took the claim back, so nothing is owed and nothing settled.
   */
  private async payOwed(
    withEngine: <T>(work: (engine: CollectionAutomationEngine) => Promise<T>) => Promise<T | null>,
    claimId?: string,
  ): Promise<void> {
    for (const [id, { claim, action }] of [...this.owed]) {
      if (claimId !== undefined && id !== claimId) continue;
      let answered: boolean;
      try {
        answered = (await withEngine(async (engine) => {
          if (action.kind === "release") {
            await engine.releaseAutomationClaim({ claimId: id });
          } else {
            await engine.settleAutomationClaim(
              action.input.state === "failed"
                ? { claimId: id, state: "failed", error: errorText(action.input.error) }
                : { claimId: id, state: "done" },
            );
          }
          return true;
        })) === true;
      } catch (error) {
        if (isInvalidInputRefusal(error) && (await this.stillRunning(claim, withEngine)) === false) {
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

  /** Whether the engine still holds the claim as running, or null when it cannot say. */
  private async stillRunning(
    claim: AutomationClaim,
    withEngine: <T>(work: (engine: CollectionAutomationEngine) => Promise<T>) => Promise<T | null>,
  ): Promise<boolean | null> {
    try {
      const listed = await withEngine((engine) => engine.listAutomationClaims({ automationId: claim.automationId }));
      const found = listed?.claims.find((candidate) => candidate.claimId === claim.claimId);
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
  private async execute(claim: AutomationClaim, stop: AbortSignal): Promise<ClaimAction | null> {
    try {
      return await this.executeHeld(claim, stop);
    } catch (error) {
      this.options.onError(`run automation claim "${claim.claimId}"`, error);
      return { kind: "release" };
    }
  }

  private async executeHeld(claim: AutomationClaim, stop: AbortSignal): Promise<ClaimAction | null> {
    const release = { kind: "release" } as const;
    if (this.retrying.has(claim.claimId)) return release;
    const id = parseCollectionAutomationId(claim.automationId);
    // The definition is read before the roster: a pull that lands while the
    // roster lists cannot bring a step from an editor the roster lacks.
    const automation = id ? this.definitionFor(id) : null;
    if (
      id === null || automation === null || !automation.enabled ||
      // A change in a Collection inside this one: the subscription's path
      // covers it, and the automation does not.
      claim.collectionPath !== id.collectionPath
    ) {
      if (id !== null && !this.desiredSubscriptions().has(claim.automationId)) {
        // The automation is gone or off, so its subscription is stale.
        void this.enqueue(() => this.dropStaleSubscription(claim.automationId, id.collectionPath));
      }
      return { kind: "settle", input: { state: "done" }, settled: async () => undefined };
    }
    // A claim this version cannot run fails with the reason the panel shows,
    // so it reaches the failure notice and a later version's Try again runs it.
    const unsupported = unsupportedReason(automation);
    if (unsupported !== null) {
      return { kind: "settle", input: { state: "failed", error: unsupported }, settled: () => this.pruneRuns(claim.automationId) };
    }
    // Every step needs the roster, even one inside the Collection: someone
    // with Edit on the file alone is an editor who cannot edit its records.
    const roster = await this.options.roster();
    if (stop.aborted) return release;
    if (roster.kind === "unknown") return { kind: "release", waitsFor: "roster" };
    const held = await this.recordVerdicts(roster, [{ automationId: claim.automationId, collectionPath: id.collectionPath, automation }]);
    // A step that reach allows only because an editor left waits for a
    // current editor to confirm it.
    if (stop.aborted) return release;
    if (held) return { kind: "release", waitsFor: "held" };
    const outcome = await this.runWithDeadline(claim, automation, id.collectionPath, roster, stop);
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
  private async markSettled(claim: AutomationClaim, automation: Automation): Promise<void> {
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
        const read = await this.withLiveEngine(async (engine) => ({
          listed: await engine.listAutomationClaims({ automationId }),
          failures: await engine.listAutomationFailures(),
        }));
        if (read === null) return null;
        const notice = read.failures.failures.find((failure) => failure.automationId === automationId);
        return new Set([
          ...read.listed.claims.slice(0, RESUMABLE_FAILURES).map((claim) => claim.claimId),
          ...(notice ? [notice.claimId] : []),
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
    claim: AutomationClaim,
    automation: Automation,
    collectionPath: string,
    roster: Exclude<ReachRoster, { kind: "unknown" }>,
    stopped: AbortSignal,
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
      const run = runCollectionAutomation(this.runDependencies(), {
        claim,
        automation,
        collection: collectionNamed(collectionPath),
        roster,
        signal: controller.signal,
        stopped,
      }).catch((error: unknown): CollectionAutomationRunOutcome => ({
        kind: "failed",
        error: errorText(error),
        timedOut: controller.signal.aborted,
      }));
      const outcome = await Promise.race([run, outlived]);
      if (outcome === "outlived") {
        this.options.onError(`run automation claim "${claim.claimId}"`, new Error("A write did not stop after the deadline."));
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

  private async dropStaleSubscription(automationId: string, path: string): Promise<void> {
    if (this.desiredSubscriptions().has(automationId)) return;
    const removed = await this.withLiveEngine((engine) => engine.unsubscribeAutomation({ automationId, path }));
    if (removed !== null && this.subscribed.delete(automationId)) {
      await this.options.store.saveSubscriptions([...this.subscribed.values()]);
    }
  }
}
