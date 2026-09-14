import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import { CHANNELS } from "./channels";
import { normalizeAbsolutePath } from "@dohc/workspace-core";
import { type SyncStatusResult, type WorkspaceSummary } from "./bridgeContract";
import {
  createWorkspaceRootApproval,
  registerOpenWorkspaceIpcHandler,
  registerWorkspaceRegistryIpcHandlers,
} from "./workspaceRegistryIpc";
import { RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";

type Event = { trusted: boolean };

afterEach(() => vi.unstubAllEnvs());

async function registryHarness() {
  const home = await createTestScratch("registry-ipc-");
  const roots = createWorkspaceRootApproval(() => home);
  const handlers = new Map<string, (event: Event, payload: unknown) => unknown>();
  const summaries: WorkspaceSummary[] = [];
  const steps: string[] = [];
  const createFolder = vi.fn(async (input: { rootPath: string; kind: "personal" | "shared" }) => {
    steps.push("create");
    return { workspaceId: "workspace", ...input, mode: defaultWorkspaceMode(input.kind) };
  });
  const register = vi.fn((summary: WorkspaceSummary) => { steps.push("register"); summaries.push(summary); });
  const refresh = vi.fn(() => { steps.push("refresh"); });
  const pick = vi.fn(async () => ({ canceled: false, filePaths: [join(home, "picked")] }));
  const forget = vi.fn(async (_workspaceId: string) => { steps.push("forget"); });
  const reveal = vi.fn((_path: string) => { steps.push("reveal"); });
  registerWorkspaceRegistryIpcHandlers<Event>({
    registerHandler: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler); },
    assertTrustedSender: (event) => { if (!event.trusted) throw new Error("untrusted"); },
    app: { isPackaged: false }, dialog: { showOpenDialog: pick }, roots,
    effectiveHome: () => home, workspaceSummaries: () => summaries,
    prioritizePreferredWorkspace: (rows) => [...rows].reverse(),
    createWorkspaceFolder: createFolder, registerPhysicalWorkspace: register,
    forgetWorkspace: forget, showItemInFolder: reveal,
    openWorkspaceWindow: async () => undefined, openWorkspaceManager: () => undefined, closeWindowOf: () => undefined,
    refreshNativeWorkspaceSurfaces: refresh,
    desktopMarks: { mark: () => { steps.push("mark"); }, measureSince: () => { steps.push("measure"); } },
  });
  const invoke = async (channel: string, payload?: unknown, trusted = true) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing ${channel}`);
    return handler({ trusted }, payload);
  };
  return { home, roots, handlers, createFolder, register, refresh, pick, forget, reveal, steps, summaries, invoke };
}

describe("registered workspace registry handlers", () => {
  it("registers the registry channels and rejects untrusted senders before work", async () => {
    const h = await registryHarness();
    expect([...h.handlers.keys()]).toEqual([
      CHANNELS.pickWorkspaceRoot, CHANNELS.getWorkspaceRegistry, CHANNELS.getDefaultWorkspaceRoot,
      CHANNELS.getDefaultShareRoot,
      CHANNELS.createLocalWorkspace, CHANNELS.attachWorkspaceFolder,
      CHANNELS.forgetWorkspace, CHANNELS.openWorkspaceWindow, CHANNELS.openWorkspaceManager,
      CHANNELS.closeThisWindow, CHANNELS.revealWorkspaceFolder,
    ]);
    for (const channel of h.handlers.keys()) await expect(h.invoke(channel, null, false)).rejects.toThrow("untrusted");
    expect(h.pick).not.toHaveBeenCalled();
    expect(h.createFolder).not.toHaveBeenCalled();
  });

  it("approves a default share root under the default workspace root", async () => {
    const h = await registryHarness();
    const root = await h.invoke(CHANNELS.getDefaultWorkspaceRoot) as string;
    const shareRoot = await h.invoke(CHANNELS.getDefaultShareRoot, { shareId: "trip-2026" }) as string;
    expect(shareRoot).toBe(`${root}/shared/trip-2026`);
    expect(h.roots.usableRoot(shareRoot)).toBe(normalizeAbsolutePath(shareRoot));
    await expect(h.invoke(CHANNELS.getDefaultShareRoot, { shareId: "../escape" })).rejects.toThrow();
    await expect(h.invoke(CHANNELS.getDefaultShareRoot, { shareId: "Upper" })).rejects.toThrow();
  });

  it("shares exact root approval with later consumers and refuses sibling spellings", async () => {
    const h = await registryHarness();
    const root = await h.invoke(CHANNELS.getDefaultWorkspaceRoot) as string;
    const child = join(root, "project");
    await expect(h.invoke(CHANNELS.createLocalWorkspace, { rootPath: child, kind: "shared" }))
      .resolves.toMatchObject({ kind: "shared", rootPath: h.roots.usableRoot(child) });
    expect(h.steps).toEqual(["mark", "create", "measure", "register", "refresh"]);
    expect(() => h.roots.usableRoot(`${root}-unapproved`)).toThrow("chosen through dohc");
    await expect(h.invoke(CHANNELS.attachWorkspaceFolder, { rootPath: join(h.home, "unapproved") }))
      .rejects.toThrow("chosen through dohc");
    expect(h.createFolder).toHaveBeenCalledOnce();
  });

  it("uses each dialog pick and preserves attach identity and registry ordering", async () => {
    const h = await registryHarness();
    const picked = await h.invoke(CHANNELS.pickWorkspaceRoot) as string;
    await expect(h.invoke(CHANNELS.attachWorkspaceFolder, { rootPath: picked }))
      .resolves.toMatchObject({ workspaceId: "workspace", kind: "personal" });
    h.summaries.push({ ...h.summaries[0]!, workspaceId: "other" });
    await expect(h.invoke(CHANNELS.getWorkspaceRegistry)).resolves.toEqual({ workspaces: [...h.summaries].reverse() });
    h.pick.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(h.invoke(CHANNELS.pickWorkspaceRoot)).resolves.toBeNull();
  });

  it.each([CHANNELS.createLocalWorkspace, CHANNELS.attachWorkspaceFolder])(
    "rejects a malformed created summary before persistence for %s", async (channel) => {
      const h = await registryHarness();
      const rootPath = await h.invoke(CHANNELS.getDefaultWorkspaceRoot) as string;
      h.createFolder.mockResolvedValue({ workspaceId: "INVALID ID", rootPath, kind: "personal", mode: "local-first" });
      await expect(h.invoke(channel, { rootPath, kind: "personal" })).rejects.toThrow();
      expect(h.register).not.toHaveBeenCalled();
      expect(h.refresh).not.toHaveBeenCalled();
    },
  );

  it("reads the unpackaged test picker per invoke without opening a dialog", async () => {
    const h = await registryHarness();
    vi.stubEnv("DOHC_DESKTOP_TEST", "1");
    for (const name of ["first", "second"]) {
      const path = join(h.home, name);
      vi.stubEnv("DOHC_TEST_PICK_PATH", path);
      await expect(h.invoke(CHANNELS.pickWorkspaceRoot)).resolves.toBe(path);
      expect(h.roots.usableRoot(path)).toBe(path.replaceAll("\\", "/"));
    }
    expect(h.pick).not.toHaveBeenCalled();
  });
});

const documentId = "a1d393d4-32c0-4ab5-a4e5-dae30be844c9";
const status: SyncStatusResult = {
  state: "synced", pendingChangeCount: 0, lastSyncedAtMs: null,
  historyRecordingUnavailable: false, historyShareView: false, liveSessionsGeneration: 0,
};

function openHarness() {
  const sender = { id: 1, isDestroyed: () => false, once: vi.fn() };
  type OpenEvent = { sender: typeof sender; trusted: boolean };
  const workspace = {
    workspaceId: "workspace", rootPath: "C:/workspace", kind: "personal" as const,
    mode: "local-first" as const, attachmentId: Symbol("attachment"),
  };
  const sessions = new RendererWorkspaceSessionOwner<typeof sender>({
    retirement: {
      retireSender: () => ({ requiredForAdmission: Promise.resolve(), detachedFromAdmission: Promise.resolve() }),
      retireWorkspace: async () => undefined,
    },
  });
  let physicalCurrent = true;
  let warmupWorkspace = workspace;
  const warmup = vi.fn<() => Promise<void>>(async () => undefined);
  const operation = {
    workspace, state: { pluginRuntimes: { ensure: warmup } },
    assertCurrent: () => { if (!physicalCurrent) throw new Error("physical retired"); },
  };
  let calls = 0;
  const withPhysicalWorkspaceOperation = async <Result>(id: string, work: (op: typeof operation) => Result | Promise<Result>) => {
    expect(id).toBe(workspace.workspaceId);
    calls += 1;
    return work(calls === 1 ? operation : { ...operation, workspace: warmupWorkspace });
  };
  const activity = vi.fn(async () => status);
  const projection = vi.fn(async (_workspace: typeof workspace, value: SyncStatusResult) => value);
  const preferred = vi.fn();
  const opened = vi.fn();
  const shared = vi.fn<() => unknown>(() => null);
  const handlers = new Map<string, (event: OpenEvent, payload: unknown) => unknown>();
  registerOpenWorkspaceIpcHandler<typeof sender, OpenEvent, typeof workspace, typeof operation>({
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: (event) => { if (!event.trusted) throw new Error("untrusted"); },
    withPhysicalWorkspaceOperation, rendererWorkspaceSessions: sessions,
    setPreferredWorkspaceId: preferred, markWorkspaceOpened: opened, openWorkspaceActivity: activity,
    syncStatusWithOwnedProjection: projection, sharedViewOf: shared,
  });
  const invoke = async (trusted = true) => handlers.get(CHANNELS.openWorkspace)!({ sender, trusted }, {
    workspaceId: workspace.workspaceId, rendererDocumentId: documentId,
  });
  return {
    sender, workspace, sessions, activity, projection, preferred, opened, shared, warmup, handlers, invoke,
    retirePhysical: () => { physicalCurrent = false; },
    replaceWarmupAttachment: () => { warmupWorkspace = { ...workspace, attachmentId: Symbol("replacement") }; },
  };
}

describe("registered workspace open", () => {
  it("opens the renderer session before activity and preserves preferred selection", async () => {
    const h = openHarness();
    expect([...h.handlers.keys()]).toEqual([CHANNELS.openWorkspace]);
    await expect(h.invoke(false)).rejects.toThrow("untrusted");
    expect(h.activity).not.toHaveBeenCalled();
    await expect(h.invoke()).resolves.toEqual(status);
    expect(h.preferred).toHaveBeenCalledWith("workspace");
    expect(h.opened).toHaveBeenCalledWith("workspace");
    expect(h.projection).toHaveBeenCalledWith(h.workspace, status);
    expect(h.warmup).toHaveBeenCalledWith(h.workspace);
  });

  it.each(["renderer", "physical"] as const)("rejects %s retirement during activity before warmup", async (kind) => {
    const h = openHarness();
    const held = deferred<SyncStatusResult>();
    const started = deferred();
    h.activity.mockImplementation(() => { started.resolve(); return held.promise; });
    const result = h.invoke();
    await started.promise;
    if (kind === "physical") h.retirePhysical();
    else await h.sessions.open(h.sender, { workspaceId: "other", attachmentId: Symbol("other") }, documentId);
    held.resolve(status);
    await expect(result).rejects.toThrow();
    expect(h.warmup).not.toHaveBeenCalled();
  });

  it("skips plugin warmup for shared views and successor attachments", async () => {
    const shared = openHarness();
    shared.shared.mockReturnValue({});
    await expect(shared.invoke()).resolves.toEqual(status);
    expect(shared.warmup).not.toHaveBeenCalled();
    const replaced = openHarness();
    replaced.replaceWarmupAttachment();
    await expect(replaced.invoke()).resolves.toEqual(status);
    expect(replaced.warmup).not.toHaveBeenCalled();
  });

  it("does not wait for plugin warmup before returning the opened workspace", async () => {
    const h = openHarness();
    const held = deferred();
    h.warmup.mockImplementation(() => held.promise);
    await expect(h.invoke()).resolves.toEqual(status);
    expect(h.warmup).toHaveBeenCalledOnce();
    held.resolve();
  });
});

describe("forget and reveal", () => {
  it("forgets by id and refreshes native surfaces", async () => {
    const h = await registryHarness();
    await h.invoke(CHANNELS.forgetWorkspace, { workspaceId: "ws-1" });
    expect(h.forget).toHaveBeenCalledWith("ws-1");
    expect(h.steps).toEqual(["forget", "refresh"]);
  });

  it("reveals a registered root and refuses an unknown id", async () => {
    const h = await registryHarness();
    h.summaries.push({ workspaceId: "ws-1", rootPath: "/w/one", kind: "personal", mode: "local-first" });
    await h.invoke(CHANNELS.revealWorkspaceFolder, { workspaceId: "ws-1" });
    expect(h.reveal).toHaveBeenCalledWith("/w/one");
    await expect(h.invoke(CHANNELS.revealWorkspaceFolder, { workspaceId: "ws-9" })).rejects.toThrow("not in the registry");
  });
});
