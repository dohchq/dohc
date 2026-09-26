import { useEffect, useRef } from "react";
import { bridge } from "../bridge";
import type { ChatDispatchNotice, ChatDispatchNoticesEvent } from "../../ipc/bridgeContract";
import type { ShellErrorKind, useShellError } from "./useShellError";

const kinds = {
  "no-runner": "chat-no-runner",
  "run-failed": "chat-run-failed",
  "budget-paused": "chat-budget-paused",
} as const satisfies Record<ChatDispatchNotice["reason"], ShellErrorKind>;

export function useChatDispatchNotices(
  workspaceId: string,
  ready: boolean,
  report: ReturnType<typeof useShellError>["reportShellFailure"],
  clear: ReturnType<typeof useShellError>["clearKind"],
) {
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let revision = -1;
    const shown = new Map<ChatDispatchNotice["reason"], string>();
    const isCurrent = () => active && currentWorkspace.current === workspaceId;
    const receive = (event: ChatDispatchNoticesEvent) => {
      if (!isCurrent() || event.workspaceId !== workspaceId || event.revision <= revision) return;
      revision = event.revision;
      for (const reason of Object.keys(kinds) as Array<ChatDispatchNotice["reason"]>) {
        const notice = event.notices.find((item) => item.reason === reason);
        if (!notice) { clear(kinds[reason]); shown.delete(reason); continue; }
        if (shown.get(reason) === notice.id) continue;
        shown.set(reason, notice.id);
        report({
          message: notice.message, kind: kinds[reason],
          details: [
            ["Thread", notice.threadId],
            ...(notice.runId ? [["Run", notice.runId] as const] : []),
            ...(notice.logPath ? [["Log", notice.logPath] as const] : []),
          ],
          onDismiss: () => {
            if (!isCurrent()) return;
            void bridge().dismissChatDispatchNotice({ workspaceId, id: notice.id }).catch((cause: unknown) => {
              if (!isCurrent()) return;
              shown.delete(reason);
              report({ message: "dohc could not dismiss this notice. Open this workspace again to try again.", cause });
            });
          },
        });
      }
    };
    const unsubscribe = bridge().onChatDispatchNotices(receive);
    void bridge().registerChatDispatchNotices({ workspaceId }).then(receive).catch((cause: unknown) => {
      if (isCurrent()) report({ message: "dohc could not load dispatch notices. Open this workspace again to try again.", cause });
    });
    return () => { active = false; unsubscribe(); };
  }, [workspaceId, ready, report, clear]);
}
