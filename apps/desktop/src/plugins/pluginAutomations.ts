import type { AutomationClaim } from "@dohc/workspace-engine-client";
import type { PluginAutomationRunParams } from "./pluginHostProtocol";
import type { PluginAutomationDeclaration } from "./pluginManifestSchema";
import type { PluginPipelineStatusEvent } from "./PluginPipeline";
import type { PluginAutomationRunAuthority } from "./pluginSdkHost";

// The origin-device automation executor for one workspace (ADR 0008).
//
// It keeps the engine's automation subscriptions in step with the installed,
// enabled plugins' declared automations, and drains the engine's durable
// claim table: take the oldest pending claim, start the owning plugin if
// needed, run the registered handler, settle on the outcome. The engine's
// `automation.claimed` event is only the wake-up — the claim table is the
// transport, so a claim inserted while the desktop was away drains on the
// next reconcile.

// The engine bounds a settle error at 4096 bytes (lane 2); stay under it.
const MAX_SETTLE_ERROR_CHARS = 1000;

// Per-run deadline. `transport.request` has no timeout, so a handler that
// never resolves would otherwise wedge this workspace's serial drain for
// good. Deliberately shorter than the engine reaper's idle bound
// (AUTOMATION_CLAIM_REAP_IDLE_MS, 10 minutes): the deadline settles the
// claim failed here first, so the reaper never requeues a claim whose
// handler this desktop is still holding. The risk this accepts: if the
// desktop dies with a run in flight, the reaper's requeue runs the handler
// a second time — dohc bounds the handler, it does not retry it, and
// external effects are the plugin's own (the settled block's "no retries
// for external effects").
export const AUTOMATION_RUN_DEADLINE_MS = 5 * 60_000;

// Pipeline statuses under which a plugin can actually answer a claim: built
// and startable ("ready"), mid-spawn ("starting"), or installed but with a
// dead process a run's ensure-start revives ("crashed").
const RUNNABLE_STATUSES = new Set(["starting", "ready", "crashed"]);

// Statuses that withdraw the plugin's automations from the engine. Every
// other status (queued, building, failed, ...) is a transient the installed
// plugin passes through — a rebuild must not drop subscriptions, or changes
// made during it would never claim.
const UNREGISTER_STATUSES = new Set([
  "disabled",
  "disabled-pending-approval",
  "disabled-pending-repair",
  "invalid",
  "uninstalling",
]);

/** The engine RPC subset the executor drives. VersionedLiveAdapter satisfies it. */
export interface AutomationEngineAdapter {
  subscribeAutomation(input: {
    automationId: string;
    path: string;
  }): Promise<unknown>;
  unsubscribeAutomation(input: {
    automationId: string;
    path: string;
  }): Promise<unknown>;
  claimNextAutomation(): Promise<AutomationClaim | null>;
  settleAutomationClaim(input: {
    claimId: string;
    state: "done" | "failed";
    error?: string;
  }): Promise<unknown>;
}

/**
 * How a run attempt ended. "completed" is the handler resolving. "refused"
 * is the host declining to take the run at all (mid-change on that plugin,
 * or closing) — transient, so the claim is deferred, never settled failed.
 * A thrown handler rejects instead; that one is terminal.
 */
export type PluginAutomationRunOutcome = "completed" | "refused";

export interface PluginAutomationsOptions {
  /** Engine adapter runner; resolves null when the engine is unavailable. */
  withAdapter<T>(
    work: (adapter: AutomationEngineAdapter) => Promise<T>,
  ): Promise<T | null>;
  /**
   * The admitted manifest for an installed plugin, from the pipeline: null
   * when no installed plugin has that id, undefined while the pipeline's
   * first discovery pass has not landed (nothing is knowable yet).
   */
  declaredAutomations(
    pluginId: string,
  ): readonly PluginAutomationDeclaration[] | null | undefined;
  /**
   * Proves the plugin may read the collection an automation declares, with
   * the check a collections.watch on that path makes. Rejects otherwise.
   */
  proveReadable(pluginId: string, collectionPath: string): Promise<void>;
  /** Starts the plugin if needed and sends it the run; rejects when the handler throws. */
  runOnPlugin(
    pluginId: string,
    params: PluginAutomationRunParams,
  ): Promise<PluginAutomationRunOutcome>;
  /**
   * A claim just settled failed on this desktop. The owner-visible failure
   * surface re-reads `automations.failures` on it; the claim row already
   * holds the durable truth, so the hook is a poke, not the record.
   */
  onClaimFailed?(automationId: string): void;
  onError(context: string, error: unknown): void;
}

interface RegisteredAutomation {
  pluginId: string;
  declaration: PluginAutomationDeclaration;
}

/** The engine subscription id an automation registers and writes under. */
function engineAutomationId(
  pluginId: string,
  automationId: string,
): string {
  return `${pluginId}/${automationId}`;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = message.trim().slice(0, MAX_SETTLE_ERROR_CHARS);
  return bounded.length > 0 ? bounded : "The automation handler failed.";
}

export class PluginAutomations {
  /** Engine subscription id -> the pair the engine holds for it. */
  private readonly registered = new Map<string, RegisteredAutomation>();
  private readonly activeRuns = new Map<string, PluginAutomationRunAuthority>();
  /**
   * Claims taken from `claimNext` (so running engine-side) whose run could
   * not happen yet: the host refused (plugin mid-change) or the plugin is
   * installed but its registration has not landed. `claimNext` never serves
   * a running claim again, so the drain retries these itself, oldest first,
   * on every wake. If this desktop dies holding one, the engine reaper's
   * idle bound requeues it — that is the backstop, not the path.
   */
  private readonly deferred = new Map<string, AutomationClaim>();
  /** Serializes subscription reconciles so diffs cannot interleave. */
  private reconcileChain: Promise<void> = Promise.resolve();
  private draining = false;
  private redrain = false;
  private disposed = false;
  private engineRestarted = false;
  private readonly runAbort = new AbortController();

  constructor(private readonly options: PluginAutomationsOptions) {}

  /**
   * Keeps the engine's subscriptions in step with the pipeline's view of one
   * plugin: registration when the plugin becomes runnable, removal when it
   * is disabled, invalid, uninstalling, or removed. Every reconcile that
   * leaves a runnable plugin registered also drains — a claim the engine
   * reaper requeued while the desktop was away has no fresh event.
   */
  handlePipelineStatus(event: PluginPipelineStatusEvent): void {
    if (this.disposed) return;
    if (event.kind === "removed") {
      this.enqueueReconcile(event.pluginId, []);
      return;
    }
    if (event.kind !== "changed") return;
    const plugin = event.plugin;
    if (!plugin.valid || UNREGISTER_STATUSES.has(plugin.status)) {
      this.enqueueReconcile(plugin.id, []);
      return;
    }
    if (!RUNNABLE_STATUSES.has(plugin.status)) return;
    const desired = this.options.declaredAutomations(plugin.id) ?? [];
    this.enqueueReconcile(plugin.id, desired, () => {
      if (desired.length > 0) this.notifyClaimed();
    });
  }

  /** The wake-up: a claim event landed, or a reconcile registered work. */
  notifyClaimed(): void {
    if (this.disposed) return;
    void this.drain();
  }

  /**
   * Main's resolution of a request-declared claim id: the run the executor
   * actually started, and only for the plugin it started it on.
   */
  activeRun(input: {
    claimId: string;
    pluginId: string;
  }): PluginAutomationRunAuthority | undefined {
    const run = this.activeRuns.get(input.claimId);
    if (!run) return undefined;
    const registered = this.registered.get(run.automationId);
    if (!registered || registered.pluginId !== input.pluginId) return undefined;
    return run;
  }

  /** Workspace close: removes this desktop's subscriptions, best-effort. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    const pairs = [...this.registered.entries()];
    this.stop();
    await this.reconcileChain.catch(() => undefined);
    for (const [automationId, entry] of pairs) {
      if (this.engineRestarted) return;
      try {
        await this.options.withAdapter((adapter) =>
          this.engineRestarted ? Promise.resolve(null) : adapter.unsubscribeAutomation({
            automationId,
            path: entry.declaration.collection,
          }),
        );
      } catch (error) {
        this.options.onError(
          `unsubscribe ${automationId} on workspace close`,
          error,
        );
      }
    }
  }

  /** Retire this executor without reopening the engine to unsubscribe. */
  stopForEngineRestart(): void {
    this.engineRestarted = true;
    this.stop();
  }

  private stop(): void {
    this.disposed = true;
    this.registered.clear();
    this.activeRuns.clear();
    this.deferred.clear();
    this.runAbort.abort();
  }

  private withLiveAdapter<T>(
    work: (adapter: AutomationEngineAdapter) => Promise<T>,
  ): Promise<T | null> {
    if (this.disposed) return Promise.resolve(null);
    return this.options.withAdapter((adapter) =>
      this.disposed ? Promise.resolve(null) : work(adapter),
    );
  }

  private enqueueReconcile(
    pluginId: string,
    desired: readonly PluginAutomationDeclaration[],
    onRegistered?: () => void,
  ): void {
    this.reconcileChain = this.reconcileChain
      .then(async () => {
        if (this.disposed) return;
        await this.reconcile(pluginId, desired);
        onRegistered?.();
      })
      .catch((error: unknown) => {
        this.options.onError(`reconcile automations for "${pluginId}"`, error);
      });
  }

  private async reconcile(
    pluginId: string,
    desired: readonly PluginAutomationDeclaration[],
  ): Promise<void> {
    const desiredById = new Map(
      desired.map((declaration) => [
        engineAutomationId(pluginId, declaration.id),
        declaration,
      ]),
    );
    // Remove pairs the manifest no longer declares (or declares on another
    // collection — the engine removes one exact pair, so a moved automation
    // is an unsubscribe of the old pair plus a subscribe of the new).
    for (const [automationId, entry] of [...this.registered]) {
      if (this.disposed) return;
      if (entry.pluginId !== pluginId) continue;
      const wanted = desiredById.get(automationId);
      if (wanted && wanted.collection === entry.declaration.collection) {
        continue;
      }
      const removed = await this.withLiveAdapter((adapter) =>
        adapter.unsubscribeAutomation({
          automationId,
          path: entry.declaration.collection,
        }),
      );
      // Engine unavailable: keep the local entry so the next reconcile
      // retries the removal instead of forgetting the engine still holds it.
      if (removed === null) continue;
      this.registered.delete(automationId);
    }
    for (const [automationId, declaration] of desiredById) {
      if (this.disposed) return;
      const current = this.registered.get(automationId);
      if (current && current.declaration.collection === declaration.collection) {
        // Same engine pair; refresh the handler name the runs resolve.
        this.registered.set(automationId, { pluginId, declaration });
        continue;
      }
      // The same boundary a collections.watch crosses: an automation reaches
      // only a collection its plugin may read. A refusal is the owner's to
      // see, not a silent skip.
      try {
        await this.options.proveReadable(pluginId, declaration.collection);
      } catch (error) {
        this.options.onError(
          `register automation "${automationId}" on "${declaration.collection}"`,
          error,
        );
        continue;
      }
      const subscribed = await this.withLiveAdapter((adapter) =>
        adapter.subscribeAutomation({
          automationId,
          path: declaration.collection,
        }),
      );
      if (this.disposed) return;
      if (subscribed === null) continue;
      this.registered.set(automationId, { pluginId, declaration });
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      this.redrain = true;
      return;
    }
    this.draining = true;
    try {
      // Deferred claims first, oldest first: they are older than anything
      // claimNext can still serve, and claimNext never serves them again.
      for (const claim of [...this.deferred.values()]) {
        if (this.disposed) break;
        const outcome = await this.execute(claim);
        if (outcome === "settled") this.deferred.delete(claim.claimId);
      }
      while (!this.disposed) {
        const claim = await this.withLiveAdapter((adapter) =>
          adapter.claimNextAutomation(),
        );
        // Null is both "drained" and "engine unavailable": either way the
        // next wake-up (event or reconcile) resumes.
        if (this.disposed || claim === null) break;
        const outcome = await this.execute(claim);
        if (outcome !== "settled") {
          this.deferred.set(claim.claimId, claim);
        }
      }
    } catch (error) {
      this.options.onError("drain automation claims", error);
    } finally {
      this.draining = false;
    }
    if (this.redrain && !this.disposed) {
      this.redrain = false;
      void this.drain();
    }
  }

  /**
   * True when a discovered plugin's admitted manifest declares this id,
   * undefined while discovery has not landed.
   */
  private installedPluginDeclares(automationId: string): boolean | undefined {
    const slash = automationId.indexOf("/");
    if (slash <= 0) return false;
    const pluginId = automationId.slice(0, slash);
    const declared = this.options.declaredAutomations(pluginId);
    if (declared === undefined) return undefined;
    return (
      declared?.some(
        (declaration) =>
          engineAutomationId(pluginId, declaration.id) === automationId,
      ) ?? false
    );
  }

  /**
   * Runs one claim the engine already holds as running. "settled" closed the
   * claim (done or failed). "defer" leaves it running for a later drain to
   * retry: the host refused this run, or the claim's plugin has not
   * registered yet. A deferred claim never halts the drain: every claim of
   * an unregistered automation defers alike, so order within one automation
   * holds, and a plugin that never registers this session (its build
   * failed at open) cannot stall every other automation in the workspace.
   * The engine reaper's requeue-then-exhaust cycle is what surfaces such a
   * claim to the owner.
   */
  private async execute(
    claim: AutomationClaim,
  ): Promise<"settled" | "defer"> {
    if (this.disposed) return "settled";
    const registered = this.registered.get(claim.automationId);
    if (!registered) {
      const declares = this.installedPluginDeclares(claim.automationId);
      // Before the pipeline's first discovery pass nothing is knowable:
      // a claim that arrives that early waits, like one for a plugin that
      // has not registered yet.
      if (declares === undefined || declares) {
        // Startup ordering: claimNext serves the oldest pending claim
        // workspace-wide, but `registered` fills per plugin as each one's
        // pipeline status lands. An installed declarer that has not
        // registered yet is not a failure — that plugin's own reconcile
        // re-drains this claim.
        return "defer";
      }
      // No installed plugin declares it: uninstalled, or the manifest
      // dropped the automation. No retry can ever find a handler.
      await this.settle(claim.claimId, {
        state: "failed",
        error: `No installed plugin declares automation "${claim.automationId}".`,
        automationId: claim.automationId,
      });
      return "settled";
    }
    this.activeRuns.set(claim.claimId, {
      claimId: claim.claimId,
      automationId: claim.automationId,
      // The origin desktop runs automations for its own workspace owner,
      // the same principal plugin writes already act for.
      onBehalfOf: "local",
      depth: claim.depth + 1,
      attempt: claim.attempts,
      writes: 0,
    });
    let attempt:
      | { kind: "completed" | "refused" | "deadline" | "cancelled" }
      | { kind: "threw"; error: unknown };
    try {
      attempt = await this.runWithDeadline(registered, claim);
    } finally {
      // Before the settle, always: once the run is over here, a late tagged
      // write from a still-live handler must refuse.
      this.activeRuns.delete(claim.claimId);
    }
    if (this.disposed) return "settled";
    switch (attempt.kind) {
      case "cancelled":
        return "settled";
      case "completed":
        await this.settle(claim.claimId, { state: "done" });
        return "settled";
      case "refused":
        // Transient: the host is mid-change on that plugin (or closing).
        // The claim stays running; the plugin's next `ready` reconcile
        // re-drains it. The engine reaper's idle bound is the backstop.
        return "defer";
      case "deadline":
        await this.settle(claim.claimId, {
          state: "failed",
          error: `The automation handler did not finish within ${AUTOMATION_RUN_DEADLINE_MS / 60_000} minutes.`,
          automationId: claim.automationId,
        });
        return "settled";
      case "threw":
        // No desktop retry: the engine reaper's attempt bound owns crash
        // recovery, and external effects must never re-run (ADR 0008).
        await this.settle(claim.claimId, {
          state: "failed",
          error: errorText(attempt.error),
          automationId: claim.automationId,
        });
        return "settled";
    }
  }

  /**
   * The run, raced against [`AUTOMATION_RUN_DEADLINE_MS`]. A handler that
   * outlives the deadline keeps running in its process — dohc bounds the
   * run's claim, it does not kill the plugin — but its late writes refuse
   * (the authority is deleted before the failed settle) and its eventual
   * outcome is discarded.
   */
  private runWithDeadline(
    registered: RegisteredAutomation,
    claim: AutomationClaim,
  ): Promise<
    { kind: "completed" | "refused" | "deadline" | "cancelled" } | { kind: "threw"; error: unknown }
  > {
    return new Promise((resolve) => {
      const finish: typeof resolve = (outcome) => {
        clearTimeout(timer);
        this.runAbort.signal.removeEventListener("abort", abort);
        resolve(outcome);
      };
      const abort = () => finish({ kind: "cancelled" });
      const timer = setTimeout(
        () => finish({ kind: "deadline" }),
        AUTOMATION_RUN_DEADLINE_MS,
      );
      this.runAbort.signal.addEventListener("abort", abort, { once: true });
      if (this.runAbort.signal.aborted) {
        abort();
        return;
      }
      this.options
        .runOnPlugin(registered.pluginId, {
          claimId: claim.claimId,
          manifestAutomationId: registered.declaration.id,
          handler: registered.declaration.handler,
          facts: {
            collectionPath: claim.collectionPath,
            recordId: claim.recordId,
            depth: claim.depth,
          },
        })
        .then(
          (outcome) => {
            finish({ kind: outcome });
          },
          (error: unknown) => {
            finish({ kind: "threw", error });
          },
        );
    });
  }

  private async settle(
    claimId: string,
    input:
      | { state: "done" }
      | { state: "failed"; error: string; automationId: string },
  ): Promise<void> {
    try {
      await this.withLiveAdapter((adapter) =>
        adapter.settleAutomationClaim(
          input.state === "failed"
            ? { claimId, state: "failed", error: input.error }
            : { claimId, state: "done" },
        ),
      );
    } catch (error) {
      // A refused settle (the reaper exhausted the claim first, or the
      // engine restarted) must not stop the drain; the claim table already
      // holds the durable truth.
      this.options.onError(`settle automation claim "${claimId}"`, error);
      return;
    }
    if (!this.disposed && input.state === "failed") {
      this.options.onClaimFailed?.(input.automationId);
    }
  }
}
