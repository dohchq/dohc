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
import type {
  AutomationChangeKind,
  AutomationClaim,
  AutomationClaimSummary,
} from "@dohc/workspace-engine-client";
import type { AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import {
  collectionAutomationId,
  COLLECTION_AUTOMATION_PREFIX,
  definitionHash,
  parseCollectionAutomationId,
  reachStepsOf,
  subscriptionFor,
  unsupportedReason,
} from "./automationPlan";
import { checkAutomationReach, type ReachCollection, type ReachRoster } from "./automationReach";
import type { AutomationRunStore, RunWrite, StoredSubscription } from "./automationRunStore";
import {
  runCollectionAutomation,
  runsForClaim,
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
  /** Who can edit what in this workspace, for the reach check. */
  roster(): Promise<ReachRoster>;
  evaluator: AutomationFormulaEvaluator;
  store: AutomationRunStore;
  /** A claim settled failed, or a retry cleared one: the failure notices re-read. */
  onFailuresChanged(): void;
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

export interface CollectionAutomationRun {
  claimId: string;
  state: AutomationClaimSummary["state"];
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  /** The record changes this computer saved for the run, oldest first. */
  writes: RunWrite[];
  /** The run began under another version of the automation. */
  definitionChanged: boolean;
}

export type CollectionAutomationRetry =
  | { status: "queued" }
  // The automation changed since the run began and changed records. Running
  // it again starts from the beginning and can repeat those changes, so the
  // person must choose that.
  | { status: "definition-changed" };

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

export class CollectionAutomations {
  /** Every Collection the engine lists, and those a watcher batch added. */
  private collections = new Set<string>();
  /** Collections that hold an automations.yaml, with what it says. */
  private readonly files = new Map<string, IndexedFile>();
  /** The engine subscriptions this computer holds, by engine automation id. */
  private subscribed = new Map<string, StoredSubscription>();
  /** Each step's last reach verdict. */
  private readonly verdicts = new Map<string, StoredReachVerdict>();
  private verdictSeq = 0;
  /** Claims taken but not settled: waiting for the roster, a hold, the evaluator, or the engine. */
  private readonly deferred = new Map<string, AutomationClaim>();
  /** Consecutive timed-out runs per automation. */
  private readonly timeouts = new Map<string, number>();
  /** Serializes index loads and subscription reconciles. */
  private chain: Promise<void> = Promise.resolve();
  /** Serializes reach verdict updates. */
  private verdictChain: Promise<unknown> = Promise.resolve();
  private opened: Promise<void> | null = null;
  private state: "closed" | "open" | "paused" | "disposed" = "closed";
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
    this.opened ??= this.enqueue(async () => {
      this.subscribed = new Map((await this.options.store.readSubscriptions()).map((entry) => [entry.automationId, entry]));
      if (this.verdicts.size === 0) {
        for (const verdict of await this.options.store.readReachVerdicts()) {
          this.verdicts.set(reachVerdictKey(verdict.automationId, verdict.definitionHash, verdict.step), verdict);
          this.verdictSeq = Math.max(this.verdictSeq, verdict.seq);
        }
      }
      await this.loadIndex();
      this.state = "open";
      await this.reconcile(true);
    }).then(
      () => this.rosterChanged(),
      (error: unknown) => {
        // A later open tries again.
        this.opened = null;
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
    })
      // A new or changed step gets its verdict now, while the people who
      // could have written it can still edit the Collection.
      .then(() => this.rosterChanged())
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
    void this.options.roster()
      .then((roster) => roster.kind === "unknown" ? undefined : this.recordVerdicts(roster, this.everyAutomation()))
      .catch((error: unknown) => this.options.onError("check who can edit automations", error))
      .finally(() => this.notifyClaimed());
  }

  /** The engine is about to restart: stop runs and forget claims it will recover. */
  pauseForEngineRestart(): void {
    if (this.state === "disposed" || this.state === "paused") return;
    this.reopenAfterRestart = this.opened !== null;
    this.stopRuns();
    this.state = "paused";
  }

  /** The replacement engine answers: subscribe again and drain, if the workspace had opened. */
  resumeAfterEngineRestart(): void {
    if (this.state !== "paused") return;
    this.state = "closed";
    this.opened = null;
    if (this.reopenAfterRestart) void this.open();
  }

  /** Workspace close. Subscriptions stay, so changes made at the next open claim at once. */
  async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    this.stopRuns();
    this.state = "disposed";
    await Promise.allSettled([this.chain, this.verdictChain, this.draining]);
  }

  /** The automations in one Collection's file, with why each can or cannot run. */
  async automationsIn(collectionPath: string): Promise<CollectionAutomationsFile> {
    await this.ready();
    const indexed = this.files.get(collectionPath);
    if (!indexed) return { status: "missing" };
    if (indexed.file.status === "unreadable") return { status: "unreadable", diagnostic: indexed.file.diagnostic };
    const roster = await this.options.roster();
    const collection = collectionNamed(collectionPath);
    const valid = indexed.file.entries.flatMap((entry) => entry.status === "valid"
      ? [{ automationId: collectionAutomationId(collectionPath, entry.automation.id), collectionPath, automation: entry.automation }]
      : []);
    // Without a roster, the reason is the same for every step: dohc cannot
    // check who can edit the Collection yet.
    const [waiting] = roster.kind === "unknown"
      ? checkAutomationReach(roster, { id: "", collection, codeFiles: [], steps: [{ kind: "change-records", collection }] })
      : [];
    if (roster.kind !== "unknown") await this.recordVerdicts(roster, valid);
    const automations = indexed.file.entries.map((entry): CollectionAutomationSummary => {
      if (entry.status === "invalid") {
        return { valid: false, id: entry.id, name: entry.name, diagnostics: entry.diagnostics };
      }
      const { automation } = entry;
      const automationId = collectionAutomationId(collectionPath, automation.id);
      const hash = definitionHash(automation);
      const summary = { valid: true as const, automation, definitionHash: hash, unsupported: unsupportedReason(automation) };
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

  /**
   * A current editor allows a held step. `seq` names the hold they saw, so
   * a verdict that changed since does not take their answer.
   */
  async confirmReach(input: { automationId: string; definitionHash: string; step: number; seq: number }): Promise<"confirmed" | "changed"> {
    const confirmed = await this.updateVerdicts(() => {
      const key = reachVerdictKey(input.automationId, input.definitionHash, input.step);
      const stored = this.verdicts.get(key);
      if (stored?.verdict !== "held" || stored.seq !== input.seq) return false;
      this.verdicts.set(key, { ...stored, verdict: "allowed", stoppedFor: null, seq: ++this.verdictSeq });
      return true;
    });
    if (!confirmed) return "changed";
    this.notifyClaimed();
    return "confirmed";
  }

  /** One automation's newest runs on this computer, newest first. */
  async runs(automationId: string, limit = 20): Promise<CollectionAutomationRun[]> {
    const listed = await this.withLiveEngine((engine) => engine.listAutomationClaims({ automationId }));
    if (listed === null) throw new Error("The workspace engine is not running.");
    const stored = await this.options.store.list(automationId, 200);
    const parsed = parseCollectionAutomationId(automationId);
    const automation = parsed ? this.definitionFor(parsed) : null;
    const hash = automation ? definitionHash(automation) : null;
    return listed.claims.slice(0, limit).map((claim) => {
      const runs = stored.filter((run) => run.claimId === claim.claimId && !run.superseded);
      return {
        claimId: claim.claimId,
        state: claim.state,
        error: claim.error ?? null,
        createdAtMs: claim.createdAtMs,
        updatedAtMs: claim.updatedAtMs,
        writes: runs.flatMap((run) => run.done.flatMap((step) => step.writes)),
        definitionChanged: hash !== null && runs.some((run) => run.definitionHash !== hash),
      };
    });
  }

  /**
   * Try again for a failed claim. The caller contract: after the engine
   * queues the claim, this wakes the drain and asks the failure notices to
   * re-read, because the engine's own wake-up event can be dropped and a
   * repeated retry sends none. `startOver` confirms running a changed
   * automation from the beginning.
   */
  async retry(input: { automationId: string; claimId: string; startOver: boolean }): Promise<CollectionAutomationRetry> {
    await this.ready();
    const parsed = parseCollectionAutomationId(input.automationId);
    const automation = parsed ? this.definitionFor(parsed) : null;
    if (automation) {
      const claim = { automationId: input.automationId, claimId: input.claimId };
      const { current, changedSince } = await runsForClaim(this.options.store, claim, automation);
      if (current === null && changedSince !== null) {
        if (!input.startOver) return { status: "definition-changed" };
        const hash = definitionHash(automation);
        for (const run of await this.options.store.runsOf(input.automationId, input.claimId)) {
          if (run.definitionHash === hash || run.superseded) continue;
          await this.options.store.save({ ...run, superseded: true, updatedAtMs: this.nowMs() });
        }
      }
    }
    const retried = await this.withLiveEngine((engine) => engine.retryAutomationClaim({ claimId: input.claimId }));
    if (retried === null) throw new Error("The workspace engine is not running.");
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
    this.deferred.clear();
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

  /** Every automation dohc can run, whether or not it is switched on. */
  private everyAutomation(): Array<{ automationId: string; collectionPath: string; automation: Automation }> {
    const automations: Array<{ automationId: string; collectionPath: string; automation: Automation }> = [];
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

  /** Runs `update` on the verdicts in order and saves them when it changed any. */
  private updateVerdicts<T>(update: () => T): Promise<T> {
    const next = this.verdictChain.then(async () => {
      const before = this.verdictSeq;
      const result = update();
      if (this.verdictSeq !== before) {
        // An edited automation starts its verdicts again, so the old
        // definition's go.
        const hashes = new Map(this.everyAutomation().map(({ automationId, automation }) => [automationId, definitionHash(automation)]));
        for (const [key, verdict] of this.verdicts) {
          const hash = hashes.get(verdict.automationId);
          if (hash !== undefined && hash !== verdict.definitionHash) this.verdicts.delete(key);
        }
        await this.options.store.saveReachVerdicts([...this.verdicts.values()]);
      }
      return result;
    });
    this.verdictChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Records each step's verdict under the roster. Returns whether any step
   * of these automations is held.
   */
  private recordVerdicts(
    roster: Exclude<ReachRoster, { kind: "unknown" }>,
    automations: ReadonlyArray<{ automationId: string; collectionPath: string; automation: Automation }>,
  ): Promise<boolean> {
    return this.updateVerdicts(() => {
      let held = false;
      for (const { automationId, collectionPath, automation } of automations) {
        const collection = collectionNamed(collectionPath);
        const hash = definitionHash(automation);
        const steps = reachStepsOf(automation, collection, collectionNamed);
        checkAutomationReach(roster, { id: automation.id, collection, codeFiles: [], steps }).forEach((reach, step) => {
          const key = reachVerdictKey(automationId, hash, step);
          const previous = this.verdicts.get(key);
          const next = nextReachVerdict(previous, reach);
          if (next.verdict === "held") held = true;
          if (previous?.verdict === next.verdict && previous.stoppedFor === next.stoppedFor) return;
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
    const stop = this.runAbort.signal;
    try {
      // Claims taken earlier and waiting go first, oldest first: claimNext
      // never serves a claim it already handed out.
      for (const claim of [...this.deferred.values()]) {
        if (stop.aborted) return;
        if ((await this.execute(claim)) === "settled") this.deferred.delete(claim.claimId);
      }
      while (!stop.aborted) {
        const claim = await this.withLiveEngine((engine) =>
          engine.claimNextAutomation({ automationIdPrefix: COLLECTION_AUTOMATION_PREFIX }),
        );
        if (claim === null || stop.aborted) return;
        if ((await this.execute(claim)) === "defer") this.deferred.set(claim.claimId, claim);
      }
    } catch (error) {
      this.options.onError("drain Collection automation claims", error);
    }
  }

  private async execute(claim: AutomationClaim): Promise<"settled" | "defer"> {
    const id = parseCollectionAutomationId(claim.automationId);
    const automation = id ? this.definitionFor(id) : null;
    if (
      id === null || automation === null || !automation.enabled || unsupportedReason(automation) !== null ||
      // A change in a Collection inside this one: the subscription's path
      // covers it, and the automation does not.
      claim.collectionPath !== id.collectionPath
    ) {
      await this.settle(claim, { state: "done" });
      if (id !== null && !this.desiredSubscriptions().has(claim.automationId)) {
        // The automation is gone or off, so its subscription is stale.
        void this.enqueue(() => this.dropStaleSubscription(claim.automationId, id.collectionPath));
      }
      return "settled";
    }
    // Every step needs the roster, even one inside the Collection: someone
    // with Edit on the file alone is an editor who cannot edit its records.
    const roster = await this.options.roster();
    if (roster.kind === "unknown") return "defer";
    const held = await this.recordVerdicts(roster, [{ automationId: claim.automationId, collectionPath: id.collectionPath, automation }]);
    // A step that reach allows only because an editor left waits for a
    // current editor to confirm it.
    if (held) return "defer";
    const outcome = await this.runWithDeadline(claim, automation, id.collectionPath, roster);
    if (outcome === null) return "settled";
    switch (outcome.kind) {
      case "defer":
        if (outcome.reason === "busy") this.scheduleBusyRetry();
        return "defer";
      case "done":
      case "skipped":
        this.timeouts.delete(claim.automationId);
        await this.settle(claim, { state: "done" });
        await this.options.store.prune(claim.automationId).catch((error: unknown) =>
          this.options.onError(`prune runs of "${claim.automationId}"`, error));
        return "settled";
      case "failed": {
        let error = outcome.error;
        if (outcome.timedOut) {
          const count = (this.timeouts.get(claim.automationId) ?? 0) + 1;
          this.timeouts.set(claim.automationId, count);
          if (count >= TIMEOUTS_BEFORE_SWITCH_OFF) {
            this.timeouts.delete(claim.automationId);
            error = `${error} ${await this.switchOff(id.collectionPath, automation)}`;
          }
        } else {
          this.timeouts.delete(claim.automationId);
        }
        await this.settle(claim, { state: "failed", error });
        return "settled";
      }
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
  ): Promise<CollectionAutomationRunOutcome | null> {
    const stopped = this.runAbort.signal;
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
      return stopped.aborted ? null : outcome;
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
      this.notifyClaimed();
    }, BUSY_RETRY_MS);
    this.busyTimer.unref?.();
  }

  /**
   * Writes `enabled: false` for an automation whose runs keep timing out,
   * so it cannot hold the workspace's drain. Returns the sentence the
   * failure notice adds.
   */
  private async switchOff(collectionPath: string, automation: Automation): Promise<string> {
    const path = `${collectionPath}/${AUTOMATIONS_FILE_NAME}`;
    const name = `"${automation.name}"`;
    try {
      const read = await this.options.readText(path);
      const parsed = read && !read.truncated ? parseAutomationsFile(read.text) : null;
      if (read && !read.truncated && parsed?.status === "read") {
        const entries = parsed.entries.map((entry): AutomationEntry =>
          entry.status === "valid" && entry.automation.id === automation.id
            ? { status: "valid", automation: { ...entry.automation, enabled: false } }
            : entry,
        );
        const written = writeAutomationsFile(entries);
        if (written.status === "ok" && (await this.options.writeText(path, written.text, read.contentHash)).status === "written") {
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

  private async settle(
    claim: AutomationClaim,
    input: { state: "done" } | { state: "failed"; error: string },
  ): Promise<void> {
    try {
      await this.withLiveEngine((engine) =>
        engine.settleAutomationClaim(
          input.state === "failed"
            ? { claimId: claim.claimId, state: "failed", error: errorText(input.error) }
            : { claimId: claim.claimId, state: "done" },
        ),
      );
    } catch (error) {
      // A refused settle (the engine's recovery took the claim, or the engine
      // restarted) must not stop the drain; the claim table holds the truth.
      this.options.onError(`settle automation claim "${claim.claimId}"`, error);
      return;
    }
    if (input.state === "failed") this.options.onFailuresChanged();
  }
}
