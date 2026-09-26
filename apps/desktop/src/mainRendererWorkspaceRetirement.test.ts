import { describe, expect, it, vi } from "vitest";
import { createDesktopRendererWorkspaceRetirement } from "./mainRendererWorkspaceRetirement";
import {
  RendererWorkspaceSessionOwner,
  type RendererWorkspaceSession,
} from "./window/rendererWorkspaceSessionOwner";

import { deferred } from "./testing/deferred";
const sender = {
  id: 17,
  isDestroyed: () => false,
  once: () => sender,
};

const session: RendererWorkspaceSession<typeof sender> = {
  sender,
  senderId: sender.id,
  workspaceId: "workspace-a",
  attachmentId: Symbol("workspace-a"),
  rendererDocumentId: "document-1",
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
    workspaceSearch: { disposeSender: vi.fn() },
    presencePolls: { disposeSender: vi.fn() },
    presenceMutations: { retireSender: vi.fn(async () => undefined) },
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
      workspaceSearch: { disposeSender: vi.fn(() => drains[2]!.promise) },
      presencePolls: { disposeSender: vi.fn(() => drains[3]!.promise) },
      presenceMutations: { retireSender: vi.fn(() => drains[4]!.promise) },
    });
    const retirement = createDesktopRendererWorkspaceRetirement(input);

    const retiring = retirement.retireSender(session);

    expect(input.engineYDoc.retireSender).toHaveBeenCalledWith(sender, 23);
    expect(input.sitePreviews.cancelSender).toHaveBeenCalledWith(17);
    expect(input.workspaceSearch.disposeSender).toHaveBeenCalledWith(17);
    expect(input.presencePolls.disposeSender).toHaveBeenCalledWith(17);
    expect(input.presenceMutations.retireSender).toHaveBeenCalledWith(session);

    for (const drain of drains) drain.resolve();
    await Promise.all([
      retiring.requiredForAdmission,
      retiring.detachedFromAdmission,
    ]);
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
    expect(input.workspaceSearch.disposeSender).toHaveBeenCalledOnce();

    lastDrain.resolve();
    await Promise.all([
      retiring.requiredForAdmission,
      retiring.detachedFromAdmission,
    ]);
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

  it("admits B after A's search stops while durable and attachment cleanup drain", async () => {
    const yDocDrain = deferred();
    const senderSearchDrain = deferred();
    const previewDrain = deferred();
    const yDocSettled = vi.fn();
    const previewStopped = vi.fn();
    const searchDisposed = vi.fn();
    const admissionOrder: string[] = [];
    const input = dependencies({
      engineYDoc: {
        retireSender: vi.fn(() => yDocDrain.promise.then(yDocSettled)),
      },
      sitePreviews: {
        cancelSender: vi.fn(),
        stopWorkspace: vi.fn(() => previewDrain.promise.then(previewStopped)),
      },
      workspaceSearch: {
        disposeSender: vi.fn(() =>
          senderSearchDrain.promise.then(() => {
            searchDisposed();
            admissionOrder.push("search disposed");
          }),
        ),
      },
    });
    const sessions = new RendererWorkspaceSessionOwner({
      retirement: createDesktopRendererWorkspaceRetirement(input),
    });
    const attachmentA = {
      workspaceId: "workspace-a",
      attachmentId: Symbol("workspace-a"),
    };
    const attachmentB = {
      workspaceId: "workspace-b",
      attachmentId: Symbol("workspace-b"),
    };
    await sessions.open(sender, attachmentA, "document-1");

    const openingB = sessions.open(sender, attachmentB, "document-1");
    let admitted = false;
    void openingB.then(() => {
      admitted = true;
      admissionOrder.push("B admitted");
    });
    await vi.waitFor(() =>
      expect(input.workspaceSearch.disposeSender).toHaveBeenCalledWith(sender.id),
    );

    expect(sessions.current(sender)).toBeUndefined();
    expect(admitted).toBe(false);
    senderSearchDrain.resolve();

    const sessionB = await openingB;
    expect(sessionB.isCurrent()).toBe(true);
    expect(searchDisposed).toHaveBeenCalledOnce();
    expect(admissionOrder).toEqual(["search disposed", "B admitted"]);
    expect(input.sitePreviews.stopWorkspace).toHaveBeenCalledWith(attachmentA);
    expect(yDocSettled).not.toHaveBeenCalled();
    expect(previewStopped).not.toHaveBeenCalled();

    yDocDrain.resolve();
    previewDrain.resolve();
    await vi.waitFor(() => {
      expect(yDocSettled).toHaveBeenCalledOnce();
      expect(previewStopped).toHaveBeenCalledOnce();
    });
  });

  it("stops the workspace's site previews and reports their failure", async () => {
    const failure = new Error("site preview stop failed");
    const input = dependencies({
      sitePreviews: {
        cancelSender: vi.fn(),
        stopWorkspace: vi.fn(async () => { throw failure; }),
      },
    });
    const retirement = createDesktopRendererWorkspaceRetirement(input);

    await retirement.retireWorkspace(session);
    expect(input.sitePreviews.stopWorkspace).toHaveBeenCalledWith({
      workspaceId: session.workspaceId,
      attachmentId: session.attachmentId,
    });
    expect(input.onCleanupError).toHaveBeenCalledWith(
      "site previews",
      { kind: "workspace", workspaceId: "workspace-a" },
      failure,
    );
  });
});
