import { nameSlug } from "@dohc/workspace-contracts/names";
import type { ChatChannel, ChatChannelType, LinkedChatStore, WorkspaceId } from "@dohc/workspace-contracts/engine";
import { GROUP_NAME_TAKEN_ERROR } from "../ipc/errorWords";

export interface GroupCreateInput {
  workspaceId: WorkspaceId;
  name: string;
  type?: ChatChannelType;
  purpose?: string;
  folderPath?: string;
}

// The engine refuses a taken or malformed name by code. Whoever typed the
// name reads what to change.
const GROUP_CREATE_REFUSALS = new Map<string, string>([
  ["channel-exists", "A group with that name already exists."],
  ["invalid-channel-name", "Use 1 to 80 characters, including at least one letter or number."],
]);

function groupCreateRefusal(error: unknown): unknown {
  const copy = error instanceof Error ? GROUP_CREATE_REFUSALS.get(error.message) : undefined;
  if (copy === undefined) return error;
  const refusal = new Error(copy);
  if (error instanceof Error && error.message === "channel-exists") refusal.name = GROUP_NAME_TAKEN_ERROR;
  return refusal;
}

// New group, for a person in the window and for an agent through the CLI or
// MCP. A group is a folder: the folder is the group's slug unless the creator
// named one, and it exists before the group so its files have a home before
// the first post.
export async function createGroup(
  store: Pick<LinkedChatStore, "createChannel">,
  ensureFolder: (folderPath: string) => Promise<void>,
  input: GroupCreateInput,
): Promise<ChatChannel> {
  const folderPath = input.folderPath ?? nameSlug(input.name);
  if (!folderPath) {
    throw new Error("Give the group a name with a letter or a number, or name its folder.");
  }
  await ensureFolder(folderPath);
  return await store.createChannel({
    workspaceId: input.workspaceId,
    name: input.name,
    kind: "channel",
    ...(input.type ? { type: input.type } : {}),
    ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
    folderPath,
  }).catch((error: unknown) => {
    throw groupCreateRefusal(error);
  });
}
