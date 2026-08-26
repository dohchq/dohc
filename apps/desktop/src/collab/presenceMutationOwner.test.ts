import { describe, expect, it, vi } from "vitest";
import { PresenceMutationOwner } from "./presenceMutationOwner";
import {
  RendererWorkspaceOpenSupersededError,
  RendererWorkspaceSessionOwner,
  type RendererWorkspaceSession,
} from "../window/rendererWorkspaceSessionOwner";

function deferred() {
  return Promise.withResolvers<void>();
}

function sender(id: number) {
  const listeners: Array<() => void> = [];
  const value = {
    id,
    isDestroyed: () => false,
    once(_event: "destroyed", listener: () => void) {
      listeners.push(listener);
      return value;
    },
  };
  return value;
}

type TestSender = ReturnType<typeof sender>;

function sessionOwner(presence: PresenceMutationOwner<TestSender>) {
  return new RendererWorkspaceSessionOwner<TestSender>({
    retirement: {
      retireSender: (session) => presence.retireSender(session),
      retireWorkspace: async () => undefined,
    },
  });
}

describe("PresenceMutationOwner", () => {
  it("drains a held workspace publish and leave before admitting a switch", async () => {
    const presence = new PresenceMutationOwner<TestSender>();
    const sessions = sessionOwner(presence);
    const webContents = sender(7);
    const first = await sessions.open(webContents, "workspace-a", "document-1");
    const publishDrain = deferred();
    const leaveDrain = deferred();
    const publish = vi.fn(async () => {
      await publishDrain.promise;
      return "old-snapshot";
    });
    const leave = vi.fn(async () => {
      await leaveDrain.promise;
    });

    const result = presence.publish(first, "workspace-a/topic/me", {
      resolve: async () => ({ publish, leave }),
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const replacementOpen = sessions.open(
      webContents,
      "workspace-b",
      "document-1",
    );

    expect(first.isCurrent()).toBe(false);
    publishDrain.resolve();
    await expect(result).resolves.toBeUndefined();
    await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
    let admitted = false;
    void replacementOpen.then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);

    leaveDrain.resolve();
    const replacement = await replacementOpen;
    expect(replacement.workspaceId).toBe("workspace-b");
    expect(replacement.isCurrent()).toBe(true);
  });

  it("binds a held share leave to the retired session before reload admission", async () => {
    const presence = new PresenceMutationOwner<TestSender>();
    const sessions = sessionOwner(presence);
    const webContents = sender(7);
    const first = await sessions.open(webContents, "workspace-a", "document-1");
    const publishDrain = deferred();
    const leaveDrain = deferred();
    const oldLeave = vi.fn(async () => {
      await leaveDrain.promise;
    });
    const changedSourceLeave = vi.fn(async () => undefined);
    let source = { leave: oldLeave };
    const exactPublish = vi.fn(async () => {
      await publishDrain.promise;
      return "old-snapshot";
    });
    const oldResult = presence.publish(first, "workspace-a/share-1/topic/me", {
      resolve: async () => {
        const exactSource = source;
        return {
          publish: exactPublish,
          leave: () => exactSource.leave(),
        };
      },
    });
    await vi.waitFor(() => expect(exactPublish).toHaveBeenCalledOnce());
    source = { leave: changedSourceLeave };

    const reload = sessions.retireForReload(webContents, "document-1");
    const staleOpen = sessions
      .open(webContents, "workspace-a", "document-1")
      .catch((error: unknown) => error);
    const replacementOpen = sessions.open(
      webContents,
      "workspace-a",
      "document-2",
    );
    publishDrain.resolve();
    await expect(oldResult).resolves.toBeUndefined();
    await vi.waitFor(() => expect(oldLeave).toHaveBeenCalledOnce());
    expect(changedSourceLeave).not.toHaveBeenCalled();
    expect(await staleOpen).toBeInstanceOf(RendererWorkspaceOpenSupersededError);

    leaveDrain.resolve();
    await reload;
    const replacement = await replacementOpen;
    const successorLeave = vi.fn(async () => undefined);
    await expect(
      presence.publish(replacement, "workspace-a/share-1/topic/me", {
        resolve: async () => ({
          publish: async () => "new-snapshot",
          leave: successorLeave,
        }),
      }),
    ).resolves.toBe("new-snapshot");

    await expect(
      presence.leave(
        first,
        "workspace-a/share-1/topic/me",
        async () => successorLeave,
      ),
    ).resolves.toBe(false);
    expect(successorLeave).not.toHaveBeenCalled();
  });

  it("serializes an explicit leave behind its in-flight publish", async () => {
    const presence = new PresenceMutationOwner<TestSender>();
    const sessions = sessionOwner(presence);
    const active = await sessions.open(sender(7), "workspace-a", "document-1");
    const publishDrain = deferred();
    const order: string[] = [];
    const leave = vi.fn(async () => {
      order.push("leave");
    });

    const publish = presence.publish(active, "key", {
      resolve: async () => ({
        publish: async () => {
          order.push("publish-start");
          await publishDrain.promise;
          order.push("publish-end");
          return "snapshot";
        },
        leave,
      }),
    });
    const leaving = presence.leave(active, "key", async () => leave);
    await vi.waitFor(() => expect(order).toEqual(["publish-start"]));
    expect(leave).not.toHaveBeenCalled();

    publishDrain.resolve();
    await expect(publish).resolves.toBe("snapshot");
    await expect(leaving).resolves.toBe(true);
    expect(order).toEqual(["publish-start", "publish-end", "leave"]);
  });

  it("coalesces a failed retired leave before same-key successors publish", async () => {
    const presence = new PresenceMutationOwner<TestSender>();
    const sessions = sessionOwner(presence);
    const oldSender = sender(7);
    const oldSession = await sessions.open(
      oldSender,
      "workspace-a",
      "document-1",
    );
    const retryDrain = deferred();
    const oldLeave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("relay unavailable"))
      .mockImplementationOnce(() => retryDrain.promise);
    await presence.publish(oldSession, "same-key", {
      resolve: async () => ({
        publish: async () => "old-snapshot",
        leave: oldLeave,
      }),
    });
    await sessions.retireForReload(oldSender, "document-1");
    expect(oldLeave).toHaveBeenCalledOnce();

    const firstSuccessor = await sessions.open(
      sender(8),
      "workspace-b",
      "document-2",
    );
    const secondSuccessor = await sessions.open(
      sender(9),
      "workspace-b",
      "document-3",
    );
    const firstPublish = vi.fn(async () => "first");
    const secondPublish = vi.fn(async () => "second");
    const first = presence.publish(firstSuccessor, "same-key", {
      resolve: async () => ({
        publish: firstPublish,
        leave: async () => undefined,
      }),
    });
    const second = presence.publish(secondSuccessor, "same-key", {
      resolve: async () => ({
        publish: secondPublish,
        leave: async () => undefined,
      }),
    });

    await vi.waitFor(() => expect(oldLeave).toHaveBeenCalledTimes(2));
    expect(firstPublish).not.toHaveBeenCalled();
    expect(secondPublish).not.toHaveBeenCalled();
    retryDrain.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(oldLeave).toHaveBeenCalledTimes(2);
  });

  it("forgets a failed leave after the relay entry's bounded lifetime", async () => {
    let expire: () => void = () => undefined;
    const cancelExpiry = vi.fn();
    const presence = new PresenceMutationOwner<TestSender>({
      tombstoneTtlMs: 30_000,
      scheduleExpiry: (callback) => {
        expire = callback;
        return "expiry-1";
      },
      cancelExpiry,
    });
    const sessions = sessionOwner(presence);
    const oldSender = sender(7);
    const oldSession = await sessions.open(
      oldSender,
      "workspace-a",
      "document-1",
    );
    const oldLeave = vi.fn(async () => {
      throw new Error("relay unavailable");
    });
    await presence.publish(oldSession, "old-client-key", {
      resolve: async () => ({
        publish: async () => "old-snapshot",
        leave: oldLeave,
      }),
    });
    await sessions.retireForReload(oldSender, "document-1");
    expect(oldLeave).toHaveBeenCalledOnce();

    expire();
    const successor = await sessions.open(
      sender(8),
      "workspace-a",
      "document-2",
    );
    await expect(
      presence.publish(successor, "old-client-key", {
        resolve: async () => ({
          publish: async () => "new-snapshot",
          leave: async () => undefined,
        }),
      }),
    ).resolves.toBe("new-snapshot");
    expect(oldLeave).toHaveBeenCalledOnce();
    expect(cancelExpiry).not.toHaveBeenCalled();
  });
});
