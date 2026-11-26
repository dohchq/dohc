import { useEffect } from "react";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import type { AboutNotices } from "./About";
import { anchorsOf, publishFileComments } from "./fileComments";

export function FileCommentsReader(props: {
  workspaceId: string;
  path: string;
  closed: boolean;
  notices: AboutNotices;
}) {
  const { workspaceId, path, closed, notices } = props;
  const { value, error, retry } = useWorkspaceQuery(useWorkspaceSession(), {
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
  const identity = `about-chats:${path}`;
  useEffect(() => {
    if (error !== null) {
      notices.report({
        identity,
        message: ipcErrorMessage(error, "dohc could not load Chats for this file."),
        cause: error,
        retry: () => void retry(),
      });
    } else if (listed) {
      notices.clear(identity);
    }
  }, [error, identity, listed, notices, retry]);
  useEffect(() => () => notices.clear(identity), [identity, notices]);
  useEffect(() => {
    if (!listed) return;
    publishFileComments(workspaceId, path, {
      anchors: anchorsOf(listed.threads),
      canComment: !closed && listed.fileObjectId !== null,
    });
  }, [closed, listed, path, workspaceId]);
  return null;
}
