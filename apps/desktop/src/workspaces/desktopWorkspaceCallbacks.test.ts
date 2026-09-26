import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatcherEvent } from "@dohc/workspace-core";
import { deferred } from "../testing/deferred";
import { createDesktopWorkspaceCallbacks, type DesktopWorkspaceCallbacksDependencies } from "./desktopWorkspaceCallbacks";
import type { RegistryEntry } from "./registryStore";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";

interface State { readonly attachmentId: symbol }
const events: readonly WatcherEvent[] = [
  { path: "notes/first.md", operation: "update", sha256: "new", previousSha256: "old" },
  { path: "notes/renamed.md", fromPath: "notes/before.md", operation: "rename" },
];

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const workspace: RegistryEntry = {
    workspaceId: "workspace-a", rootPath: resolve("callback-workspace"),
    kind: "personal", mode: "local-first",
  };
  const registry = new Map([[workspace.workspaceId, workspace]]);
  const disposed: symbol[] = [];
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: (id) => registry.get(id) ?? null,
    canonicalizeRoot: (path) => path,
    createState: (binding): State => ({ attachmentId: binding.attachmentId }),
    disposeState: (state) => { disposed.push(state.attachmentId); },
  });
  const notifyRenderer = vi.fn<DesktopWorkspaceCallbacksDependencies<State>["notifyRenderer"]>();
  const handleWatcherEvents = vi.fn<(events: readonly WatcherEvent[]) => void>();
  const scanWorkspace = vi.fn<DesktopWorkspaceCallbacksDependencies<State>["chatDispatchService"]["scanWorkspace"]>(async () => undefined);
  const live: {
    dispatch: DesktopWorkspaceCallbacksDependencies<State>["chatDispatchService"];
    initialized: boolean;
  } = { dispatch: { scanWorkspace }, initialized: false };
  const lateReads: string[] = [];
  const callbacks = createDesktopWorkspaceCallbacks({
    findWorkspace: (id) => registry.get(id),
    requireWorkspaceAuthority: (id) => authorities.acquire(id),
    notifyRenderer,
    get workspaceAuthorities() {
      if (!live.initialized) throw new Error("Authority owner is not initialized");
      lateReads.push("authorities"); return authorities;
    },
    get chatDispatchService() {
      if (!live.initialized) throw new Error("Dispatch service is not initialized");
      lateReads.push("dispatch"); return live.dispatch;
    },
    collectionAutomationsOf: () => ({ handleWatcherEvents }),
  });
  live.initialized = true;
  function attach() {
    const lease = authorities.acquire(workspace.workspaceId);
    const attached = { ...workspace, attachmentId: lease.binding.attachmentId };
    lease.release();
    return attached;
  }
  return { workspace, registry, authorities, disposed, notifyRenderer, handleWatcherEvents,
    scanWorkspace, live, lateReads, callbacks, attach };
}

describe("desktop workspace callbacks", () => {
  it("constructs before late owners and forwards the exact watcher batch to the workspace's automations", () => {
    const test = fixture();
    expect(test.lateReads).toEqual([]);
    const workspace = test.attach();
    test.callbacks.onWatcherBatch(workspace, events);
    expect(test.handleWatcherEvents).toHaveBeenCalledOnce();
    expect(test.handleWatcherEvents.mock.calls[0]![0]).toBe(events);
    expect(test.notifyRenderer).not.toHaveBeenCalled();
    expect(test.scanWorkspace).not.toHaveBeenCalled();
  });

  it("drops both actual callbacks during retirement and after identical reattachment", async () => {
    const test = fixture();
    const original = test.attach();
    const oldRelay = test.callbacks.createRelayOnChange(original);
    const held = test.authorities.acquire(original.workspaceId);
    const retired = test.authorities.invalidate(original.workspaceId);
    try {
      test.callbacks.onWatcherBatch(original, events);
      oldRelay();
      expect(test.handleWatcherEvents).not.toHaveBeenCalled();
      expect(test.notifyRenderer).not.toHaveBeenCalled();
      expect(test.scanWorkspace).not.toHaveBeenCalled();
      expect(test.disposed).toEqual([]);
    } finally { held.release(); await retired; }
    const replacement = test.attach();
    expect(replacement.attachmentId).not.toBe(original.attachmentId);
    test.callbacks.onWatcherBatch(original, events);
    oldRelay();
    expect(test.handleWatcherEvents).not.toHaveBeenCalled();
    expect(test.notifyRenderer).not.toHaveBeenCalled();
    test.callbacks.onWatcherBatch(replacement, events);
    test.callbacks.createRelayOnChange(replacement)();
    expect(test.handleWatcherEvents).toHaveBeenCalledOnce();
    expect(test.notifyRenderer).toHaveBeenCalledWith({ workspaceId: original.workspaceId });
    expect(test.scanWorkspace).toHaveBeenCalledExactlyOnceWith(original.workspaceId);
    await test.authorities.invalidate(replacement.workspaceId);
    expect(test.disposed).toEqual([original.attachmentId, replacement.attachmentId]);
  });

  it("drops missing registry callbacks without resolving automation or dispatch owners", () => {
    const test = fixture();
    const workspace = test.attach();
    test.registry.delete(workspace.workspaceId);
    test.callbacks.onWatcherBatch(workspace, events);
    test.callbacks.createRelayOnChange(workspace)();
    expect(test.handleWatcherEvents).not.toHaveBeenCalled();
    expect(test.notifyRenderer).not.toHaveBeenCalled();
    expect(test.scanWorkspace).not.toHaveBeenCalled();
    expect(test.lateReads).toEqual([]);
  });

  it("keeps a watcher lease alive during a reentrant retirement and releases it on failure", async () => {
    const test = fixture();
    const workspace = test.attach();
    const failed = new Error("watcher consumer failed");
    let retired!: Promise<void>;
    test.handleWatcherEvents.mockImplementation(() => {
      retired = test.authorities.invalidate(workspace.workspaceId);
      expect(test.disposed).toEqual([]);
      throw failed;
    });
    expect(() => test.callbacks.onWatcherBatch(workspace, events)).toThrow(failed);
    await retired;
    expect(test.disposed).toEqual([workspace.attachmentId]);
  });

  it("holds relay dispatch's admitted lease until its scan settles during retirement", async () => {
    const test = fixture();
    const workspace = test.attach();
    const scan = deferred();
    const started = deferred();
    test.scanWorkspace.mockImplementation(() => { started.resolve(); return scan.promise; });
    const callback = test.callbacks.createRelayOnChange(workspace);
    expect(callback()).toBeUndefined();
    await started.promise;
    const retired = test.authorities.invalidate(workspace.workspaceId);
    try {
      expect(test.disposed).toEqual([]);
      expect(() => test.attach()).toThrow("retiring or blocked");
      callback();
      test.callbacks.onWatcherBatch(workspace, events);
      expect(test.notifyRenderer).toHaveBeenCalledOnce();
      expect(test.scanWorkspace).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId);
      expect(test.handleWatcherEvents).not.toHaveBeenCalled();
      scan.resolve();
      await retired;
      expect(test.disposed).toEqual([workspace.attachmentId]);
      expect(test.notifyRenderer).toHaveBeenCalledOnce();
    } finally { scan.resolve(); await retired; }
  });

  it("reports relay dispatch rejection with the original error and releases its lease", async () => {
    const test = fixture();
    const workspace = test.attach();
    const failed = new Error("dispatch failed");
    const logged = deferred();
    const log = vi.spyOn(console, "error").mockImplementation(() => logged.resolve());
    const scanWorkspace = vi.fn(async () => { throw failed; });
    test.live.dispatch = { scanWorkspace };
    test.callbacks.createRelayOnChange(workspace)();
    await logged.promise;
    expect(log).toHaveBeenCalledExactlyOnceWith("[desktop] relay dispatch scan:", failed);
    expect(scanWorkspace).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId);
    expect(test.scanWorkspace).not.toHaveBeenCalled();
    await test.authorities.invalidate(workspace.workspaceId);
    expect(test.disposed).toEqual([workspace.attachmentId]);
  });

  it("preserves a synchronous admission failure if notification retires the relay attachment", async () => {
    const test = fixture();
    const workspace = test.attach();
    let retired!: Promise<void>;
    test.notifyRenderer.mockImplementation(() => {
      retired = test.authorities.invalidate(workspace.workspaceId);
    });
    expect(() => test.callbacks.createRelayOnChange(workspace)()).toThrow("retiring or blocked");
    expect(test.scanWorkspace).not.toHaveBeenCalled();
    await retired;
    expect(test.disposed).toEqual([workspace.attachmentId]);
  });

  it("preserves optional attachment admission and the asynchronous mismatch refusal", async () => {
    const test = fixture();
    const workspace = test.attach();
    expect(test.callbacks.withWorkspaceAttachment({ workspaceId: workspace.workspaceId }, lease => lease.state.attachmentId))
      .toBe(workspace.attachmentId);
    expect(await test.callbacks.withWorkspaceAttachmentAsync({ workspaceId: workspace.workspaceId }, lease => lease.state.attachmentId))
      .toBe(workspace.attachmentId);
    const work = vi.fn();
    expect(test.callbacks.withWorkspaceAttachment({ ...workspace, attachmentId: Symbol("old") }, work)).toBeUndefined();
    await expect(test.callbacks.withWorkspaceAttachmentAsync({ ...workspace, attachmentId: Symbol("old") }, work))
      .rejects.toThrow("This callback belongs to a retired workspace authority.");
    expect(work).not.toHaveBeenCalled();
    await test.authorities.invalidate(workspace.workspaceId);
    expect(test.disposed).toEqual([workspace.attachmentId]);
  });

  it("releases the synchronous helper immediately but holds the asynchronous helper through settlement", async () => {
    const test = fixture();
    const first = test.attach();
    const held = deferred<number>();
    const result = test.callbacks.withWorkspaceAttachment(first, () => held.promise);
    await test.authorities.invalidate(first.workspaceId);
    expect(test.disposed).toEqual([first.attachmentId]);
    held.resolve(7);
    expect(await result).toBe(7);
    const second = test.attach();
    const heldAsync = deferred<number>();
    const resultAsync = test.callbacks.withWorkspaceAttachmentAsync(second, () => heldAsync.promise);
    const retired = test.authorities.invalidate(second.workspaceId);
    try {
      expect(test.disposed).toEqual([first.attachmentId]);
      heldAsync.resolve(9);
      expect(await resultAsync).toBe(9);
      await retired;
      expect(test.disposed).toEqual([first.attachmentId, second.attachmentId]);
    } finally { heldAsync.resolve(9); await retired; }
  });
});
