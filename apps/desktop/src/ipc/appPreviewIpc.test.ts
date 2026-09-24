import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppPreviewIpcHandlers } from "./appPreviewIpc";
import { CHANNELS } from "./channels";
import type { SitePreviewExecutionInput } from "./sitePreviewIpc";
import type { SitePackageInfo } from "../workspaces/sitePackage";
import type { SiteLogEntry, SiteProcessHandle } from "../workspaces/siteRunner";
import { createSitePreviewLifecycle, START_CANCELLED_MESSAGE } from "../workspaces/sitePreviewLifecycle";
import type { SitePreviewResultBody } from "./sitePreviewIpc";
import { createWorkspaceAuthorityOwner, type PhysicalWorkspace } from "../workspaces/workspaceAuthorityOwner";
import { RendererWorkspaceSessionOwner, type RendererWorkspaceSession } from "../window/rendererWorkspaceSessionOwner";
import { createRendererWorkspaceOperationRunner, type ExactRendererWorkspaceOperation } from "../window/rendererWorkspaceOperation";
import { createDesktopRendererWorkspaceRetirement } from "../mainRendererWorkspaceRetirement";
import { deferred, type Deferred } from "../testing/deferred";

const DOCUMENT = "123e4567-e89b-42d3-a456-426614174001";
const startPayload = { workspaceId: "a", siteRoot: "app", mode: "static", holderId: "tab", restart: false };
const appPayload = { workspaceId: "a", siteRoot: "app", holderId: "tab" };
const cleanup: Array<() => Promise<void>> = [];
function sender(id: number) {
  return { id, isDestroyed: () => false, once(_event: "destroyed", _listener: () => void) { return this; } };
}
type Sender = ReturnType<typeof sender>;
type Event = { sender: Sender; trusted: boolean };
type Workspace = { workspaceId: string; rootPath: string };
type AppState = { sitePreviews: ReturnType<typeof createSitePreviewLifecycle<SitePreviewResultBody>> };
type Operation = ExactRendererWorkspaceOperation<PhysicalWorkspace<Workspace>, AppState, RendererWorkspaceSession<Sender>>;

function appInfo(root = "app"): SitePackageInfo {
  return {
    root, title: "App", kind: "static", confidence: "high", entryPath: `${root}/index.html`,
    configPath: null, packagePath: null, packageManager: null, scripts: {}, configuredScripts: {},
    configuredPreviewMode: "static", configuredBuildOutput: null, buildOutputs: [],
    sourceFiles: [`${root}/index.html`], shareManifest: { ok: false, reason: "no-runnable-artifact" },
    diagnostics: [], authority: { kind: "workspace" },
  };
}

function processHandle(workspaceId: string) {
  let exit: () => void = () => undefined;
  const logs: SiteLogEntry[] = [{ stream: "stdout", text: workspaceId, at: 1 }];
  return {
    url: "http://127.0.0.1:4173/", command: "dev", args: [], cwd: `/canonical/${workspaceId}/app`,
    logs: vi.fn(() => logs), onExit: vi.fn((listener: () => void) => { exit = listener; }),
    stop: vi.fn(async () => undefined), exit: () => exit(),
  } satisfies SiteProcessHandle & { exit(): void };
}

async function harness() {
  const entries = new Map<string, Workspace>(["a", "b"].map(workspaceId => [workspaceId, { workspaceId, rootPath: `/registered/${workspaceId}` }]));
  const states = new Map<symbol, AppState>();
  const allowOrigin = vi.fn((_url: string) => vi.fn());
  const authorities = createWorkspaceAuthorityOwner<Workspace, AppState>({
    findWorkspace: id => entries.get(id) ?? null,
    canonicalizeRoot: root => root.replace("/registered/", "/canonical/"),
    createState: binding => {
      const state = { sitePreviews: createSitePreviewLifecycle<SitePreviewResultBody>({ allowOrigin }) };
      states.set(binding.attachmentId, state); return state;
    },
    disposeState: state => state.sitePreviews.stopAll(),
  });
  const retirementErrors = vi.fn();
  const sessions = new RendererWorkspaceSessionOwner<Sender>({ retirement: createDesktopRendererWorkspaceRetirement({
    engineYDoc: { retireSender: async () => undefined },
    pluginSurfaces: { stop: async () => undefined },
    pluginRuntimes: { stop: async (_workspace, beforeDispose) => beforeDispose() },
    workspaceSearch: { disposeSender: async () => undefined },
    presencePolls: { disposeSender: () => undefined },
    presenceMutations: { retireSender: async () => undefined },
    sitePreviews: {
      cancelSender: id => { for (const state of states.values()) state.sitePreviews.cancelSender(id); },
      stopWorkspace: async workspace => { await states.get(workspace.attachmentId)?.sitePreviews.stopWorkspace(workspace.workspaceId); },
    },
    onCleanupError: retirementErrors,
  }) });
  const workspaceA = await authorities.withOperation("a", operation => operation.workspace);
  const workspaceB = await authorities.withOperation("b", operation => operation.workspace);
  const first = sender(1), second = sender(2);
  await sessions.open(first, workspaceA, DOCUMENT);
  await sessions.open(second, workspaceA, DOCUMENT);
  let admission: { reached: Deferred; release: Deferred } | undefined;
  const withRendererWorkspaceOperation = createRendererWorkspaceOperationRunner<Sender, PhysicalWorkspace<Workspace>, AppState, RendererWorkspaceSession<Sender>>({
    currentSession: value => sessions.current(value),
    withPhysicalOperation: async (id, work) => {
      const held = admission;
      if (held) { held.reached.resolve(); await held.release.promise; }
      return authorities.withOperation(id, work);
    },
  });
  const handles = { a: processHandle("a"), b: processHandle("b") };
  const executeAppPreview = vi.fn(async (input: SitePreviewExecutionInput) => ({
    handle: input.workspaceId === "a" ? handles.a : handles.b,
    result: { siteRoot: input.site.root, mode: input.mode, logs: [] },
  }));
  const get = vi.fn(async (_workspace: PhysicalWorkspace<Workspace>, root: string, _mode: unknown): Promise<SitePackageInfo | null> => appInfo(root));
  const isSharedView = vi.fn((_workspaceId: string) => false);
  const appPreviews: Pick<AppState["sitePreviews"], "acquire"> = {
    acquire: input => authorities.withAuthority(input.workspaceId, lease => lease.state.sitePreviews.acquire(input)),
  };
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const assertTrustedSender = (event: Event) => { if (!event.trusted) throw new Error("untrusted"); };
  registerAppPreviewIpcHandlers<Sender, Event, PhysicalWorkspace<Workspace>, Operation>({
    registerHandler: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    assertTrustedSender, senderWorkspaceAuthority: { requireTrustedSender: event => { assertTrustedSender(event); return event.sender; } },
    withRendererWorkspaceOperation, appCatalog: { list: async () => [], get }, appPreviews,
    isSharedView, executeAppPreview,
  });
  cleanup.push(async () => {
    await Promise.all([...states.values()].map(state => state.sitePreviews.stopAll()));
    await Promise.all([sessions.retireAfterCrash(first), sessions.retireAfterCrash(second)]);
    await authorities.close();
    expect(retirementErrors).not.toHaveBeenCalled();
  });
  return {
    first, second, handlers, sessions, authorities, workspaceA, workspaceB, handles,
    stateA: states.get(workspaceA.attachmentId)!, stateB: states.get(workspaceB.attachmentId)!,
    get, isSharedView, executeAppPreview, allowOrigin,
    holdAdmission: (held: typeof admission) => { admission = held; },
    open: (value: Sender, workspace = workspaceB) => sessions.open(value, workspace, DOCUMENT),
    invoke: async (channel: string, payload: unknown, value = first, trusted = true) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing handler: ${channel}`);
      return handler({ sender: value, trusted }, payload);
    },
  };
}

afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

describe("registered app preview IPC", () => {
  it("registers the original three channels and rejects untrusted or invalid requests", async () => {
    const h = await harness();
    expect([...h.handlers.keys()]).toEqual([CHANNELS.startSitePreview, CHANNELS.getSitePreviewLogs, CHANNELS.stopSitePreview]);
    for (const [channel, payload] of [
      [CHANNELS.startSitePreview, startPayload], [CHANNELS.getSitePreviewLogs, appPayload], [CHANNELS.stopSitePreview, appPayload],
    ] as const) {
      await expect(h.invoke(channel, payload, h.first, false)).rejects.toThrow("untrusted");
      await expect(h.invoke(channel, {})).rejects.toThrow();
    }
    expect(h.get).not.toHaveBeenCalled();
    expect(h.executeAppPreview).not.toHaveBeenCalled();
    expect(h.handles.a.stop).not.toHaveBeenCalled();
  });

  it("uses canonical workspace execution and the same lifecycle for logs and stop", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.startSitePreview, startPayload)).resolves.toEqual({ siteRoot: "app", mode: "static", logs: [], url: h.handles.a.url, exited: false });
    expect(h.get).toHaveBeenCalledWith(h.workspaceA, "app", "static");
    expect(h.executeAppPreview).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "a", workspaceRoot: "/canonical/a", sharedView: false, signal: expect.any(AbortSignal), isCurrent: expect.any(Function) }));
    await expect(h.invoke(CHANNELS.getSitePreviewLogs, appPayload)).resolves.toEqual({ logs: h.handles.a.logs(), exited: false });
    expect(h.stateA.sitePreviews.status("a", "app").running).toBe(true);
    await expect(h.invoke(CHANNELS.stopSitePreview, appPayload)).resolves.toBeUndefined();
    expect(h.handles.a.stop).toHaveBeenCalledOnce();
    expect(h.handles.b.stop).not.toHaveBeenCalled();
    expect(h.allowOrigin.mock.results[0]?.value).toHaveBeenCalledOnce();
    await expect(h.invoke(CHANNELS.getSitePreviewLogs, appPayload)).resolves.toEqual({ logs: [], exited: false });
    expect(h.stateA.sitePreviews.status("a", "app").running).toBe(false);
  });

  it.each(["dev", "build"])("refuses %s execution in a shared view before catalog lookup", async mode => {
    const h = await harness(); h.isSharedView.mockReturnValue(true);
    await expect(h.invoke(CHANNELS.startSitePreview, { ...startPayload, mode })).rejects.toThrow("disabled in a shared view");
    expect(h.get).not.toHaveBeenCalled();
    expect(h.executeAppPreview).not.toHaveBeenCalled();
  });

  it("allows static execution in a shared view", async () => {
    const h = await harness(); h.isSharedView.mockReturnValue(true);
    await expect(h.invoke(CHANNELS.startSitePreview, startPayload)).resolves.toMatchObject({ mode: "static", exited: false });
    expect(h.executeAppPreview).toHaveBeenCalledWith(expect.objectContaining({ sharedView: true }));
  });

  it("refuses running app code from shared-with-me before catalog lookup", async () => {
    const h = await harness();
    await expect(h.invoke(CHANNELS.startSitePreview, { ...startPayload, mode: "dev", siteRoot: "shared-with-me/team/app" })).rejects.toThrow("Apps opened from shared-with-me use the static preview");
    expect(h.get).not.toHaveBeenCalled();
    expect(h.executeAppPreview).not.toHaveBeenCalled();
  });

  it("rejects an ancestor catalog match without executing it", async () => {
    const h = await harness(); h.get.mockResolvedValueOnce(appInfo("ancestor"));
    await expect(h.invoke(CHANNELS.startSitePreview, startPayload)).rejects.toThrow("Not a detected app: app");
    expect(h.executeAppPreview).not.toHaveBeenCalled();
  });

  it.each([CHANNELS.startSitePreview, CHANNELS.getSitePreviewLogs, CHANNELS.stopSitePreview])("requires the sender's active attachment for %s", async channel => {
    const h = await harness();
    await expect(h.invoke(channel, { ...startPayload, workspaceId: "b" })).rejects.toThrow("does not target the active workspace");
    expect(h.get).not.toHaveBeenCalled();
    expect(h.handles.b.stop).not.toHaveBeenCalled();
  });

  it("rejects the originally captured renderer after delayed physical admission", async () => {
    const h = await harness();
    const held = { reached: deferred(), release: deferred() }; h.holdAdmission(held);
    const starting = h.invoke(CHANNELS.startSitePreview, startPayload);
    const rejected = expect(starting).rejects.toThrow("does not target the active workspace");
    try {
      await held.reached.promise;
      await h.open(h.first);
    } finally {
      held.release.resolve();
      await rejected;
    }
    expect(h.get).not.toHaveBeenCalled();
    expect(h.executeAppPreview).not.toHaveBeenCalled();
  });

  it("does not start a process after the renderer changes during catalog preparation", async () => {
    const h = await harness();
    const reached = deferred(), release = deferred<SitePackageInfo>();
    h.get.mockImplementationOnce(async () => { reached.resolve(); return release.promise; });
    const starting = h.invoke(CHANNELS.startSitePreview, startPayload);
    const rejected = expect(starting).rejects.toThrow(START_CANCELLED_MESSAGE);
    try {
      await reached.promise;
      await h.open(h.first);
    } finally {
      release.resolve(appInfo());
      await rejected;
    }
    expect(h.executeAppPreview).not.toHaveBeenCalled();
    expect(h.allowOrigin).not.toHaveBeenCalled();
  });

  it("rejects a retired physical attachment while catalog preparation is held", async () => {
    const h = await harness();
    const reached = deferred(), release = deferred<SitePackageInfo>();
    h.get.mockImplementationOnce(async () => { reached.resolve(); return release.promise; });
    const starting = h.invoke(CHANNELS.startSitePreview, startPayload);
    const rejected = expect(starting).rejects.toThrow(START_CANCELLED_MESSAGE);
    let retiring: Promise<void> | undefined;
    try {
      await reached.promise;
      retiring = h.authorities.invalidate("a");
    } finally {
      release.resolve(appInfo());
      await Promise.all([rejected, retiring]);
    }
    expect(h.executeAppPreview).not.toHaveBeenCalled();
  });

  it("cleans up a late process without returning its stale URL", async () => {
    const h = await harness();
    const reached = deferred(), release = deferred();
    h.executeAppPreview.mockImplementationOnce(async input => {
      reached.resolve(); await release.promise;
      return { handle: h.handles.a, result: { siteRoot: input.site.root, mode: input.mode, logs: [] } };
    });
    const starting = h.invoke(CHANNELS.startSitePreview, startPayload);
    const rejected = expect(starting).rejects.toThrow(START_CANCELLED_MESSAGE);
    try {
      await reached.promise;
      await h.open(h.first);
    } finally {
      release.resolve();
      await rejected;
    }
    expect(h.handles.a.stop).toHaveBeenCalledOnce();
    expect(h.allowOrigin).not.toHaveBeenCalled();
    expect(h.stateA.sitePreviews.status("a", "app").running).toBe(false);
  });

  it("preserves exited status and retained logs through the registered logs handler", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.startSitePreview, { ...startPayload, mode: "dev" });
    h.handles.a.exit();
    await expect(h.invoke(CHANNELS.getSitePreviewLogs, appPayload)).resolves.toMatchObject({ exited: true, logs: [{ stream: "stdout", text: "a", at: 1 }, { stream: "system", text: "Dev server exited unexpectedly." }] });
    expect(h.stateA.sitePreviews.status("a", "app").running).toBe(false);
  });

  it("rejects a logs result when the renderer changes during the operation", async () => {
    const h = await harness();
    const status = h.stateA.sitePreviews.status;
    let switching: Promise<RendererWorkspaceSession<Sender>> | undefined;
    vi.spyOn(h.stateA.sitePreviews, "status").mockImplementationOnce((workspaceId, root) => {
      const result = status(workspaceId, root); switching = h.open(h.first); return result;
    });
    try {
      await expect(h.invoke(CHANNELS.getSitePreviewLogs, appPayload)).rejects.toThrow("does not target the active workspace");
    } finally {
      await switching;
    }
  });

  it("validates lifecycle log output before returning it", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.startSitePreview, startPayload);
    h.handles.a.logs.mockReturnValueOnce([{ stream: "stdout", text: "x".repeat(10_001), at: 1 }]);
    await expect(h.invoke(CHANNELS.getSitePreviewLogs, appPayload)).rejects.toThrow();
  });

  it("retries a rejected stop using the retained lifecycle handle", async () => {
    const h = await harness();
    await h.invoke(CHANNELS.startSitePreview, startPayload);
    h.handles.a.stop.mockRejectedValueOnce(new Error("process still alive"));
    await expect(h.invoke(CHANNELS.stopSitePreview, appPayload)).rejects.toThrow("process still alive");
    await expect(h.invoke(CHANNELS.getSitePreviewLogs, appPayload)).resolves.toMatchObject({ exited: false });
    expect(h.stateA.sitePreviews.status("a", "app").running).toBe(true);
    await h.invoke(CHANNELS.stopSitePreview, appPayload);
    expect(h.handles.a.stop).toHaveBeenCalledTimes(2);
    await expect(h.invoke(CHANNELS.getSitePreviewLogs, appPayload)).resolves.toEqual({ exited: false, logs: [] });
    expect(h.stateA.sitePreviews.status("a", "app").running).toBe(false);
  });

  it("rechecks the original stop operation after waiting for a start lane", async () => {
    const h = await harness();
    const reached = deferred(), release = deferred();
    h.executeAppPreview.mockImplementationOnce(async input => {
      reached.resolve(); await release.promise;
      return { handle: h.handles.a, result: { siteRoot: input.site.root, mode: input.mode, logs: [] } };
    });
    const starting = h.invoke(CHANNELS.startSitePreview, startPayload, h.second);
    const startRejected = expect(starting).rejects.toThrow(START_CANCELLED_MESSAGE);
    let stopRejected: Promise<void> | undefined;
    try {
      await reached.promise;
      const stopReached = deferred();
      const release = h.stateA.sitePreviews.release;
      vi.spyOn(h.stateA.sitePreviews, "release").mockImplementationOnce(input => {
        const pending = release(input); stopReached.resolve(); return pending;
      });
      const stopping = h.invoke(CHANNELS.stopSitePreview, appPayload);
      stopRejected = expect(stopping).rejects.toThrow("does not target the active workspace");
      await stopReached.promise;
      await h.open(h.first);
    } finally {
      release.resolve();
      await Promise.all([startRejected, stopRejected]);
    }
    expect(h.handles.a.stop).toHaveBeenCalledOnce();
    expect(h.handles.b.stop).not.toHaveBeenCalled();
  });
});
