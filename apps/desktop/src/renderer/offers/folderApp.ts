import type { FolderAppAnswer } from "../../ipc/bridgeContract";
export interface OfferWorkspaceToken { workspaceId: string; generation: number }
// Replace the token on a switch (including A -> B -> A) and on a newer request.
export async function readFolderAppOffer(input: {
  token: OfferWorkspaceToken; currentToken(): OfferWorkspaceToken; folder: string;
  read(workspaceId: string, folder: string): Promise<FolderAppAnswer>;
}): Promise<FolderAppAnswer | null> {
  const { workspaceId, generation } = input.token;
  const current = () => {
    const token = input.currentToken();
    return token.workspaceId === workspaceId && token.generation === generation;
  };
  try {
    const answer = await input.read(workspaceId, input.folder);
    return current() && answer.workspaceId === workspaceId && answer.folder === input.folder ? answer : null;
  } catch (error) {
    if (!current()) return null;
    throw error;
  }
}
