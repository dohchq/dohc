import { join } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunsIpc } from "./agentRunsIpc";
import { CHANNELS } from "./channels";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import { createRendererWorkspaceOperationRunner } from "../window/rendererWorkspaceOperation";
import { agentRunsFileName, createAgentIntegration, AgentIntegrationState } from "../agents/AgentIntegration";
import type { ChatDispatchService } from "../agents/chatDispatchService";
import type { LiveAgentDispatchStoreHandle } from "../agents/liveAgentDispatchStore";
import { createTestScratch } from "../workspaces/testTemp";
import { canonicalWorkspaceRoot } from "../workspaces/createWorkspaceFolder";
import { deferred } from "../testing/deferred";

class Sender {
  #destroyed = false;
  readonly #onDestroyed: Array<() => void> = [];
  constructor(readonly id: number) {}
  isDestroyed() { return this.#destroyed; }
  once(_event: "destroyed", listener: () => void): this { this.#onDestroyed.push(listener); return this; }
  destroy(): void {
    this.#destroyed = true;
    for (const listener of this.#onDestroyed.splice(0)) listener();
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const sharedView = {
  shareId: "share", granterEmail: null, genericChatWritable: false,
  grantedSelector: { paths: [], versionId: null, access: "view" as const },
};

async function harness(shared = false, hooks: { disposeState?: () => void } = {}) {
  const rootPath = canonicalWorkspaceRoot(await createTestScratch("agent-runs-ipc-"));
  const registry = createRegistryStore(join(rootPath, "registry.json"));
  const workspace: RegistryEntry = {
    workspaceId: "workspace-a", rootPath, kind: "personal", mode: "local-first",
    ...(shared ? { shareView: sharedView } : {}),
  };
  registry.register(workspace);
  await mkdir(join(rootPath, "other"));
  registry.register({ ...workspace, workspaceId: "other", rootPath: join(rootPath, "other") });
  const sender = new Sender(7);
  const events: string[] = [];
  const authority = createWorkspaceAuthorityOwner({
    findWorkspace: registry.find,
    canonicalizeRoot: realpathSync.native,
    createState: () => new AgentIntegrationState(),
    ...(hooks.disposeState ? { disposeState: hooks.disposeState } : {}),
  });
  const held = authority.acquire(workspace.workspaceId);
  const physical = { ...workspace, rootPath: held.binding.canonicalRootPath, attachmentId: held.binding.attachmentId };
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
    localPersonId: () => "person-local",
    installId: () => "install-local",
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
    retryStoppedRun: vi.fn<ChatDispatchService["retryStoppedRun"]>(async () => { events.push("retry"); return true; }),
    runnerSelfTest: vi.fn<ChatDispatchService["runnerSelfTest"]>(async () => { events.push("self-test"); return { ok: true, detail: "Ready" }; }),
  };
  const shareAccess = vi.fn((_view: unknown) => "view" as const);
  const config = vi.fn((root: string, _access: unknown) => ({ command: "dohc-mcp", args: ["--workspace", root], workspacePath: root, home: rootPath }));
  const handlers = new Map<string, (event: { sender: Sender }, payload: unknown) => unknown>();
  const detection = vi.fn(async (_root: string, _signal?: AbortSignal) => []);
  const registrations = createAgentRunsIpc({
    detectAgentTools: detection,
    registerHandler: (channel, handler) => { if (handlers.has(channel)) throw new Error("duplicate registration"); handlers.set(channel, handler); },
    assertTrustedSender: (event: { sender: Sender }) => { if (event.sender.id === -1) throw new Error("untrusted"); },
    withRendererWorkspaceOperation,
    requireEngineCapture: requireCapture, linkedChatStoreFor: () => ({ ensureOpen }),
    agentDispatchStoreHandleFor: () => ({ store: { runRecordsForThread: records } }),
    assertAgentRunnableWorkspace: runnable, assertChatRunnerIdle: idle,
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
    durableRuns: async () => JSON.parse(await readFile(join(rootPath, ".dohc", "agent-runs", agentRunsFileName("install-local")), "utf8")),
    switchWorkspace: async () => {
      const other = { ...physical, workspaceId: "workspace-b", attachmentId: Symbol("other") };
      await renderers.open(sender, other, "document-1");
    },
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

const channels = [
  CHANNELS.chatRunRecordsForThread,
  CHANNELS.detectAgentTools, CHANNELS.startAgentRun, CHANNELS.endAgentRun, CHANNELS.getAgentRunStatus, CHANNELS.getMcpConfig,
  CHANNELS.stopAgentRun, CHANNELS.chatDispatchStateForThread, CHANNELS.resumeThreadDispatch, CHANNELS.retryStoppedRun,
  CHANNELS.runnerSelfTest,
];
const threadPayload = { workspaceId: "workspace-a", threadId: "thread-1" };

const detectionRetirements: ReadonlyArray<{ readonly path: string; readonly retire: (h: Harness) => unknown }> = [
  { path: "switches workspaces", retire: (h) => h.switchWorkspace() },
  { path: "reloads", retire: (h) => h.renderers.retireForReload(h.sender, "document-1") },
  { path: "crashes", retire: (h) => h.renderers.retireAfterCrash(h.sender) },
  { path: "is destroyed", retire: (h) => { h.sender.destroy(); } },
  {
    path: "loses its sender id to a new renderer",
    retire: (h) => h.renderers.open(new Sender(7), { ...h.physical, workspaceId: "workspace-b", attachmentId: Symbol("workspace-b") }, "document-2"),
  },
];

describe("agent run IPC registrations", () => {
  it.each([
    CHANNELS.startAgentRun, CHANNELS.endAgentRun, CHANNELS.getAgentRunStatus,
    CHANNELS.getMcpConfig, CHANNELS.runnerSelfTest, CHANNELS.chatRunRecordsForThread,
    CHANNELS.chatDispatchStateForThread, CHANNELS.resumeThreadDispatch, CHANNELS.retryStoppedRun,
  ])("binds %s to the sender before calling services", async channel => {
    const h = await harness();
    const end = vi.spyOn(h.integration, "endAgentRun");
    const status = vi.spyOn(h.integration, "getAgentRunStatus");
    const input = { workspaceId: "workspace-a",
      ...(channel === CHANNELS.endAgentRun || channel === CHANNELS.retryStoppedRun ? { runId: "run-1" } : {}),
      ...(channel === CHANNELS.chatRunRecordsForThread || channel === CHANNELS.chatDispatchStateForThread || channel === CHANNELS.resumeThreadDispatch
        || channel === CHANNELS.retryStoppedRun
        ? { threadId: "thread-1" } : {}) };
    if (channel === CHANNELS.endAgentRun) await h.invoke(CHANNELS.startAgentRun);
    await h.invoke(channel, input);
    const services = [h.requireWorkspace, h.requireCapture, h.ensureOpen, h.records,
      h.runnable, h.idle, h.start, end, status, h.shareAccess, h.config,
      h.writable, h.activity, ...Object.values(h.dispatch)];
    services.forEach(service => service.mockClear());
    await expect(h.invoke(channel, { ...input, workspaceId: "other" })).rejects.toThrow("no longer active");
    services.forEach(service => expect(service).not.toHaveBeenCalled());
  });
  it("releases admission before a held runner self-test so retirement can finish", async () => {
    const disposed = vi.fn();
    const h = await harness(false, { disposeState: disposed });
    const entered = deferred<void>();
    const drain = deferred<{ ok: boolean; detail: string }>();
    h.dispatch.runnerSelfTest.mockImplementation(() => { entered.resolve(); return drain.promise; });
    const result = h.invoke(CHANNELS.runnerSelfTest);
    let retiring: Promise<void> | undefined;
    try {
      await entered.promise;
      retiring = h.authority.invalidate(h.workspace.workspaceId);
      await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
      await retiring;
    } finally {
      drain.resolve({ ok: true, detail: "Ready" });
      await Promise.allSettled([result, retiring]);
    }
    await expect(result).resolves.toEqual({ ok: true, detail: "Ready" });
  });

  it("registers each original group and rejects untrusted callers before parsing", async () => {
    const h = await harness();
    expect(h.groupSizes).toEqual([1, 11]);
    expect([...h.handlers.keys()]).toEqual(channels);
    for (const channel of channels) await expect(h.invoke(channel, null, new Sender(-1))).rejects.toThrow("untrusted");
    expect(h.requireWorkspace).not.toHaveBeenCalled();
  });

  it("detects tools only for the active workspace without starting a session", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.detectAgentTools)).resolves.toEqual({ workingDirectory: h.workspace.rootPath, tools: [] });
    expect(h.detection).toHaveBeenCalledOnce();
    expect(h.detection).toHaveBeenCalledWith(h.physical.rootPath, expect.any(AbortSignal));
    expect(h.activity).not.toHaveBeenCalled();
    await h.switchWorkspace();
    await expect(h.invoke(CHANNELS.detectAgentTools)).rejects.toThrow();
    expect(h.detection).toHaveBeenCalledOnce();
  });

  it("cancels admitted detection when its authority retires and disposes only after detection drains", async () => {
    const order: string[] = [];
    const h = await harness(false, { disposeState: () => { order.push("disposed"); } });
    const entered = deferred<void>();
    const drain = deferred<void>();
    const cancellation = new Error("Agent detection was cancelled.");
    let removeAbortListener = (): void => undefined;
    h.detection.mockImplementation((_root, signal) => {
      if (signal) {
        const onAbort = (): void => { order.push("cancelled"); };
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }
      }
      entered.resolve();
      return drain.promise.then(() => {
        order.push("drained");
        throw cancellation;
      });
    });
    const outcome = h.invoke(CHANNELS.detectAgentTools).then(() => undefined, (reason: unknown) => reason);
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      closing = h.authority.invalidate(h.workspace.workspaceId);
      expect([...order]).toEqual(["cancelled"]);
    } finally {
      drain.resolve();
      removeAbortListener();
      await Promise.allSettled([outcome, ...(closing ? [closing] : [])]);
    }
    expect(await outcome).toBe(cancellation);
    await closing;
    expect(order).toEqual(["cancelled", "drained", "disposed"]);
  });

  it.each(detectionRetirements)("cancels admitted detection when its window $path while another window keeps the workspace", async ({ retire }) => {
    const h = await harness();
    const keeper = new Sender(8);
    await h.renderers.open(keeper, h.physical, "document-keeper");
    const calls: Array<{ readonly signal: AbortSignal; readonly finish: () => void }> = [];
    h.detection.mockImplementation((_root, signal) => new Promise<never[]>((resolve, reject) => {
      if (!signal) { reject(new Error("Detection needs a signal.")); return; }
      signal.addEventListener("abort", () => { reject(signal.reason); }, { once: true });
      calls.push({ signal, finish: () => { resolve([]); } });
    }));
    const retired = h.invoke(CHANNELS.detectAgentTools).then(() => undefined, (error: unknown) => error);
    let kept: Promise<unknown> | undefined;
    let retiring: unknown;
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      kept = h.invoke(CHANNELS.detectAgentTools, undefined, keeper);
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      const [retiredCall, keptCall] = calls;

      retiring = retire(h);
      expect(retiredCall!.signal.aborted).toBe(true);
      expect(keptCall!.signal.aborted).toBe(false);
      expect(await retired).toMatchObject({ message: "Agent detection stopped because this window changed workspaces." });

      keptCall!.finish();
      await expect(kept).resolves.toEqual({ workingDirectory: h.workspace.rootPath, tools: [] });
    } finally {
      for (const call of calls) call.finish();
      await Promise.allSettled([retired, kept, retiring]);
    }
    expect(h.renderers.current(keeper)?.attachmentId).toBe(h.physical.attachmentId);
    expect(h.renderers.isAttachmentOpen(h.physical.attachmentId)).toBe(true);
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
      startedAtMs: 0, endedAtMs: 0, exitCode: 0, logPath: "", failureReason: "internal", failureHandled: true,
    }, pending: {
      workspaceId: "workspace-a", runId: "run-2", threadId: "thread-1", triggerMessageId: "pending", command: "echo later",
      startedAtMs: 1, logPath: "logs/run-2.txt", failureHandled: false,
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

  it.each([CHANNELS.chatRunRecordsForThread, CHANNELS.chatDispatchStateForThread, CHANNELS.resumeThreadDispatch, CHANNELS.retryStoppedRun])("propagates capture refusal before %s store work", async (channel) => {
    const h = await harness();
    h.requireCapture.mockRejectedValue(new Error("capture refused"));
    await expect(h.invoke(channel, channel === CHANNELS.retryStoppedRun ? { ...threadPayload, runId: "run-1" } : threadPayload)).rejects.toThrow("capture refused");
    expect(h.ensureOpen).not.toHaveBeenCalled();
    expect(h.records).not.toHaveBeenCalled();
    expect(h.writable).not.toHaveBeenCalled();
    expect(h.dispatch.dispatchStateForThread).not.toHaveBeenCalled();
    expect(h.dispatch.resumeThreadDispatch).not.toHaveBeenCalled();
    expect(h.dispatch.retryStoppedRun).not.toHaveBeenCalled();
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
    await expect(h.invoke(CHANNELS.getAgentRunStatus)).resolves.toEqual({
      activeRun: null, lastRun: expect.objectContaining({ id: "run-1", status: status ?? "complete" }),
    });
  });

  it.skipIf(process.platform !== "win32")("spells the native operation root like the registry in MCP configuration", async () => {
    const h = await harness();
    expect(h.physical.rootPath).toBe(realpathSync.native(h.workspace.rootPath));
    expect(h.physical.rootPath).not.toBe(h.workspace.rootPath);
    const canonicalRootPath = canonicalWorkspaceRoot(h.physical.rootPath);
    await expect(h.invoke(CHANNELS.getMcpConfig)).resolves.toEqual({
      command: "dohc-mcp", args: ["--workspace", canonicalRootPath], workspacePath: canonicalRootPath, home: h.workspace.rootPath,
    });
    expect(h.config).toHaveBeenCalledWith(canonicalRootPath, "view");
    await expect(h.invoke(CHANNELS.detectAgentTools)).resolves.toEqual({ workingDirectory: canonicalRootPath, tools: [] });
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

  it("requires writable admission for Try again on a stopped run", async () => {
    const h = await harness();
    const retry = { ...threadPayload, runId: "run-1" };
    h.writable.mockImplementationOnce(() => { throw new Error("read-only"); });
    await expect(h.invoke(CHANNELS.retryStoppedRun, retry)).rejects.toThrow("read-only");
    expect(h.dispatch.retryStoppedRun).not.toHaveBeenCalled();
    h.events.length = 0;
    await expect(h.invoke(CHANNELS.retryStoppedRun, retry)).resolves.toEqual({ queued: true });
    expect(h.events).toEqual(["capture", "writable", "retry"]);
    expect(h.dispatch.retryStoppedRun).toHaveBeenCalledWith("workspace-a", "thread-1", "run-1");
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
