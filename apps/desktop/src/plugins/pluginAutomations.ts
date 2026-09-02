import type { AutomationClaim } from "@dohc/workspace-engine-client";
import type { PluginAutomationRunParams } from "./pluginHostProtocol";
import type { PluginAutomationDeclaration } from "./pluginManifestSchema";
import type { PluginPipelineStatusEvent } from "./PluginPipeline";
import type { PluginAutomationRunAuthority } from "./pluginSdkHost";

// The origin-device automation executor for ONE workspace (ADR 0008).
//
// It keeps the engine's automation subscriptions in step with the installed,
// enabled plugins' declared automations, and drains the engine's durable
// claim table: take the oldest pending claim, start the owning plugin if
// needed, run the registered handler, settle on the outcome. The engine's
// `automation.claimed` event is only the wake-up — the claim table is the
// transport, so a claim inserted while the desktop was away drains on the
// next reconcile.

// The engine bounds a settle error at 1024 characters (lane 2); stay under it.
const MAX_SETTLE_ERROR_CHARS = 1000;

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

export interface PluginAutomationsOptions {
  /** Engine adapter runner; resolves null when the engine is unavailable. */
  withAdapter<T>(
    work: (adapter: AutomationEngineAdapter) => Promise<T>,
  ): Promise<T | null>;
  /** The admitted manifest for an installed plugin, from the pipeline. */
  declaredAutomations(
    pluginId: string,
  ): readonly PluginAutomationDeclaration[] | null;
  /** Starts the plugin if needed and sends it the run; rejects when the handler throws. */
  runOnPlugin(
    pluginId: string,
    params: PluginAutomationRunParams,
  ): Promise<void>;
  onError(context: string, error: unknown): void;
}

interface RegisteredAutomation {
  pluginId: string;
  declaration: PluginAutomationDeclaration;
}

/** The engine subscription id an automation registers and writes under. */
export function engineAutomationId(
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
  /** Serializes subscription reconciles so diffs cannot interleave. */
  private reconcileChain: Promise<void> = Promise.resolve();
  private draining = false;
  private redrain = false;
  private disposed = false;

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
    this.disposed = true;
    const pairs = [...this.registered.entries()];
    this.registered.clear();
    this.activeRuns.clear();
    await this.reconcileChain.catch(() => undefined);
    for (const [automationId, entry] of pairs) {
      try {
        await this.options.withAdapter((adapter) =>
          adapter.unsubscribeAutomation({
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
      if (entry.pluginId !== pluginId) continue;
      const wanted = desiredById.get(automationId);
      if (wanted && wanted.collection === entry.declaration.collection) {
        continue;
      }
      const removed = await this.options.withAdapter((adapter) =>
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
      const current = this.registered.get(automationId);
      if (current && current.declaration.collection === declaration.collection) {
        // Same engine pair; refresh the handler name the runs resolve.
        this.registered.set(automationId, { pluginId, declaration });
        continue;
      }
      const subscribed = await this.options.withAdapter((adapter) =>
        adapter.subscribeAutomation({
          automationId,
          path: declaration.collection,
        }),
      );
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
      while (!this.disposed) {
        const claim = await this.options.withAdapter((adapter) =>
          adapter.claimNextAutomation(),
        );
        // Null is both "drained" and "engine unavailable": either way the
        // next wake-up (event or reconcile) resumes.
        if (claim === null) break;
        await this.execute(claim);
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

  private async execute(claim: AutomationClaim): Promise<void> {
    const registered = this.registered.get(claim.automationId);
    if (!registered) {
      // The plugin was uninstalled or disabled between the claim and this
      // drain; its subscription is gone, so no retry can ever find a
      // handler. Terminal, like a throwing handler.
      await this.settle(claim.claimId, {
        state: "failed",
        error: `No installed plugin declares automation "${claim.automationId}".`,
      });
      return;
    }
    this.activeRuns.set(claim.claimId, {
      claimId: claim.claimId,
      automationId: claim.automationId,
      // The origin desktop runs automations for its own workspace owner,
      // the same principal plugin writes already act for.
      onBehalfOf: "local",
      depth: claim.depth + 1,
      writes: 0,
    });
    try {
      await this.options.runOnPlugin(registered.pluginId, {
        claimId: claim.claimId,
        automationId: registered.declaration.id,
        handler: registered.declaration.handler,
        facts: {
          collectionPath: claim.collectionPath,
          recordId: claim.recordId,
          depth: claim.depth,
        },
      });
    } catch (error) {
      // No desktop retry: the engine reaper's attempt bound owns crash
      // recovery, and external effects must never re-run (ADR 0008).
      this.activeRuns.delete(claim.claimId);
      await this.settle(claim.claimId, {
        state: "failed",
        error: errorText(error),
      });
      return;
    }
    this.activeRuns.delete(claim.claimId);
    await this.settle(claim.claimId, { state: "done" });
  }

  private async settle(
    claimId: string,
    input: { state: "done" | "failed"; error?: string },
  ): Promise<void> {
    try {
      await this.options.withAdapter((adapter) =>
        adapter.settleAutomationClaim({ claimId, ...input }),
      );
    } catch (error) {
      // A refused settle (the reaper exhausted the claim first, or the
      // engine restarted) must not stop the drain; the claim table already
      // holds the durable truth.
      this.options.onError(`settle automation claim "${claimId}"`, error);
    }
  }
}
