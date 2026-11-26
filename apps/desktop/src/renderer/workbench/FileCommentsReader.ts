import { useEffect } from "react";
import { bridge } from "../bridge";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import { anchorsOf, publishFileComments } from "./fileComments";

export function FileCommentsReader(props: { workspaceId: string; path: string; closed: boolean }) {
  const { workspaceId, path, closed } = props;
  const { value, retry } = useWorkspaceQuery(useWorkspaceSession(), {
    key: JSON.stringify([workspaceId, path]),
    load: () => bridge().listFileChats({ workspaceId, path }),
  });
  useEffect(
    () =>
      bridge().onWorkspaceActivity((event) => {
        if (event.workspaceId === undefined || event.workspaceId === workspaceId) void retry();
      }),
    [retry, workspaceId],
  );
  const listed = value && !("status" in value) ? value : null;
  useEffect(() => {
    if (!listed) return;
    publishFileComments(workspaceId, path, {
      anchors: anchorsOf(listed.threads),
      canComment: !closed && listed.fileObjectId !== null,
    });
  }, [closed, listed, path, workspaceId]);
  return null;
}
