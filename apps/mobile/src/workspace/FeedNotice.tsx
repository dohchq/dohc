import { workspaceWords } from "@dohc/interface-words/workspace";
import { useWorkspaces } from "../chats/Workspaces";
import { useFailureNotice, useFeed } from "./useView";

// A change feed that keeps failing, on the tabs: one toast and one Notices row for the open workspace, with Try again.
// What's on screen stays, so it can't go out of date without a sign.
export function FeedNotice() {
  const { current } = useWorkspaces();
  return current ? <WorkspaceFeedNotice key={current.id} workspaceId={current.id} workspace={current.name} /> : null;
}

function WorkspaceFeedNotice({ workspaceId, workspace }: { workspaceId: string; workspace: string }) {
  const { state, retry } = useFeed();
  useFailureNotice(`feed:${workspaceId}`, workspaceWords.changesFailed(workspace), state, retry);
  return null;
}
