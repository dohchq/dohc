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

// One subscription for every folder asked about: each one is an IPC listener.
export function observeFolderAppOffers(input: {
  token: OfferWorkspaceToken; currentToken(): OfferWorkspaceToken; wants(folder: string): boolean;
  subscribe(listener: (answer: FolderAppAnswer) => void): () => void;
  onChanged(answer: FolderAppAnswer): void;
}): () => void {
  return input.subscribe(answer => {
    const current = input.currentToken();
    if (current.workspaceId === input.token.workspaceId && current.generation === input.token.generation
      && answer.workspaceId === current.workspaceId && input.wants(answer.folder)) input.onChanged(answer);
  });
}
