import { describe, expect, it, vi } from "vitest";
import {
  RendererWorkspaceOpenSupersededError,
  RendererWorkspaceSessionOwner,
  type RendererWorkspaceSession,
} from "./rendererWorkspaceSessionOwner";
import { deferred } from "../testing/deferred";

function sender(id: number) {
  let destroyed = false;
  const destroyedListeners: Array<() => void> = [];
  const value = {
    id,
    isDestroyed: () => destroyed,
    once(event: "destroyed", listener: () => void) {
      expect(event).toBe("destroyed");
      destroyedListeners.push(listener);
      return value;
    },
  };
  return {
    value,
    destroy() {
      destroyed = true;
      for (const listener of destroyedListeners) listener();
    },
    destroyedListenerCount: () => destroyedListeners.length,
  };
}

type TestSender = ReturnType<typeof sender>["value"];

const attachments = new Map<string, symbol>();
function physical(workspaceId: string) {
  let attachmentId = attachments.get(workspaceId);
  if (!attachmentId) {
    attachmentId = Symbol(workspaceId);
    attachments.set(workspaceId, attachmentId);
  }
  return { workspaceId, attachmentId };
}

function owner(input?: {
  retireSender?: (
    session: RendererWorkspaceSession<TestSender>,
  ) => Promise<void>;
  retireDetachedSender?: (
    session: RendererWorkspaceSession<TestSender>,
  ) => Promise<void>;
  retireWorkspace?: (workspace: {
    workspaceId: string;
    attachmentId: symbol;
  }) => Promise<void>;
  onCleanupError?: (scope: unknown, error: unknown) => void;
}) {
  return new RendererWorkspaceSessionOwner<TestSender>({
    retirement: {
      retireSender: (session) => ({
        requiredForAdmission:
          input?.retireSender?.(session) ?? Promise.resolve(),
        detachedFromAdmission:
          input?.retireDetachedSender?.(session) ?? Promise.resolve(),
      }),
      retireWorkspace: input?.retireWorkspace ?? (async () => undefined),
    },
    onCleanupError: input?.onCleanupError,
  });
}

describe("RendererWorkspaceSessionOwner", () => {
  it("keeps a same-workspace reopen on the same exact lease", async () => {
    const retireSender = vi.fn(async () => undefined);
    const retireWorkspace = vi.fn(async () => undefined);
    const sessions = owner({ retireSender, retireWorkspace });
    const renderer = sender(7);

    const first = await sessions.open(renderer.value, physical("workspace-a"), "document-1");
    const second = await sessions.open(renderer.value, physical("workspace-a"), "document-1");

    expect(second).toBe(first);
    expect(second.isCurrent()).toBe(true);
    expect(retireSender).not.toHaveBeenCalled();
    expect(retireWorkspace).not.toHaveBeenCalled();
    expect(renderer.destroyedListenerCount()).toBe(1);
  });

  it("replaces a renderer lease when the same workspace id has a new attachment", async () => {
    const retireWorkspace = vi.fn(async () => undefined);
    const sessions = owner({ retireWorkspace });
    const renderer = sender(7);
    const firstAttachment = physical("workspace-a");
    const replacementAttachment = {
      workspaceId: "workspace-a",
      attachmentId: Symbol("replacement"),
    };

    const first = await sessions.open(
      renderer.value,
      firstAttachment,
      "document-1",
    );
    expect(
      sessions.current(renderer.value)?.attachmentId ===
        replacementAttachment.attachmentId,
    ).toBe(false);
    const replacement = await sessions.open(
      renderer.value,
      replacementAttachment,
      "document-1",
    );

    expect(replacement).not.toBe(first);
    expect(first.isCurrent()).toBe(false);
    expect(replacement).toMatchObject(replacementAttachment);
    expect(sessions.current(renderer.value)).toBe(replacement);
    expect(retireWorkspace).toHaveBeenCalledWith(firstAttachment);
  });

  it("closes reload admission before the document has opened a workspace", async () => {
    const sessions = owner();
    const renderer = sender(7);

    await expect(
      sessions.retireForReload(renderer.value, "document-1"),
    ).resolves.toBe(true);

    await expect(
      sessions.open(renderer.value, physical("workspace-a"), "document-1"),
    ).rejects.toBeInstanceOf(RendererWorkspaceOpenSupersededError);
    await expect(
      sessions.open(renderer.value, physical("workspace-a"), "document-2"),
    ).resolves.toMatchObject({ rendererDocumentId: "document-2" });
  });

  it("refuses a delayed reload from a retired document after its successor opens", async () => {
    const retireSender = vi.fn(async () => undefined);
    const sessions = owner({ retireSender });
    const renderer = sender(7);
    const first = await sessions.open(
      renderer.value,
      physical("workspace-a"),
      "document-1",
    );
    await expect(
      sessions.retireForReload(renderer.value, "document-1"),
    ).resolves.toBe(true);
    const successor = await sessions.open(
      renderer.value,
      physical("workspace-b"),
      "document-2",
    );

    await expect(
      sessions.retireForReload(renderer.value, "document-1"),
    ).resolves.toBe(false);
    expect(first.isCurrent()).toBe(false);
    expect(successor.isCurrent()).toBe(true);
    expect(sessions.current(renderer.value)).toBe(successor);
    expect(retireSender).toHaveBeenCalledOnce();
  });

  it("revokes admission synchronously before reload cleanup drains", async () => {
    const senderDrain = deferred();
    const workspaceDrain = deferred();
    const retireSender = vi.fn(() => senderDrain.promise);
    const retireWorkspace = vi.fn(() => workspaceDrain.promise);
    const sessions = owner({ retireSender, retireWorkspace });
    const renderer = sender(7);
    const first = await sessions.open(renderer.value, physical("workspace-a"), "document-1");

    const reload = sessions.retireForReload(renderer.value, "document-1");

    expect(first.isCurrent()).toBe(false);
    expect(sessions.current(renderer.value)).toBeUndefined();
    expect(retireSender).toHaveBeenCalledWith(first);
    expect(retireWorkspace).not.toHaveBeenCalled();

    const staleOpen = sessions
      .open(renderer.value, physical("workspace-b"), "document-1")
      .catch((error: unknown) => error);
    const replacement = sessions.open(
      renderer.value,
      physical("workspace-a"),
      "document-2",
    );
    let replaced = false;
    void replacement.then(() => {
      replaced = true;
    });
    await Promise.resolve();
    expect(await staleOpen).toBeInstanceOf(RendererWorkspaceOpenSupersededError);
    expect(replaced).toBe(false);

    senderDrain.resolve();
    await vi.waitFor(() =>
      expect(retireWorkspace).toHaveBeenCalledWith(physical("workspace-a")),
    );
    expect(replaced).toBe(false);
    workspaceDrain.resolve();

    await reload;
    const next = await replacement;
    expect(next.generation).toBeGreaterThan(first.generation);
    expect(next.isCurrent()).toBe(true);
  });

  it("lets only the latest rapid switch publish a replacement lease", async () => {
    const senderDrain = deferred();
    const workspaceDrain = deferred();
    const sessions = owner({
      retireSender: () => senderDrain.promise,
      retireWorkspace: () => workspaceDrain.promise,
    });
    const renderer = sender(7);
    const first = await sessions.open(renderer.value, physical("workspace-a"), "document-1");

    const openB = sessions
      .open(renderer.value, physical("workspace-b"), "document-1")
      .catch((error: unknown) => error);
    const openA = sessions.open(renderer.value, physical("workspace-a"), "document-1");

    expect(first.isCurrent()).toBe(false);
    expect(sessions.current(renderer.value)).toBeUndefined();
    senderDrain.resolve();
    await vi.waitFor(() => expect(sessions.isWorkspaceOpen("workspace-a")).toBe(false));
    workspaceDrain.resolve();

    expect(await openB).toBeInstanceOf(RendererWorkspaceOpenSupersededError);
    const reopened = await openA;
    expect(reopened.workspaceId).toBe("workspace-a");
    expect(reopened.generation).toBeGreaterThan(first.generation);
    expect(reopened.isCurrent()).toBe(true);
  });

  it("does not retire a workspace while another exact sender holds it", async () => {
    const retireWorkspace = vi.fn(async () => undefined);
    const sessions = owner({ retireWorkspace });
    const first = sender(1);
    const second = sender(2);
    await sessions.open(first.value, physical("workspace-a"), "document-1");
    await sessions.open(second.value, physical("workspace-a"), "document-2");

    await sessions.retireForReload(first.value, "document-1");
    expect(retireWorkspace).not.toHaveBeenCalled();
    expect(sessions.isWorkspaceOpen("workspace-a")).toBe(true);

    await sessions.retireForReload(second.value, "document-2");
    expect(retireWorkspace).toHaveBeenCalledOnce();
    expect(retireWorkspace).toHaveBeenCalledWith(physical("workspace-a"));
  });

  it("retires attachment A after its last renderer leaves even while attachment B is open", async () => {
    const retireWorkspace = vi.fn(async () => undefined);
    const sessions = owner({ retireWorkspace });
    const attachmentA = physical("workspace-a");
    const attachmentB = {
      workspaceId: "workspace-a",
      attachmentId: Symbol("workspace-a-b"),
    };
    const firstA = sender(1);
    const secondA = sender(2);
    const rendererB = sender(3);
    await sessions.open(firstA.value, attachmentA, "document-a1");
    await sessions.open(secondA.value, attachmentA, "document-a2");
    await sessions.open(rendererB.value, attachmentB, "document-b");

    await sessions.retireForReload(firstA.value, "document-a1");
    expect(retireWorkspace).not.toHaveBeenCalled();
    await sessions.retireForReload(secondA.value, "document-a2");

    expect(retireWorkspace).toHaveBeenCalledWith(attachmentA);
    expect(sessions.isAttachmentOpen(attachmentA.attachmentId)).toBe(false);
    expect(sessions.isAttachmentOpen(attachmentB.attachmentId)).toBe(true);
    expect(sessions.isWorkspaceOpen("workspace-a")).toBe(true);
  });

  it("makes a reopen join an in-flight last-holder workspace retirement", async () => {
    const workspaceDrain = deferred();
    const retireWorkspace = vi.fn(() => workspaceDrain.promise);
    const sessions = owner({ retireWorkspace });
    const first = sender(1);
    const second = sender(2);
    await sessions.open(first.value, physical("workspace-a"), "document-1");

    const reload = sessions.retireForReload(first.value, "document-1");
    await vi.waitFor(() => expect(retireWorkspace).toHaveBeenCalledOnce());
    const reopening = sessions.open(second.value, physical("workspace-a"), "document-2");
    let opened = false;
    void reopening.then(() => {
      opened = true;
    });
    await Promise.resolve();
    expect(opened).toBe(false);
    expect(retireWorkspace).toHaveBeenCalledOnce();

    workspaceDrain.resolve();
    await reload;
    expect((await reopening).isCurrent()).toBe(true);
  });

  it("makes a rapid A-to-B-to-A return join A's detached retirement", async () => {
    const attachmentA = physical("workspace-a");
    const attachmentB = physical("workspace-b");
    const detachedADrain = deferred();
    const workspaceADrain = deferred();
    const retireWorkspace = vi.fn(
      (workspace: { workspaceId: string; attachmentId: symbol }) =>
        workspace.attachmentId === attachmentA.attachmentId
          ? workspaceADrain.promise
          : Promise.resolve(),
    );
    const sessions = owner({
      retireDetachedSender: (session) =>
        session.attachmentId === attachmentA.attachmentId
          ? detachedADrain.promise
          : Promise.resolve(),
      retireWorkspace,
    });
    const renderer = sender(7);
    const firstA = await sessions.open(
      renderer.value,
      attachmentA,
      "document-1",
    );

    const sessionB = await sessions.open(
      renderer.value,
      attachmentB,
      "document-1",
    );
    expect(sessionB.isCurrent()).toBe(true);
    expect(retireWorkspace).toHaveBeenCalledWith(attachmentA);

    const reopeningA = sessions.open(
      renderer.value,
      attachmentA,
      "document-1",
    );
    let reopened = false;
    void reopeningA.then(() => {
      reopened = true;
    });
    await Promise.resolve();

    expect(sessionB.isCurrent()).toBe(false);
    expect(sessions.current(renderer.value)).toBeUndefined();
    expect(reopened).toBe(false);

    workspaceADrain.resolve();
    await Promise.resolve();
    expect(reopened).toBe(false);

    detachedADrain.resolve();
    const secondA = await reopeningA;
    expect(secondA.generation).toBeGreaterThan(firstA.generation);
    expect(secondA.isCurrent()).toBe(true);
  });

  it("keeps a replacement safe when Electron reuses a numeric sender id", async () => {
    const senderDrain = deferred();
    const workspaceDrain = deferred();
    const sessions = owner({
      retireSender: () => senderDrain.promise,
      retireWorkspace: () => workspaceDrain.promise,
    });
    const oldRenderer = sender(7);
    const replacementRenderer = sender(7);
    const oldSession = await sessions.open(
      oldRenderer.value,
      physical("workspace-a"),
      "document-1",
    );

    const replacementOpen = sessions.open(
      replacementRenderer.value,
      physical("workspace-b"),
      "document-2",
    );
    expect(oldSession.isCurrent()).toBe(false);
    expect(sessions.current(replacementRenderer.value)).toBeUndefined();
    senderDrain.resolve();
    await vi.waitFor(() => expect(sessions.isWorkspaceOpen("workspace-a")).toBe(false));
    workspaceDrain.resolve();

    const replacement = await replacementOpen;
    oldRenderer.destroy();
    await Promise.resolve();

    expect(sessions.current(replacementRenderer.value)).toBe(replacement);
    expect(replacement.isCurrent()).toBe(true);
    expect(replacement.generation).toBeGreaterThan(oldSession.generation);
  });

  it("coalesces reload and destroy cleanup for one exact sender", async () => {
    const senderDrain = deferred();
    const retireSender = vi.fn(() => senderDrain.promise);
    const sessions = owner({ retireSender });
    const renderer = sender(7);
    await sessions.open(renderer.value, physical("workspace-a"), "document-1");

    const reload = sessions.retireForReload(renderer.value, "document-1");
    renderer.destroy();
    senderDrain.resolve();
    await reload;

    expect(retireSender).toHaveBeenCalledOnce();
    expect(renderer.destroyedListenerCount()).toBe(1);
    expect(sessions.current(renderer.value)).toBeUndefined();
  });

  it("does not retain or hook a sender that was already destroyed", async () => {
    const sessions = owner();
    const destroyedRenderer = sender(7);
    destroyedRenderer.destroy();

    await expect(
      sessions.open(destroyedRenderer.value, physical("workspace-a"), "document-1"),
    ).rejects.toBeInstanceOf(RendererWorkspaceOpenSupersededError);
    expect(destroyedRenderer.destroyedListenerCount()).toBe(0);

    const replacement = sender(7);
    await expect(
      sessions.open(replacement.value, physical("workspace-b"), "document-2"),
    ).resolves.toMatchObject({ workspaceId: "workspace-b" });
  });

  it("reports cleanup failures without skipping workspace retirement", async () => {
    const failure = new Error("sender cleanup failed");
    const onCleanupError = vi.fn();
    const retireWorkspace = vi.fn(async () => undefined);
    const sessions = owner({
      retireSender: async () => {
        throw failure;
      },
      retireWorkspace,
      onCleanupError,
    });
    const renderer = sender(7);
    await sessions.open(renderer.value, physical("workspace-a"), "document-1");

    await sessions.retireForReload(renderer.value, "document-1");

    expect(onCleanupError).toHaveBeenCalledWith(
      { kind: "sender", senderId: 7 },
      failure,
    );
    expect(retireWorkspace).toHaveBeenCalledWith(physical("workspace-a"));
    expect(sessions.isWorkspaceOpen("workspace-a")).toBe(false);
  });
});
