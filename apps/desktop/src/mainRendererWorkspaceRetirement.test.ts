import { describe, expect, it, vi } from "vitest";
import { createDesktopRendererWorkspaceRetirement } from "./mainRendererWorkspaceRetirement";
import type { RendererWorkspaceSession } from "./window/rendererWorkspaceSessionOwner";

function deferred() {
  return Promise.withResolvers<void>();
}

const sender = {
  id: 17,
  isDestroyed: () => false,
  once: () => sender,
};

const session: RendererWorkspaceSession<typeof sender> = {
  sender,
  senderId: sender.id,
  workspaceId: "workspace-a",
  generation: 23,
  isCurrent: () => false,
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    engineYDoc: { retireSender: vi.fn(async () => undefined) },
    sitePreviews: {
      cancelSender: vi.fn(),
      stopWorkspace: vi.fn(async () => undefined),
    },
    pluginSurfaces: { stop: vi.fn(async () => undefined) },
    pluginRuntimes: { stop: vi.fn(async () => undefined) },
    workspaceSearch: { disposeSender: vi.fn() },
    presencePolls: { disposeSender: vi.fn() },
    onCleanupError: vi.fn(),
    ...overrides,
  };
}

describe("desktop renderer workspace retirement", () => {
  it("begins every sender arm before waiting for any arm to drain", async () => {
    const drains = Array.from({ length: 5 }, deferred);
    const input = dependencies({
      engineYDoc: { retireSender: vi.fn(() => drains[0]!.promise) },
      sitePreviews: {
        cancelSender: vi.fn(() => drains[1]!.promise),
        stopWorkspace: vi.fn(async () => undefined),
      },
      pluginSurfaces: { stop: vi.fn(() => drains[2]!.promise) },
      workspaceSearch: { disposeSender: vi.fn(() => drains[3]!.promise) },
      presencePolls: { disposeSender: vi.fn(() => drains[4]!.promise) },
    });
    const retirement = createDesktopRendererWorkspaceRetirement(input);

    const retiring = retirement.retireSender(session);

    expect(input.engineYDoc.retireSender).toHaveBeenCalledWith(sender, 23);
    expect(input.sitePreviews.cancelSender).toHaveBeenCalledWith(17);
    expect(input.pluginSurfaces.stop).toHaveBeenCalledWith({
      kind: "sender",
      senderId: 17,
    });
    expect(input.workspaceSearch.disposeSender).toHaveBeenCalledWith(17);
    expect(input.presencePolls.disposeSender).toHaveBeenCalledWith(17);

    for (const drain of drains) drain.resolve();
    await retiring;
  });

  it("reports sender-arm failures without skipping or abandoning other arms", async () => {
    const asyncFailure = new Error("async failure");
    const syncFailure = new Error("sync failure");
    const lastDrain = deferred();
    const input = dependencies({
      engineYDoc: {
        retireSender: vi.fn(() => Promise.reject(asyncFailure)),
      },
      sitePreviews: {
        cancelSender: vi.fn(() => {
          throw syncFailure;
        }),
        stopWorkspace: vi.fn(async () => undefined),
      },
      presencePolls: { disposeSender: vi.fn(() => lastDrain.promise) },
    });
    const retirement = createDesktopRendererWorkspaceRetirement(input);

    const retiring = retirement.retireSender(session);
    expect(input.pluginSurfaces.stop).toHaveBeenCalledOnce();
    expect(input.workspaceSearch.disposeSender).toHaveBeenCalledOnce();

    lastDrain.resolve();
    await retiring;
    expect(input.onCleanupError).toHaveBeenCalledWith(
      "engine Y.Doc sessions",
      { kind: "sender", senderId: 17 },
      asyncFailure,
    );
    expect(input.onCleanupError).toHaveBeenCalledWith(
      "site preview starts",
      { kind: "sender", senderId: 17 },
      syncFailure,
    );
  });

  it("co-starts both workspace arms and drains them after a failure", async () => {
    const siteDrain = deferred();
    const failure = new Error("runtime stop failed");
    const order: string[] = [];
    const input = dependencies({
      sitePreviews: {
        cancelSender: vi.fn(),
        stopWorkspace: vi.fn(() => siteDrain.promise),
      },
      pluginSurfaces: {
        stop: vi.fn(async () => {
          order.push("surfaces");
        }),
      },
      pluginRuntimes: {
        stop: vi.fn(async (_workspaceId, beforeDispose) => {
          await beforeDispose();
          order.push("runtime");
          throw failure;
        }),
      },
    });
    const retirement = createDesktopRendererWorkspaceRetirement(input);

    const retiring = retirement.retireWorkspace("workspace-a");
    expect(input.sitePreviews.stopWorkspace).toHaveBeenCalledWith("workspace-a");
    expect(input.pluginRuntimes.stop).toHaveBeenCalledWith(
      "workspace-a",
      expect.any(Function),
    );
    expect(input.pluginSurfaces.stop).toHaveBeenCalledWith({
      kind: "workspace",
      workspaceId: "workspace-a",
    });

    siteDrain.resolve();
    await retiring;
    expect(order).toEqual(["surfaces", "runtime"]);
    expect(input.onCleanupError).toHaveBeenCalledWith(
      "plugin runtime",
      { kind: "workspace", workspaceId: "workspace-a" },
      failure,
    );
  });
});
