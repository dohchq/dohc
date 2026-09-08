import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_RUN_DEADLINE_MS,
  PluginAutomations,
  type AutomationEngineAdapter,
  type PluginAutomationRunOutcome,
  type PluginAutomationsOptions,
} from "./pluginAutomations";
import type { PluginAutomationRunParams } from "./pluginHostProtocol";
import type { PluginAutomationDeclaration } from "./pluginManifestSchema";
import type { PluginPipelineStatusEvent } from "./PluginPipeline";
import type { PluginPipelinePluginStatus } from "./pluginStatusProjection";

function claimOf(overrides: Partial<AutomationClaim> = {}): AutomationClaim {
  return {
    claimId: "claim-1",
    automationId: "hello-plugin/triage",
    trigger: { originId: "origin-a", originSeq: 7 },
    recordId: "rec_1",
    collectionPath: "tasks",
    depth: 0,
    state: "running",
    attempts: 1,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

function statusEvent(
  overrides: Partial<PluginPipelinePluginStatus> = {},
): PluginPipelineStatusEvent {
  return {
    kind: "changed",
    plugin: {
      id: "hello-plugin",
      valid: true,
      status: "ready",
      ...overrides,
    } as PluginPipelinePluginStatus,
  };
}

interface Harness {
  automations: PluginAutomations;
  adapter: {
    subscribeAutomation: ReturnType<typeof vi.fn>;
    unsubscribeAutomation: ReturnType<typeof vi.fn>;
    claimNextAutomation: ReturnType<typeof vi.fn>;
    settleAutomationClaim: ReturnType<typeof vi.fn>;
  };
  runs: Array<{ pluginId: string; params: PluginAutomationRunParams }>;
  errors: Array<{ context: string; error: unknown }>;
  pendingClaims: AutomationClaim[];
  claimFailures: string[];
}

function harness(input: {
  engine?: Pick<Harness, "pendingClaims" | "adapter">;
  declared?: readonly PluginAutomationDeclaration[] | undefined;
  /** When set, the harness reports discovery as not landed. */
  discoveryPending?: boolean;
  proveReadable?: PluginAutomationsOptions["proveReadable"];
  runOnPlugin?: PluginAutomationsOptions["runOnPlugin"];
} = {}): Harness {
  const pendingClaims: AutomationClaim[] = input.engine?.pendingClaims ?? [];
  const adapter = input.engine?.adapter ?? {
    subscribeAutomation: vi.fn(async () => ({ subscribed: true })),
    unsubscribeAutomation: vi.fn(async () => ({ unsubscribed: true })),
    claimNextAutomation: vi.fn(async () => pendingClaims.shift() ?? null),
    settleAutomationClaim: vi.fn(
      async (settle: { claimId: string; state: string }) =>
        claimOf({ claimId: settle.claimId }),
    ),
  };
  const runs: Harness["runs"] = [];
  const errors: Harness["errors"] = [];
  const claimFailures: string[] = [];
  const automations = new PluginAutomations({
    onClaimFailed: (automationId) => {
      claimFailures.push(automationId);
    },
    withAdapter: (work) => work(adapter as unknown as AutomationEngineAdapter),
    declaredAutomations: () =>
      input.discoveryPending
        ? undefined
        : (input.declared ?? [{ id: "triage", collection: "tasks", handler: "triage" }]),
    proveReadable: input.proveReadable ?? (async () => undefined),
    runOnPlugin:
      input.runOnPlugin ??
      (async (pluginId, params) => {
        runs.push({ pluginId, params });
        return "completed";
      }),
    onError: (context, error) => {
      errors.push({ context, error });
    },
  });
  return { automations, adapter, runs, errors, pendingClaims, claimFailures };
}

describe("PluginAutomations", () => {
  it("retires a deferred attempt before the replacement executor drains its requeued claim", async () => {
    let ready = false;
    const oldEffects: string[] = [];
    const h = harness({ runOnPlugin: async (_pluginId, params) => {
      if (!ready) return "refused";
      oldEffects.push(params.claimId);
      return "completed";
    } });
    h.pendingClaims.push(claimOf());
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() => {
      expect(h.adapter.claimNextAutomation).toHaveBeenCalledTimes(2);
    });
    h.automations.stopForEngineRestart();
    ready = true;
    // Reclaim preserves the claim ID, then claimNext returns attempt 2.
    h.pendingClaims.push(claimOf({ attempts: 2 }));
    h.automations.handlePipelineStatus(statusEvent());
    h.automations.notifyClaimed();
    await h.automations.dispose();
    expect(h.adapter.unsubscribeAutomation).not.toHaveBeenCalled();
    const replacement = harness({ engine: h });
    replacement.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() => {
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledOnce();
      expect(h.adapter.claimNextAutomation).toHaveBeenCalledTimes(4);
    });
    expect(replacement.runs.map((run) => run.params.claimId)).toEqual(["claim-1"]);
    expect(oldEffects).toEqual([]);
    await replacement.automations.dispose();
  });

  it("does not execute a claim response received after engine retirement", async () => {
    const requested = Promise.withResolvers<void>();
    const claimed = Promise.withResolvers<AutomationClaim>();
    const h = harness();
    h.adapter.claimNextAutomation.mockImplementationOnce(() => {
      requested.resolve();
      return claimed.promise;
    });
    h.automations.handlePipelineStatus(statusEvent());
    await requested.promise;
    h.automations.stopForEngineRestart();
    claimed.resolve(claimOf());
    await claimed.promise;
    expect(h.runs).toEqual([]);
    expect(h.adapter.settleAutomationClaim).not.toHaveBeenCalled();
    expect(h.adapter.unsubscribeAutomation).not.toHaveBeenCalled();
  });

  it("revokes an active run immediately and ignores its completion after engine retirement", async () => {
    const started = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<PluginAutomationRunOutcome>();
    const h = harness({ runOnPlugin: () => {
      started.resolve();
      return completed.promise;
    } });
    h.pendingClaims.push(claimOf());
    h.automations.handlePipelineStatus(statusEvent());
    await started.promise;
    expect(h.automations.activeRun({ claimId: "claim-1", pluginId: "hello-plugin" })).toBeDefined();
    h.automations.stopForEngineRestart();
    expect(h.automations.activeRun({ claimId: "claim-1", pluginId: "hello-plugin" })).toBeUndefined();
    await h.automations.dispose();
    completed.resolve("completed");
    await completed.promise;
    await Promise.resolve();
    expect(h.adapter.settleAutomationClaim).not.toHaveBeenCalled();
    expect(h.adapter.unsubscribeAutomation).not.toHaveBeenCalled();
  });

  it("registers a runnable plugin's declared automations and removes them on disable", async () => {
    const h = harness();
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() => {
      expect(h.adapter.subscribeAutomation).toHaveBeenCalledWith({
        automationId: "hello-plugin/triage",
        path: "tasks",
      });
    });

    // A transient rebuild status keeps the subscription: changes made during
    // a rebuild must still claim.
    h.automations.handlePipelineStatus(statusEvent({ status: "building" }));
    h.automations.handlePipelineStatus(statusEvent({ status: "disabled" }));
    await vi.waitFor(() => {
      expect(h.adapter.unsubscribeAutomation).toHaveBeenCalledWith({
        automationId: "hello-plugin/triage",
        path: "tasks",
      });
    });
    expect(h.adapter.unsubscribeAutomation).toHaveBeenCalledTimes(1);
  });

  it("drains a claim: resolves the plugin, runs the handler, settles done", async () => {
    const h = harness();
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() =>
      expect(h.adapter.subscribeAutomation).toHaveBeenCalled(),
    );

    h.pendingClaims.push(claimOf());
    h.automations.notifyClaimed();

    await vi.waitFor(() => {
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledWith({
        claimId: "claim-1",
        state: "done",
      });
    });
    expect(h.runs).toEqual([
      {
        pluginId: "hello-plugin",
        params: {
          claimId: "claim-1",
          manifestAutomationId: "triage",
          handler: "triage",
          facts: { collectionPath: "tasks", recordId: "rec_1", depth: 0 },
        },
      },
    ]);
    // Drained to null: one extra claimNext beyond the claim itself.
    expect(h.adapter.claimNextAutomation.mock.calls.length).toBeGreaterThan(1);
    // The run is over; its claim no longer grants write authority.
    expect(
      h.automations.activeRun({ claimId: "claim-1", pluginId: "hello-plugin" }),
    ).toBeUndefined();
  });

  it("exposes the run's authority — automation id, owner, depth + 1 — only while the handler runs, and only to its own plugin", async () => {
    const h = harness({
      runOnPlugin: async () => {
        const run = h.automations.activeRun({
          claimId: "claim-1",
          pluginId: "hello-plugin",
        });
        expect(run).toEqual({
          claimId: "claim-1",
          automationId: "hello-plugin/triage",
          onBehalfOf: "local",
          depth: 1,
          writes: 0,
        });
        // Another plugin naming this claim resolves nothing.
        expect(
          h.automations.activeRun({ claimId: "claim-1", pluginId: "other" }),
        ).toBeUndefined();
        return "completed";
      },
    });
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() =>
      expect(h.adapter.subscribeAutomation).toHaveBeenCalled(),
    );

    h.pendingClaims.push(claimOf());
    h.automations.notifyClaimed();
    await vi.waitFor(() => {
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledWith({
        claimId: "claim-1",
        state: "done",
      });
    });
  });

  it("settles failed with the error text when the handler throws, and never re-runs it", async () => {
    const h = harness({
      runOnPlugin: async () => {
        throw new Error("handler exploded");
      },
    });
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() =>
      expect(h.adapter.subscribeAutomation).toHaveBeenCalled(),
    );

    h.pendingClaims.push(claimOf());
    h.automations.notifyClaimed();
    await vi.waitFor(() => {
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledWith({
        claimId: "claim-1",
        state: "failed",
        error: "handler exploded",
      });
    });
    expect(h.adapter.settleAutomationClaim).toHaveBeenCalledTimes(1);
    // The failure surface's poke fires after the settle committed.
    expect(h.claimFailures).toEqual(["hello-plugin/triage"]);
  });

  it("settles a claim whose automation is no longer installed as failed", async () => {
    const h = harness();
    // No registration at all: the claim's automation resolves to nothing.
    h.pendingClaims.push(claimOf({ automationId: "gone-plugin/auto" }));
    h.automations.notifyClaimed();
    await vi.waitFor(() => {
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledWith({
        claimId: "claim-1",
        state: "failed",
        error: 'No installed plugin declares automation "gone-plugin/auto".',
      });
    });
    expect(h.runs).toEqual([]);
  });

  // (a) A host refusal ("dohc is still working on plugin ...") is the run
  // never starting, not the handler failing. Settling failed here would
  // permanently lose every claim that lands during a rebuild.
  it("defers a claim the host refused and runs it when the plugin next reaches ready", async () => {
    let refuse = true;
    const runs: string[] = [];
    const h = harness({
      runOnPlugin: async (pluginId, params) => {
        if (refuse) return "refused";
        runs.push(params.claimId);
        return "completed";
      },
    });
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() =>
      expect(h.adapter.subscribeAutomation).toHaveBeenCalled(),
    );

    h.pendingClaims.push(claimOf());
    h.automations.notifyClaimed();
    // The drain finished (claimNext ran past the refused claim to null)
    // without settling anything: the claim stays running engine-side.
    await vi.waitFor(() =>
      expect(h.adapter.claimNextAutomation.mock.calls.length).toBeGreaterThan(1),
    );
    expect(h.adapter.settleAutomationClaim).not.toHaveBeenCalled();

    // The plugin reaches ready again: the reconcile's own drain retries the
    // deferred claim — claimNext cannot serve a running claim again.
    refuse = false;
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() => {
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledWith({
        claimId: "claim-1",
        state: "done",
      });
    });
    expect(runs).toEqual(["claim-1"]);
    expect(h.adapter.settleAutomationClaim).toHaveBeenCalledTimes(1);
  });

  // (b) Startup ordering: claimNext is workspace-wide but `registered`
  // fills per plugin. A claim whose installed plugin has not registered yet
  // must not settle failed, and the drain must stop rather than run younger
  // claims past it.
  it("holds a claim that arrives before the plugin pipeline's first discovery pass", async () => {
    const h = harness({ discoveryPending: true });
    h.pendingClaims.push(claimOf({ claimId: "claim-early" }));
    h.automations.notifyClaimed();
    // The drain ran past the held claim to null, so execute has decided.
    await vi.waitFor(() =>
      expect(h.adapter.claimNextAutomation.mock.calls.length).toBeGreaterThan(1),
    );
    // Nothing is knowable before discovery lands: the claim waits, it is
    // not failed as undeclared, and no handler ran.
    expect(h.adapter.settleAutomationClaim).not.toHaveBeenCalled();
    expect(h.runs).toEqual([]);
  });

  it("skips an automation whose collection the plugin may not read, and says so", async () => {
    const h = harness({
      proveReadable: async (_pluginId, collectionPath) => {
        throw new Error(`This plugin cannot read ${collectionPath}.`);
      },
    });
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() => expect(h.errors).toHaveLength(1));
    expect(h.adapter.subscribeAutomation).not.toHaveBeenCalled();
    expect(h.errors[0]?.context).toContain("hello-plugin/triage");
    expect(String((h.errors[0]?.error as Error).message)).toContain("cannot read tasks");
  });

  it("holds a claim for an installed plugin that has not registered yet without stalling the others", async () => {
    const h = harness();
    // Only hello-plugin is registered; later-plugin is installed (its
    // manifest declares triage) but its pipeline status has not landed.
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() =>
      expect(h.adapter.subscribeAutomation).toHaveBeenCalled(),
    );

    h.pendingClaims.push(
      claimOf({ claimId: "claim-later", automationId: "later-plugin/triage" }),
      claimOf({ claimId: "claim-hello" }),
    );
    h.automations.notifyClaimed();
    await vi.waitFor(() =>
      expect(h.adapter.claimNextAutomation).toHaveBeenCalled(),
    );
    // The later-plugin claim is held (never settled, never run), and the
    // drain goes on: hello-plugin's claim runs now. A plugin that never
    // registers this session must not stall every other automation.
    await vi.waitFor(() => {
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledWith({
        claimId: "claim-hello",
        state: "done",
      });
    });
    expect(h.adapter.settleAutomationClaim).toHaveBeenCalledTimes(1);
    expect(h.runs.map((run) => run.params.claimId)).toEqual(["claim-hello"]);

    // later-plugin's own status lands: its reconcile registers and
    // re-drains the held claim.
    h.automations.handlePipelineStatus(statusEvent({ id: "later-plugin" }));
    await vi.waitFor(() => {
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledWith({
        claimId: "claim-later",
        state: "done",
      });
    });
    expect(h.runs.map((run) => run.params.claimId)).toEqual([
      "claim-hello",
      "claim-later",
    ]);
  });

  // (c) `transport.request` has no timeout, so a never-resolving handler
  // would wedge the workspace-wide serial drain for good. The per-run
  // deadline settles it failed; a late completion changes nothing.
  it("settles a run failed when the handler outlives the deadline, once", async () => {
    vi.useFakeTimers();
    try {
      let finishLateRun: () => void = () => undefined;
      const h = harness({
        runOnPlugin: () =>
          new Promise<PluginAutomationRunOutcome>((resolve) => {
            finishLateRun = () => resolve("completed");
          }),
      });
      h.automations.handlePipelineStatus(statusEvent());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.adapter.subscribeAutomation).toHaveBeenCalled();

      h.pendingClaims.push(claimOf());
      h.automations.notifyClaimed();
      await vi.advanceTimersByTimeAsync(AUTOMATION_RUN_DEADLINE_MS - 1);
      expect(h.adapter.settleAutomationClaim).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledWith({
        claimId: "claim-1",
        state: "failed",
        error: "The automation handler did not finish within 5 minutes.",
      });
      // The run is over here; a late tagged write must refuse.
      expect(
        h.automations.activeRun({
          claimId: "claim-1",
          pluginId: "hello-plugin",
        }),
      ).toBeUndefined();

      // The handler eventually resolves: the claim is already settled, so
      // nothing settles again.
      finishLateRun();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.adapter.settleAutomationClaim).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes its subscriptions on dispose and stops resolving runs", async () => {
    const h = harness();
    h.automations.handlePipelineStatus(statusEvent());
    await vi.waitFor(() =>
      expect(h.adapter.subscribeAutomation).toHaveBeenCalled(),
    );

    // Registration itself drains once (a reaper-requeued claim has no fresh
    // event); wait for that drain so its call cannot race the count below.
    await vi.waitFor(() =>
      expect(h.adapter.claimNextAutomation).toHaveBeenCalled(),
    );

    await h.automations.dispose();
    expect(h.adapter.unsubscribeAutomation).toHaveBeenCalledWith({
      automationId: "hello-plugin/triage",
      path: "tasks",
    });
    const drained = h.adapter.claimNextAutomation.mock.calls.length;
    h.automations.notifyClaimed();
    expect(h.adapter.claimNextAutomation.mock.calls.length).toBe(drained);
  });
});
