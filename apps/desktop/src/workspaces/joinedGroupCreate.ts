import type { ChatChannelSummary, ChatChannelType } from "@dohc/workspace-contracts/engine";
import type { GroupRuleLevel } from "@dohc/security-contract/workspace-members";

export interface JoinedGroupInput {
  name: string;
  type?: ChatChannelType;
  purpose?: string;
  level?: GroupRuleLevel;
}

/**
 * New group made by the relay, for the app and for agents: an admin's in a
 * joined workspace, or the owner's when they pick a level. The relay creates
 * the Group in the owner's workspace and decides the role; a pull brings it
 * here. This starts that pull itself, since no window may be pulling the
 * workspace, then waits for it, not for a timer.
 */
export async function createJoinedGroup<View>(
  dependencies: {
    createJoinedWorkspaceGroup(
      view: View,
      input: JoinedGroupInput,
    ): Promise<{ channelWireId: string }>;
    subscribeChatWrites(workspaceId: string, listener: () => void): () => void;
    // One pull of the joined workspace from main, as the window's refresh runs it.
    pullJoinedWorkspace(workspaceId: string): Promise<unknown>;
  },
  target: {
    workspace: { workspaceId: string; shareView?: View };
    store: { listChannels(input: { workspaceId: string }): Promise<ChatChannelSummary[]> };
  },
  input: JoinedGroupInput,
  assertCurrent: () => void,
): Promise<{ channel: ChatChannelSummary; channelWireId: string }> {
  const { workspaceId } = target.workspace;
  const { channelWireId } = await dependencies.createJoinedWorkspaceGroup(
    target.workspace.shareView as View,
    {
      name: input.name,
      ...(input.type ? { type: input.type } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.level !== undefined ? { level: input.level } : {}),
    },
  );
  assertCurrent();
  // A pull that fails leaves the wait below, which says the Group has not arrived.
  void dependencies.pullJoinedWorkspace(workspaceId).catch(() => undefined);
  const signal = AbortSignal.timeout(30_000);
  const arrived = async (): Promise<ChatChannelSummary> => {
    let wake = () => {};
    const unsubscribe = dependencies.subscribeChatWrites(workspaceId, () => wake());
    try {
      for (;;) {
        const woke = new Promise<void>((resolve) => {
          wake = resolve;
        });
        const found = (await target.store.listChannels({ workspaceId })).find(
          (channel) => channel.id === channelWireId,
        );
        if (found) return found;
        signal.throwIfAborted();
        await Promise.race([
          woke,
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
      }
    } finally {
      unsubscribe();
    }
  };
  try {
    return { channel: await arrived(), channelWireId };
  } catch (error) {
    assertCurrent();
    throw new Error(
      `dohc created ${input.name}, and it has not reached this computer yet. It shows in Chats when it does.`,
      { cause: error },
    );
  }
}
