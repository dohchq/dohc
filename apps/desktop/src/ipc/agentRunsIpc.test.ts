import type { AutomationFailureNotice } from "./bridgeContract";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createAgentRunsIpc } from "./agentRunsIpc";
import { CHANNELS } from "./channels";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import { createAgentIntegration, AgentIntegrationState } from "../agents/AgentIntegration";
import { createAgentSessionManager, type AgentSessionManager } from "../agents/AgentSessionManager";
import type { AgentDriver, AgentSession, AgentSessionStartInput } from "../agents/AgentDriver";
import type { ChatDispatchService } from "../agents/chatDispatchService";
import type { LiveAgentDispatchStoreHandle } from "../agents/liveAgentDispatchStore";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";

class Sender {
  constructor(readonly id: number) {}
  isDestroyed() { return false; }
  once(_event: "destroyed", _listener: () => void): this { return this; }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const sharedView = {
  shareId: "share", granterEmail: null, genericChatWritable: false,
  grantedSelector: { paths: [], versionId: null, access: "view" as const },
};

async function harness(shared = false) {
  const rootPath = await createTestScratch("agent-runs-ipc-");
  const registry = createRegistryStore(join(rootPath, "registry.json"));
  const workspace: RegistryEntry = {
    workspaceId: "workspace-a", rootPath, kind: "personal", mode: "local-first",
    ...(shared ? { shareView: sharedView } : {}),
  };
  registry.register(workspace);
  const sender = new Sender(7);
  const events: string[] = [];
  const authority = createWorkspaceAuthorityOwner({
    findWorkspace: registry.find,
    canonicalizeRoot: (root: string) => root,
    createState: () => new AgentIntegrationState(),
  });
  const held = authority.acquire(workspace.workspaceId);
  const physical = { ...workspace, attachmentId: held.binding.attachmentId };
  held.release();
  const renderers = new RendererWorkspaceSessionOwner<Sender>({
    retirement: {
      retireSender: () => ({ requiredForAdmission: Promise.resolve(), detachedFromAdmission: Promise.resolve() }),
      retireWorkspace: async () => undefined,
    },
  });
  await renderers.open(sender, physical, "document-1");
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<
    Sender, RegistryEntry & { attachmentId: symbol }, AgentIntegrationState,
    NonNullable<ReturnType<typeof renderers.current>>
  >({ currentSession: (value) => renderers.current(value), withPhysicalOperation: authority.withOperation.bind(authority) });
  const ended = vi.fn(() => { events.push("ended"); });
  const setAgentRun = vi.fn(() => undefined);
  let nextRun = 0;
  const integration = createAgentIntegration({
    acquire: (id) => {
      const lease = authority.acquire(id);
      return {
        attachmentId: lease.binding.attachmentId, workspaceId: id,
        rootPath: lease.binding.canonicalRootPath, state: lease.state,
        assertCurrent: lease.assertCurrent, release: lease.release, setAgentRun,
      };
    },
    workspaceIds: () => [workspace.workspaceId], now: () => 10,
    createId: () => `run-${++nextRun}`, onRunEnded: ended,
  });
  const provider = {
    sessionId: "session-1", resumeCursor: "session-1",
    prompt: vi.fn(async () => ({ turnId: "turn-1" })), cancel: vi.fn(async () => undefined),
    answerPermission: vi.fn<AgentSession["answerPermission"]>(async () => undefined),
    stop: vi.fn(async () => { events.push("stop-provider"); }),
    dispose: vi.fn(async () => { events.push("dispose-provider"); }),
  } satisfies AgentSession;
  const inputs: AgentSessionStartInput[] = [];
  const driver: AgentDriver = {
    id: "fake-driver", displayName: "Fake",
    probe: vi.fn(async () => ({ installed: true, auth: { status: "unknown" as const }, models: [] })),
    startSession: async (input) => { inputs.push(input); return provider; },
  };
  const manager = createAgentSessionManager({
    pluginDriversFor: () => [driver], integration,
    rootFor: (id) => registry.find(id)?.rootPath ?? null,
    mcpFor: () => ({ command: "dohc-mcp", args: [] }), now: () => 10,
  });
  let cached: AgentSessionManager | null = null;
  const lazyManager = vi.fn(async () => { cached = manager; return manager; });
  cleanups.push(async () => { await manager.stopAll(); await integration.stopAll(); await authority.close(); });
  const engineSessions = new EngineWorkspaceSessions({ currentClient: () => { throw new Error("daemon boundary"); } });
  const receivedShareEngine = createReceivedShareEngineAccess({
    sessions: () => engineSessions,
    relayClient: () => { throw new Error("unused relay"); },
    createStores: () => { throw new Error("unused stores"); },
  });
  const failure = { automationId: "automation-1", claimId: "claim-1", chainStopped: false, error: "Command failed", updatedAtMs: 10, generation: 3 };
  const adapter = { listAutomationFailures: vi.fn<VersionedLiveAdapter["listAutomationFailures"]>(async () => ({ failures: [failure] })) };
  const datasetFailures: AutomationFailureNotice[] = [];
  const acknowledge = vi.fn(registry.acknowledgeAutomationFailure);
  const notify = vi.fn((_id: string) => undefined);
  const requireWorkspace = vi.fn((id: string) => {
    const found = registry.find(id);
    if (!found) throw new Error("unknown workspace");
    return found;
  });
  const requireCapture = vi.fn(async (id: string, _feature: "Chats") => {
    events.push("capture"); return { workspace: requireWorkspace(id) };
  });
  const ensureOpen = vi.fn(async () => { events.push("ensure-open"); });
  const records = vi.fn<LiveAgentDispatchStoreHandle["store"]["runRecordsForThread"]>(async () => { events.push("records"); return {}; });
  const runnable = vi.fn((_id: string) => { events.push("runnable"); });
  const idle = vi.fn((_id: string) => { events.push("idle"); });
  const start = vi.fn(async (value: RegistryEntry) => { events.push("start-with-activity"); return integration.startAgentRun(value.workspaceId); });
  const warm = vi.fn(async (_value: RegistryEntry) => { events.push("warm"); });
  const writable = vi.fn((_value: RegistryEntry) => { events.push("writable"); });
  const activity = vi.fn(async (_value: RegistryEntry) => { events.push("activity"); });
  const dispatch = {
    stopAgentRun: vi.fn<ChatDispatchService["stopAgentRun"]>(async () => true),
    dispatchStateForThread: vi.fn<ChatDispatchService["dispatchStateForThread"]>(async () => ({ liveRunId: "run-1", pendingCount: 2, paused: true, pausedReason: "Failed" })),
    resumeThreadDispatch: vi.fn<ChatDispatchService["resumeThreadDispatch"]>(async () => { events.push("resume"); }),
    runnerSelfTest: vi.fn<ChatDispatchService["runnerSelfTest"]>(async () => { events.push("self-test"); return { ok: true, detail: "Ready" }; }),
  };
  const shareAccess = vi.fn((_view: unknown) => "view" as const);
  const config = vi.fn((_root: string, _access: unknown) => ({ command: "dohc-mcp", args: ["--workspace", rootPath], workspacePath: rootPath, home: rootPath }));
  const handlers = new Map<string, (event: { sender: Sender }, payload: unknown) => unknown>();
  const routed: unknown[] = [];
  let missingAdapter = false;
  const detection = vi.fn(async () => []);
  const registrations = createAgentRunsIpc({
    detectAgentTools: detection,
    registerHandler: (channel, handler) => { if (handlers.has(channel)) throw new Error("duplicate registration"); handlers.set(channel, handler); },
    assertTrustedSender: (event: { sender: Sender }) => { if (event.sender.id === -1) throw new Error("untrusted"); },
    withRendererWorkspaceOperation, receivedShareEngine,
    withEngineAdapter: async (value, work) => { routed.push(value); return missingAdapter ? null : work(adapter); },
    acknowledgeWorkspaceAutomationFailure: acknowledge, notifyAutomationFailuresChanged: notify,
    automationNameOf: (_workspaceId, automationId) => automationId === "automation-1" ? "Stamp the finish date" : null,
    datasetAutomationFailures: async () => datasetFailures,
    requireEngineCapture: requireCapture, linkedChatStoreFor: () => ({ ensureOpen }),
    agentDispatchStoreHandleFor: () => ({ store: { runRecordsForThread: records } }),
    requireWorkspace, assertAgentRunnableWorkspace: runnable, assertChatRunnerIdle: idle,
    startAgentRunWithWorkspaceActivity: start,
    get cachedAgentSessions() { return cached; }, agentIntegration: integration,
    mcpShareAccessOf: shareAccess, mcpConfigFor: config,
    sharedViewOf: (id) => registry.find(id)?.shareView,
    pluginWorkspaceRuntimes: { ensure: warm }, agentSessionManager: lazyManager,
    senderWorkspaceAuthority: {
      withActiveWorkspace: (value, id, subject, work) => withRendererWorkspaceOperation(
        value, id, `The ${subject} does not target the active workspace. Open the workspace and try again.`, async () => work(),
      ),
    },
    chatDispatchService: dispatch, assertWritableWorkspace: writable, openWorkspaceActivity: activity,
  });
  registrations.registerAutomationFailures();
  const groupSizes = [handlers.size];
  registrations.registerChatRunRecords();
  groupSizes.push(handlers.size);
  registrations.registerAgentRuns();
  groupSizes.push(handlers.size);
  const invoke = (channel: string, payload: unknown = { workspaceId: workspace.workspaceId }, value = sender) => Promise.resolve().then(() => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`unregistered: ${channel}`);
    return handler({ sender: value }, payload);
  });
  return {
    workspace, registry, physical, sender, authority, renderers, events, integration, manager, lazyManager, inputs,
    provider, driver, ended, setAgentRun, failure, datasetFailures, adapter, acknowledge, notify, requireWorkspace, requireCapture,
    ensureOpen, records, runnable, idle, start, warm, writable, activity, dispatch, shareAccess, config,
    detection, handlers, groupSizes, invoke, routed, setMissingAdapter: () => { missingAdapter = true; },
    durableRuns: async () => JSON.parse(await readFile(join(rootPath, ".dohc", "agent-runs.json"), "utf8")),
    switchWorkspace: async () => {
      const other = { ...physical, workspaceId: "workspace-b", attachmentId: Symbol("other") };
      await renderers.open(sender, other, "document-1");
    },
  };
}

const channels = [
  CHANNELS.listAutomationFailures, CHANNELS.dismissAutomationFailure, CHANNELS.chatRunRecordsForThread,
  CHANNELS.detectAgentTools, CHANNELS.startAgentRun, CHANNELS.endAgentRun, CHANNELS.getAgentRunStatus, CHANNELS.getMcpConfig,
  CHANNELS.probeAgentDrivers, CHANNELS.getAgentSessionState, CHANNELS.answerAgentPermission,
  CHANNELS.stopAgentRun, CHANNELS.chatDispatchStateForThread, CHANNELS.resumeThreadDispatch, CHANNELS.runnerSelfTest,
];
const threadPayload = { workspaceId: "workspace-a", threadId: "thread-1" };
const dismissPayload = { workspaceId: "workspace-a", automationId: "automation-1", generation: 99, datasetInstance: null };
// An engine failure as the notices serve it: a document Collection's has no dataset instance.
const served = (failure: object) => ({ ...failure, name: "Stamp the finish date", datasetInstance: null });

describe("agent run IPC registrations", () => {
  it("registers each original group and rejects untrusted callers before parsing", async () => {
    const h = await harness();
    expect(h.groupSizes).toEqual([2, 3, 15]);
    expect([...h.handlers.keys()]).toEqual(channels);
    for (const channel of channels) await expect(h.invoke(channel, null, new Sender(-1))).rejects.toThrow("untrusted");
    expect(h.requireWorkspace).not.toHaveBeenCalled();
    expect(h.routed).toEqual([]);
    expect(h.lazyManager).not.toHaveBeenCalled();
  });

  it("detects tools only for the active workspace without starting a session", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.detectAgentTools)).resolves.toEqual({ workingDirectory: h.workspace.rootPath, tools: [] });
    expect(h.detection).toHaveBeenCalledOnce();
    expect(h.detection).toHaveBeenCalledWith(h.workspace.rootPath);
    expect(h.lazyManager).not.toHaveBeenCalled();
    expect(h.activity).not.toHaveBeenCalled();
    await h.switchWorkspace();
    await expect(h.invoke(CHANNELS.detectAgentTools)).rejects.toThrow();
    expect(h.detection).toHaveBeenCalledOnce();
  });

  it("rejects malformed payloads before workspace, session, or engine work", async () => {
    const h = await harness();
    for (const channel of channels) await expect(h.invoke(channel, null)).rejects.toThrow();
    expect(h.requireWorkspace).not.toHaveBeenCalled();
    expect(h.routed).toEqual([]);
    expect(h.lazyManager).not.toHaveBeenCalled();
  });

  it("clamps acknowledgments, keeps them monotonic, and reveals later failures", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.listAutomationFailures)).resolves.toEqual({ failures: [served(h.failure)] });
    await h.invoke(CHANNELS.dismissAutomationFailure, dismissPayload);
    expect(h.acknowledge).toHaveBeenCalledWith("workspace-a", "automation-1", 3);
    expect(h.notify).toHaveBeenCalledWith("workspace-a");
    await h.invoke(CHANNELS.dismissAutomationFailure, { ...dismissPayload, generation: 1 });
    expect(h.registry.find("workspace-a")?.automationFailureAcks).toEqual({ "automation-1": 3 });
    await expect(h.invoke(CHANNELS.listAutomationFailures)).resolves.toEqual({ failures: [] });
    h.failure.generation = 4;
    await expect(h.invoke(CHANNELS.listAutomationFailures)).resolves.toEqual({ failures: [served(h.failure)] });
  });

  it("lists a dataset automation's failures beside the engine's, and scopes each dismissal to its dataset instance", async () => {
    const h = await harness();
    const budget = JSON.stringify(["dataset-1", "epoch-1"]);
    const dataset = { name: null, automationId: "collection:Budget#close", claimId: "claim-d", chainStopped: false, error: "Budget has no approved edit that changes Status.", updatedAtMs: 20, generation: 10, datasetInstance: budget };
    h.datasetFailures.push(dataset);
    await expect(h.invoke(CHANNELS.listAutomationFailures)).resolves.toEqual({ failures: [served(h.failure), dataset] });
    await h.invoke(CHANNELS.dismissAutomationFailure, { ...dismissPayload, automationId: dataset.automationId, generation: 10, datasetInstance: budget });
    expect(h.acknowledge).toHaveBeenCalledWith("workspace-a", `${dataset.automationId}@${budget}`, 10);
    await expect(h.invoke(CHANNELS.listAutomationFailures)).resolves.toEqual({ failures: [served(h.failure)] });
    // Budget is deleted and made again: its first failure counts from 1 under a new instance, and shows.
    const remade = { ...dataset, claimId: "claim-e", generation: 1, datasetInstance: JSON.stringify(["dataset-2", "epoch-2"]) };
    h.datasetFailures.splice(0, 1, remade);
    await expect(h.invoke(CHANNELS.listAutomationFailures)).resolves.toEqual({ failures: [served(h.failure), remade] });
    // A dismissal still open on the old instance's notice changes nothing.
    h.acknowledge.mockClear();
    await h.invoke(CHANNELS.dismissAutomationFailure, { ...dismissPayload, automationId: dataset.automationId, generation: 10, datasetInstance: budget });
    expect(h.acknowledge).not.toHaveBeenCalled();
    await expect(h.invoke(CHANNELS.listAutomationFailures)).resolves.toEqual({ failures: [served(h.failure), remade] });
  });

  it("returns no notices without an engine but refuses dismissal", async () => {
    const h = await harness();
    h.setMissingAdapter();
    await expect(h.invoke(CHANNELS.listAutomationFailures)).resolves.toEqual({ failures: [] });
    await expect(h.invoke(CHANNELS.dismissAutomationFailure, dismissPayload)).rejects.toThrow("The workspace engine is not running.");
    expect(h.acknowledge).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("does not acknowledge an automation absent from the engine", async () => {
    const h = await harness();
    h.adapter.listAutomationFailures.mockResolvedValue({ failures: [] });
    await expect(h.invoke(CHANNELS.dismissAutomationFailure, dismissPayload)).resolves.toBeUndefined();
    expect(h.acknowledge).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("routes shared automation notices with their physical attachment", async () => {
    const h = await harness(true);
    await h.invoke(CHANNELS.listAutomationFailures);
    expect(h.routed).toEqual([{
      workspaceId: "workspace-a", rootPath: h.workspace.rootPath, attachmentId: h.physical.attachmentId, shareMount: true,
    }]);
  });

  it.each([CHANNELS.listAutomationFailures, CHANNELS.dismissAutomationFailure])("rejects another renderer before %s engine access", async (channel) => {
    const h = await harness();
    await expect(h.invoke(channel, dismissPayload, new Sender(8))).rejects.toThrow();
    expect(h.routed).toEqual([]);
    expect(h.acknowledge).not.toHaveBeenCalled();
  });

  it.each(["renderer", "attachment"] as const)("refuses a held acknowledgment after %s retirement", async (retirement) => {
    const h = await harness();
    const reached = deferred<void>();
    const release = deferred<void>();
    h.adapter.listAutomationFailures.mockImplementation(async () => { reached.resolve(); await release.promise; return { failures: [h.failure] }; });
    const pending = h.invoke(CHANNELS.dismissAutomationFailure, dismissPayload);
    const rejected = expect(pending).rejects.toThrow();
    let drained: Promise<void> | undefined;
    try {
      await reached.promise;
      if (retirement === "renderer") await h.switchWorkspace();
      else drained = h.authority.invalidate("workspace-a");
    } finally {
      release.resolve();
      await Promise.all([rejected, drained]);
    }
    expect(h.acknowledge).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("opens linked chats before reading run records and projects only public fields", async () => {
    const h = await harness();
    const reached = deferred<void>();
    const release = deferred<void>();
    h.ensureOpen.mockImplementation(async () => { reached.resolve(); await release.promise; });
    h.records.mockResolvedValue({ message: {
      workspaceId: "workspace-a", runId: "run-1", threadId: "thread-1", triggerMessageId: "message", command: "echo hi",
      startedAtMs: 0, endedAtMs: 0, exitCode: 0, logPath: "", failureReason: "internal", failureNotePosted: true,
    }, pending: {
      workspaceId: "workspace-a", runId: "run-2", threadId: "thread-1", triggerMessageId: "pending", command: "echo later",
      startedAtMs: 1, logPath: "logs/run-2.txt", failureNotePosted: false,
    } });
    const pending = h.invoke(CHANNELS.chatRunRecordsForThread, threadPayload);
    try {
      await reached.promise;
      expect(h.records).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
    await expect(pending).resolves.toEqual({ runs: { message: {
      runId: "run-1", threadId: "thread-1", triggerMessageId: "message", command: "echo hi", startedAtMs: 0, endedAtMs: 0, exitCode: 0,
    }, pending: {
      runId: "run-2", threadId: "thread-1", triggerMessageId: "pending", command: "echo later", startedAtMs: 1, logPath: "logs/run-2.txt",
    } } });
    expect(h.requireCapture).toHaveBeenCalledWith("workspace-a", "Chats");
    expect(h.records).toHaveBeenCalledWith("workspace-a", "thread-1", { limit: 200 });
  });

  it.each([CHANNELS.chatRunRecordsForThread, CHANNELS.chatDispatchStateForThread, CHANNELS.resumeThreadDispatch])("propagates capture refusal before %s store work", async (channel) => {
    const h = await harness();
    h.requireCapture.mockRejectedValue(new Error("capture refused"));
    await expect(h.invoke(channel, threadPayload)).rejects.toThrow("capture refused");
    expect(h.ensureOpen).not.toHaveBeenCalled();
    expect(h.records).not.toHaveBeenCalled();
    expect(h.writable).not.toHaveBeenCalled();
    expect(h.dispatch.dispatchStateForThread).not.toHaveBeenCalled();
    expect(h.dispatch.resumeThreadDispatch).not.toHaveBeenCalled();
  });

  it.each(["runnable", "idle"] as const)("refuses a start at the %s gate before recording a run", async (gate) => {
    const h = await harness();
    h[gate].mockImplementation(() => { throw new Error("start refused"); });
    await expect(h.invoke(CHANNELS.startAgentRun)).rejects.toThrow("start refused");
    expect(h.start).not.toHaveBeenCalled();
    expect(h.setAgentRun).not.toHaveBeenCalled();
    expect((await h.integration.getAgentRunStatus("workspace-a")).activeRun).toBeNull();
  });

  it.each([undefined, "failed"] as const)("starts a durable plain run and ends it with outcome %s", async (status) => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.startAgentRun)).resolves.toMatchObject({ id: "run-1", status: "running" });
    expect(h.events).toEqual(["runnable", "idle", "start-with-activity"]);
    await expect(h.invoke(CHANNELS.getAgentRunStatus)).resolves.toMatchObject({ activeRun: { id: "run-1" } });
    await h.invoke(CHANNELS.endAgentRun, { workspaceId: "workspace-a", runId: "run-1", ...(status ? { status } : {}) });
    expect(h.lazyManager).not.toHaveBeenCalled();
    expect(h.ended).toHaveBeenCalledTimes(1);
    expect(await h.durableRuns()).toEqual([expect.objectContaining({ id: "run-1", status: status ?? "complete", endedAt: 10 })]);
    await expect(h.invoke(CHANNELS.getAgentRunStatus)).resolves.toMatchObject({ activeRun: null, lastRun: { status: status ?? "complete" } });
  });

  it("reads a manager cached after registration and stops its provider before finalizing once", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.getAgentSessionState);
    await h.manager.startSession({ workspaceId: "workspace-a", driverId: "fake-driver", prompt: "Hello" });
    h.events.length = 0;
    await h.invoke(CHANNELS.endAgentRun, { workspaceId: "workspace-a", runId: "run-1", status: "failed" });
    expect(h.events).toEqual(["stop-provider", "dispose-provider", "ended"]);
    expect(h.provider.stop).toHaveBeenCalledTimes(1);
    expect(h.provider.dispose).toHaveBeenCalledTimes(1);
    expect(h.ended).toHaveBeenCalledTimes(1);
    expect(await h.durableRuns()).toEqual([expect.objectContaining({ id: "run-1", status: "failed" })]);
    expect(h.manager.panelSnapshot("workspace-a").session?.status).toBe("stopped");
  });

  it("does not stop a managed session when ending a different run", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.startAgentRun);
    await h.invoke(CHANNELS.getAgentSessionState);
    await h.manager.startSession({ workspaceId: "workspace-a", driverId: "fake-driver", prompt: "Hello" });
    await h.invoke(CHANNELS.endAgentRun, { workspaceId: "workspace-a", runId: "run-1" });
    expect(h.provider.stop).not.toHaveBeenCalled();
    expect(h.manager.panelSnapshot("workspace-a").session?.runId).toBe("run-2");
    expect(await h.durableRuns()).toEqual([expect.objectContaining({ id: "run-1", status: "complete" }), expect.objectContaining({ id: "run-2", status: "running" })]);
  });

  it("waits for plugin warmup before probing the real manager", async () => {
    const h = await harness();
    const reached = deferred<void>();
    const release = deferred<void>();
    h.warm.mockImplementation(async () => { reached.resolve(); await release.promise; });
    const pending = h.invoke(CHANNELS.probeAgentDrivers);
    try {
      await reached.promise;
      expect(h.lazyManager).not.toHaveBeenCalled();
      expect(h.driver.probe).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
    await expect(pending).resolves.toMatchObject({ drivers: [{ id: "fake-driver", installed: true }], session: null });
    expect(h.driver.probe).toHaveBeenCalledTimes(1);
  });

  it("skips plugin warmup for a shared view and forwards main-owned MCP configuration", async () => {
    const h = await harness(true);
    await h.invoke(CHANNELS.probeAgentDrivers);
    expect(h.warm).not.toHaveBeenCalled();
    await expect(h.invoke(CHANNELS.getMcpConfig)).resolves.toEqual({
      command: "dohc-mcp", args: ["--workspace", h.workspace.rootPath], workspacePath: h.workspace.rootPath, home: h.workspace.rootPath,
    });
    expect(h.shareAccess).toHaveBeenCalledWith(sharedView);
    expect(h.config).toHaveBeenCalledWith(h.workspace.rootPath, "view");
  });

  it("answers an actual managed permission and returns the resulting panel", async () => {
    const h = await harness();
    await h.manager.startSession({ workspaceId: "workspace-a", driverId: "fake-driver", prompt: "Hello" });
    h.inputs[0]!.onEvent({ kind: "permission-request", requestId: "permission-1", requestType: "command", title: "Run command", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] });
    h.provider.answerPermission.mockImplementation(async (requestId, decision) => {
      h.inputs[0]!.onEvent({ kind: "permission-resolved", requestId, decision });
    });
    await expect(h.invoke(CHANNELS.getAgentSessionState)).resolves.toMatchObject({ session: { pendingPermissions: [{ requestId: "permission-1" }] } });
    await expect(h.invoke(CHANNELS.answerAgentPermission, { workspaceId: "workspace-a", requestId: "permission-1", decision: "allow_once" })).resolves.toMatchObject({ session: { pendingPermissions: [] } });
    expect(h.provider.answerPermission).toHaveBeenCalledWith("permission-1", "allow_once");
  });

  it("rejects a stop from another renderer before dispatch", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.stopAgentRun, { workspaceId: "workspace-a", runId: "run-1" }, new Sender(8))).rejects.toThrow("Agent run stop");
    expect(h.dispatch.stopAgentRun).not.toHaveBeenCalled();
  });

  it("suppresses a held stop response after the renderer switches workspaces", async () => {
    const h = await harness();
    const reached = deferred<void>();
    const release = deferred<void>();
    h.dispatch.stopAgentRun.mockImplementation(async () => { reached.resolve(); await release.promise; return true; });
    const pending = h.invoke(CHANNELS.stopAgentRun, { workspaceId: "workspace-a", runId: "run-1" });
    const rejected = expect(pending).rejects.toThrow();
    try {
      await reached.promise;
      await h.switchWorkspace();
    } finally {
      release.resolve();
      await rejected;
    }
    expect(h.dispatch.stopAgentRun).toHaveBeenCalledWith("workspace-a", "run-1");
  });

  it("requires capture for dispatch state and writable admission for resume", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.chatDispatchStateForThread, threadPayload)).resolves.toEqual({ liveRunId: "run-1", pendingCount: 2, paused: true, pausedReason: "Failed" });
    expect(h.requireCapture).toHaveBeenCalledWith("workspace-a", "Chats");
    expect(h.dispatch.dispatchStateForThread).toHaveBeenCalledWith("workspace-a", "thread-1");
    h.events.length = 0;
    h.writable.mockImplementationOnce(() => { throw new Error("read-only"); });
    await expect(h.invoke(CHANNELS.resumeThreadDispatch, threadPayload)).rejects.toThrow("read-only");
    expect(h.dispatch.resumeThreadDispatch).not.toHaveBeenCalled();
    h.events.length = 0;
    await h.invoke(CHANNELS.resumeThreadDispatch, threadPayload);
    expect(h.events).toEqual(["capture", "writable", "resume"]);
    expect(h.dispatch.resumeThreadDispatch).toHaveBeenCalledWith("workspace-a", "thread-1");
  });

  it("opens activity before self-test and propagates activity refusal", async () => {
    const h = await harness();
    h.activity.mockRejectedValueOnce(new Error("activity refused"));
    await expect(h.invoke(CHANNELS.runnerSelfTest)).rejects.toThrow("activity refused");
    expect(h.dispatch.runnerSelfTest).not.toHaveBeenCalled();
    h.events.length = 0;
    await expect(h.invoke(CHANNELS.runnerSelfTest)).resolves.toEqual({ ok: true, detail: "Ready" });
    expect(h.events).toEqual(["runnable", "activity", "self-test"]);
    expect(h.dispatch.runnerSelfTest).toHaveBeenCalledWith("workspace-a");
  });

  it("rejects malformed engine and dispatch results at their bridge schemas", async () => {
    const h = await harness();
    h.adapter.listAutomationFailures.mockResolvedValue({ failures: [{ ...h.failure, updatedAtMs: 0.5 }] });
    h.dispatch.dispatchStateForThread.mockResolvedValue({ liveRunId: null, pendingCount: -1, paused: false });
    h.dispatch.runnerSelfTest.mockResolvedValue({ ok: true, detail: "" });
    await expect(h.invoke(CHANNELS.listAutomationFailures)).rejects.toThrow();
    await expect(h.invoke(CHANNELS.chatDispatchStateForThread, threadPayload)).rejects.toThrow();
    await expect(h.invoke(CHANNELS.runnerSelfTest)).rejects.toThrow();
  });
});
