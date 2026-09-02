import { isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";
import {
  ListFileChatsResponse,
  type ListFileChatsResult,
} from "./bridgeContract";

// Keep the daemon refusal typed until this boundary. Electron preserves the
// returned code, while it would reduce a rejected invoke to message-only Error.
export async function listFileChatsForIpc(
  read: () => Promise<ListFileChatsResult>,
): Promise<ListFileChatsResponse> {
  try {
    return ListFileChatsResponse.parse(await read());
  } catch (error) {
    if (isWorkspaceUpdatingRefusal(error)) {
      return ListFileChatsResponse.parse({
        status: "refused",
        code: "workspace-updating",
      });
    }
    throw error;
  }
}
