import type { ChatChannelSummary, ChatChannelType } from "@dohc/workspace-contracts/engine";

export interface JoinedGroupInput {
  name: string;
  type?: ChatChannelType;
  purpose?: string;
}

/**
 * New group in a joined workspace, for the app and for agents. The relay
 * creates the Group in the owner's workspace and decides the role; the view's
 * next pull brings it here. The relay wakes the held pull as soon as it
 * writes the Group, so this waits for that pull, not for a timer.
 */
export async function createJoinedGroup<View>(
  dependencies: {
    createJoinedWorkspaceGroup(view: View, input: JoinedGroupInput): Promise<{ channelWireId: string }>;
    subscribeChatWrites(workspaceId: string, listener: () => void): () => void;
  },
  target: {
    workspace: { workspaceId: string; shareView?: View };
    store: { listChannels(input: { workspaceId: string }): Promise<ChatChannelSummary[]> };
  },
  input: JoinedGroupInput,
  assertCurrent: () => void,
): Promise<{ channel: ChatChannelSummary; channelWireId: string }> {
  const { workspaceId } = target.workspace;
  const { channelWireId } = await dependencies.createJoinedWorkspaceGroup(target.workspace.shareView as View, {
    name: input.name,
    ...(input.type ? { type: input.type } : {}),
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
  });
  assertCurrent();
  const signal = AbortSignal.timeout(30_000);
  const arrived = async (): Promise<ChatChannelSummary> => {
    let wake = () => {};
    const unsubscribe = dependencies.subscribeChatWrites(workspaceId, () => wake());
    try {
      for (;;) {
        const woke = new Promise<void>((resolve) => { wake = resolve; });
        const found = (await target.store.listChannels({ workspaceId })).find((channel) => channel.id === channelWireId);
        if (found) return found;
        signal.throwIfAborted();
        await Promise.race([woke, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      }
    } finally {
      unsubscribe();
    }
  };
  try {
    return { channel: await arrived(), channelWireId };
  } catch (error) {
    assertCurrent();
    throw new Error(`dohc created ${input.name}, and it has not reached this computer yet. It shows in Chats when it does.`, { cause: error });
  }
}
