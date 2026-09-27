import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunsIpc } from "./agentRunsIpc";
import { CHANNELS } from "./channels";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { createAgentIntegration, AgentIntegrationState } from "../agents/AgentIntegration";
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
  cleanups.push(async () => { await integration.stopAll(); await authority.close(); });
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
  const detection = vi.fn(async () => []);
  const registrations = createAgentRunsIpc({
    detectAgentTools: detection,
    registerHandler: (channel, handler) => { if (handlers.has(channel)) throw new Error("duplicate registration"); handlers.set(channel, handler); },
    assertTrustedSender: (event: { sender: Sender }) => { if (event.sender.id === -1) throw new Error("untrusted"); },
    withRendererWorkspaceOperation,
    requireEngineCapture: requireCapture, linkedChatStoreFor: () => ({ ensureOpen }),
    agentDispatchStoreHandleFor: () => ({ store: { runRecordsForThread: records } }),
    requireWorkspace, assertAgentRunnableWorkspace: runnable, assertChatRunnerIdle: idle,
    startAgentRunWithWorkspaceActivity: start,
    agentIntegration: integration,
    mcpShareAccessOf: shareAccess, mcpConfigFor: config,
    senderWorkspaceAuthority: {
      withActiveWorkspace: (value, id, subject, work) => withRendererWorkspaceOperation(
        value, id, `The ${subject} does not target the active workspace. Open the workspace and try again.`, async () => work(),
      ),
    },
    chatDispatchService: dispatch, assertWritableWorkspace: writable, openWorkspaceActivity: activity,
  });
  registrations.registerChatRunRecords();
  const groupSizes = [handlers.size];
  registrations.registerAgentRuns();
  groupSizes.push(handlers.size);
  const invoke = (channel: string, payload: unknown = { workspaceId: workspace.workspaceId }, value = sender) => Promise.resolve().then(() => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`unregistered: ${channel}`);
    return handler({ sender: value }, payload);
  });
  return {
    workspace, registry, physical, sender, authority, renderers, events, integration,
    ended, setAgentRun, requireWorkspace, requireCapture,
    ensureOpen, records, runnable, idle, start, writable, activity, dispatch, shareAccess, config,
    detection, handlers, groupSizes, invoke,
    durableRuns: async () => JSON.parse(await readFile(join(rootPath, ".dohc", "agent-runs.json"), "utf8")),
    switchWorkspace: async () => {
      const other = { ...physical, workspaceId: "workspace-b", attachmentId: Symbol("other") };
      await renderers.open(sender, other, "document-1");
    },
  };
}

const channels = [
  CHANNELS.chatRunRecordsForThread,
  CHANNELS.detectAgentTools, CHANNELS.startAgentRun, CHANNELS.endAgentRun, CHANNELS.getAgentRunStatus, CHANNELS.getMcpConfig,
  CHANNELS.stopAgentRun, CHANNELS.chatDispatchStateForThread, CHANNELS.resumeThreadDispatch, CHANNELS.runnerSelfTest,
];
const threadPayload = { workspaceId: "workspace-a", threadId: "thread-1" };

describe("agent run IPC registrations", () => {
  it("registers each original group and rejects untrusted callers before parsing", async () => {
    const h = await harness();
    expect(h.groupSizes).toEqual([1, 10]);
    expect([...h.handlers.keys()]).toEqual(channels);
    for (const channel of channels) await expect(h.invoke(channel, null, new Sender(-1))).rejects.toThrow("untrusted");
    expect(h.requireWorkspace).not.toHaveBeenCalled();
  });

  it("detects tools only for the active workspace without starting a session", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.detectAgentTools)).resolves.toEqual({ workingDirectory: h.workspace.rootPath, tools: [] });
    expect(h.detection).toHaveBeenCalledOnce();
    expect(h.detection).toHaveBeenCalledWith(h.workspace.rootPath);
    expect(h.activity).not.toHaveBeenCalled();
    await h.switchWorkspace();
    await expect(h.invoke(CHANNELS.detectAgentTools)).rejects.toThrow();
    expect(h.detection).toHaveBeenCalledOnce();
  });

  it("rejects malformed payloads before workspace or session work", async () => {
    const h = await harness();
    for (const channel of channels) await expect(h.invoke(channel, null)).rejects.toThrow();
    expect(h.requireWorkspace).not.toHaveBeenCalled();
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
    expect(h.ended).toHaveBeenCalledTimes(1);
    expect(await h.durableRuns()).toEqual([expect.objectContaining({ id: "run-1", status: status ?? "complete", endedAt: 10 })]);
    await expect(h.invoke(CHANNELS.getAgentRunStatus)).resolves.toMatchObject({ activeRun: null, lastRun: { status: status ?? "complete" } });
  });

  it("forwards main-owned MCP configuration for a shared view", async () => {
    const h = await harness(true);
    await expect(h.invoke(CHANNELS.getMcpConfig)).resolves.toEqual({
      command: "dohc-mcp", args: ["--workspace", h.workspace.rootPath], workspacePath: h.workspace.rootPath, home: h.workspace.rootPath,
    });
    expect(h.shareAccess).toHaveBeenCalledWith(sharedView);
    expect(h.config).toHaveBeenCalledWith(h.workspace.rootPath, "view");
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

  it("rejects malformed dispatch results at their bridge schemas", async () => {
    const h = await harness();
    h.dispatch.dispatchStateForThread.mockResolvedValue({ liveRunId: null, pendingCount: -1, paused: false });
    h.dispatch.runnerSelfTest.mockResolvedValue({ ok: true, detail: "" });
    await expect(h.invoke(CHANNELS.chatDispatchStateForThread, threadPayload)).rejects.toThrow();
    await expect(h.invoke(CHANNELS.runnerSelfTest)).rejects.toThrow();
  });
});
