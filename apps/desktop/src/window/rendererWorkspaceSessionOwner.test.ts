import { describe, expect, it, vi } from "vitest";
import {
  RendererWorkspaceOpenSupersededError,
  RendererWorkspaceSessionOwner,
  type RendererWorkspaceSession,
} from "./rendererWorkspaceSessionOwner";

function deferred() {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  return { promise, resolve, reject };
}

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

function owner(input?: {
  retireSender?: (
    session: RendererWorkspaceSession<TestSender>,
  ) => Promise<void>;
  retireWorkspace?: (workspaceId: string) => Promise<void>;
  onCleanupError?: (scope: unknown, error: unknown) => void;
}) {
  return new RendererWorkspaceSessionOwner<TestSender>({
    retirement: {
      retireSender: input?.retireSender ?? (async () => undefined),
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

    const first = await sessions.open(renderer.value, "workspace-a");
    const second = await sessions.open(renderer.value, "workspace-a");

    expect(second).toBe(first);
    expect(second.isCurrent()).toBe(true);
    expect(retireSender).not.toHaveBeenCalled();
    expect(retireWorkspace).not.toHaveBeenCalled();
    expect(renderer.destroyedListenerCount()).toBe(1);
  });

  it("revokes admission synchronously before reload cleanup drains", async () => {
    const senderDrain = deferred();
    const workspaceDrain = deferred();
    const retireSender = vi.fn(() => senderDrain.promise);
    const retireWorkspace = vi.fn(() => workspaceDrain.promise);
    const sessions = owner({ retireSender, retireWorkspace });
    const renderer = sender(7);
    const first = await sessions.open(renderer.value, "workspace-a");

    const reload = sessions.retireForReload(renderer.value);

    expect(first.isCurrent()).toBe(false);
    expect(sessions.current(renderer.value)).toBeUndefined();
    expect(retireSender).toHaveBeenCalledWith(first);
    expect(retireWorkspace).not.toHaveBeenCalled();

    const replacement = sessions.open(renderer.value, "workspace-a");
    let replaced = false;
    void replacement.then(() => {
      replaced = true;
    });
    await Promise.resolve();
    expect(replaced).toBe(false);

    senderDrain.resolve();
    await vi.waitFor(() => expect(retireWorkspace).toHaveBeenCalledWith("workspace-a"));
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
    const first = await sessions.open(renderer.value, "workspace-a");

    const openB = sessions
      .open(renderer.value, "workspace-b")
      .catch((error: unknown) => error);
    const openA = sessions.open(renderer.value, "workspace-a");

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
    await sessions.open(first.value, "workspace-a");
    await sessions.open(second.value, "workspace-a");

    await sessions.retireForReload(first.value);
    expect(retireWorkspace).not.toHaveBeenCalled();
    expect(sessions.isWorkspaceOpen("workspace-a")).toBe(true);

    await sessions.retireForReload(second.value);
    expect(retireWorkspace).toHaveBeenCalledOnce();
    expect(retireWorkspace).toHaveBeenCalledWith("workspace-a");
  });

  it("makes a reopen join an in-flight last-holder workspace retirement", async () => {
    const workspaceDrain = deferred();
    const retireWorkspace = vi.fn(() => workspaceDrain.promise);
    const sessions = owner({ retireWorkspace });
    const first = sender(1);
    const second = sender(2);
    await sessions.open(first.value, "workspace-a");

    const reload = sessions.retireForReload(first.value);
    await vi.waitFor(() => expect(retireWorkspace).toHaveBeenCalledOnce());
    const reopening = sessions.open(second.value, "workspace-a");
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

  it("keeps a replacement safe when Electron reuses a numeric sender id", async () => {
    const senderDrain = deferred();
    const workspaceDrain = deferred();
    const sessions = owner({
      retireSender: () => senderDrain.promise,
      retireWorkspace: () => workspaceDrain.promise,
    });
    const oldRenderer = sender(7);
    const replacementRenderer = sender(7);
    const oldSession = await sessions.open(oldRenderer.value, "workspace-a");

    const replacementOpen = sessions.open(
      replacementRenderer.value,
      "workspace-b",
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
    await sessions.open(renderer.value, "workspace-a");

    const reload = sessions.retireForReload(renderer.value);
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
      sessions.open(destroyedRenderer.value, "workspace-a"),
    ).rejects.toBeInstanceOf(RendererWorkspaceOpenSupersededError);
    expect(destroyedRenderer.destroyedListenerCount()).toBe(0);

    const replacement = sender(7);
    await expect(
      sessions.open(replacement.value, "workspace-b"),
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
    await sessions.open(renderer.value, "workspace-a");

    await sessions.retireForReload(renderer.value);

    expect(onCleanupError).toHaveBeenCalledWith(
      { kind: "sender", senderId: 7 },
      failure,
    );
    expect(retireWorkspace).toHaveBeenCalledWith("workspace-a");
    expect(sessions.isWorkspaceOpen("workspace-a")).toBe(false);
  });
});
