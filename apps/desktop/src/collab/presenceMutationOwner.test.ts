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
const OLD_INCARNATION = "123e4567-e89b-42d3-a456-426614174001";
const NEW_INCARNATION = "123e4567-e89b-42d3-a456-426614174002";

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

    const result = presence.publish(first, "workspace-a/topic/me", OLD_INCARNATION, {
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
    const oldResult = presence.publish(
      first,
      "workspace-a/share-1/topic/me",
      OLD_INCARNATION,
      {
      resolve: async () => {
        const exactSource = source;
        return {
          publish: exactPublish,
          leave: () => exactSource.leave(),
        };
      },
      },
    );
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
      presence.publish(replacement, "workspace-a/share-1/topic/me", NEW_INCARNATION, {
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
        OLD_INCARNATION,
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

    const publish = presence.publish(active, "key", OLD_INCARNATION, {
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
    const leaving = presence.leave(
      active,
      "key",
      OLD_INCARNATION,
      async () => leave,
    );
    await vi.waitFor(() => expect(order).toEqual(["publish-start"]));
    expect(leave).not.toHaveBeenCalled();

    publishDrain.resolve();
    await expect(publish).resolves.toBe("snapshot");
    await expect(leaving).resolves.toBe(true);
    expect(order).toEqual(["publish-start", "publish-end", "leave"]);
  });

  it("drops an old leave queued before a replacement publish claims the key", async () => {
    const presence = new PresenceMutationOwner<TestSender>();
    const sessions = sessionOwner(presence);
    const active = await sessions.open(sender(7), "workspace-a", "document-1");
    const oldPublishDrain = deferred();
    const oldLeave = vi.fn(async () => undefined);
    const runOldPublish = vi.fn(async () => {
      await oldPublishDrain.promise;
      return "old";
    });
    const oldPublish = presence.publish(active, "same-key", OLD_INCARNATION, {
      resolve: async () => ({
        publish: runOldPublish,
        leave: oldLeave,
      }),
    });
    await vi.waitFor(() => expect(runOldPublish).toHaveBeenCalledOnce());
    const staleLeave = presence.leave(
      active,
      "same-key",
      OLD_INCARNATION,
      async () => oldLeave,
    );
    const newLeave = vi.fn(async () => undefined);
    const replacement = presence.publish(
      active,
      "same-key",
      NEW_INCARNATION,
      {
        resolve: async () => ({
          publish: async () => "new",
          leave: newLeave,
        }),
      },
    );

    oldPublishDrain.resolve();
    await expect(oldPublish).resolves.toBeUndefined();
    await expect(staleLeave).resolves.toBe(false);
    await expect(replacement).resolves.toBe("new");
    expect(oldLeave).not.toHaveBeenCalled();
    expect(newLeave).not.toHaveBeenCalled();
  });

  it("coalesces a failed retired leave before same-key successors publish", async () => {
    let expire: () => void = () => undefined;
    const cancelExpiry = vi.fn();
    const presence = new PresenceMutationOwner<TestSender>({
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
    const retryDrain = deferred();
    const oldLeave = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("relay unavailable"))
      .mockImplementationOnce(() => retryDrain.promise);
    await presence.publish(oldSession, "same-key", OLD_INCARNATION, {
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
    const first = presence.publish(firstSuccessor, "same-key", NEW_INCARNATION, {
      resolve: async () => ({
        publish: firstPublish,
        leave: async () => undefined,
      }),
    });
    const second = presence.publish(secondSuccessor, "same-key", NEW_INCARNATION, {
      resolve: async () => ({
        publish: secondPublish,
        leave: async () => undefined,
      }),
    });

    await vi.waitFor(() => expect(oldLeave).toHaveBeenCalledTimes(2));
    expect(firstPublish).not.toHaveBeenCalled();
    expect(secondPublish).not.toHaveBeenCalled();

    // Model a timer callback that was already queued when the retry cancelled
    // its expiry. It must not delete the in-flight obligation and let a later
    // same-key successor cross the stale leave.
    expire();
    const thirdSuccessor = await sessions.open(
      sender(10),
      "workspace-b",
      "document-4",
    );
    const thirdPublish = vi.fn(async () => "third");
    const third = presence.publish(thirdSuccessor, "same-key", NEW_INCARNATION, {
      resolve: async () => ({
        publish: thirdPublish,
        leave: async () => undefined,
      }),
    });
    await Promise.resolve();
    expect(thirdPublish).not.toHaveBeenCalled();
    expect(cancelExpiry).toHaveBeenCalledWith("expiry-1");

    retryDrain.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    await expect(third).resolves.toBe("third");
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
    await presence.publish(oldSession, "old-client-key", OLD_INCARNATION, {
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
      presence.publish(successor, "old-client-key", NEW_INCARNATION, {
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
