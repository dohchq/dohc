import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { describe, expect, it, vi } from "vitest";
import {
  PluginAutomations,
  engineAutomationId,
  type AutomationEngineAdapter,
  type PluginAutomationsOptions,
} from "./pluginAutomations";
import type { PluginAutomationRunParams } from "./pluginHostProtocol";
import type { PluginAutomationDeclaration } from "./pluginManifestSchema";
import type {
  PluginPipelinePluginStatus,
  PluginPipelineStatusEvent,
} from "./PluginPipeline";

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
}

function harness(input: {
  declared?: readonly PluginAutomationDeclaration[];
  runOnPlugin?: PluginAutomationsOptions["runOnPlugin"];
} = {}): Harness {
  const pendingClaims: AutomationClaim[] = [];
  const adapter = {
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
  const automations = new PluginAutomations({
    withAdapter: (work) => work(adapter as unknown as AutomationEngineAdapter),
    declaredAutomations: () =>
      input.declared ?? [{ id: "triage", collection: "tasks", handler: "triage" }],
    runOnPlugin:
      input.runOnPlugin ??
      (async (pluginId, params) => {
        runs.push({ pluginId, params });
      }),
    onError: (context, error) => {
      errors.push({ context, error });
    },
  });
  return { automations, adapter, runs, errors, pendingClaims };
}

describe("PluginAutomations", () => {
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
    expect(engineAutomationId("hello-plugin", "triage")).toBe(
      "hello-plugin/triage",
    );
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
          automationId: "triage",
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
