import { useEffect } from "react";
import { bridge } from "../bridge";
import { CHECKPOINT_FAILURE_MESSAGE, IMPORT_FAILURE_MESSAGE } from "../../workspaces/typingRecoveryWords";
import type { useShellError } from "./useShellError";

export function useTypingRecoveryNotices(input: {
  workspaceId: string;
  ready: boolean;
} & Pick<ReturnType<typeof useShellError>, "reportShellFailure" | "clearKind">): void {
  const {workspaceId, ready, reportShellFailure, clearKind} = input;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let request = 0;
    const refresh = async (action: "read" | "retry" = "read") => {
      const asked = ++request;
      try {
        const failures = await bridge().typingRecovery({workspaceId, action});
        if (cancelled || asked !== request) return;
        for (const kind of ["checkpoint", "import"] as const) {
          const noticeKind = kind === "checkpoint" ? "typing-checkpoint" : "typing-import";
          const failure = failures.find(f => f.kind === kind);
          if (!failure) {clearKind(noticeKind); continue;}
          reportShellFailure({
            message: kind === "checkpoint" ? CHECKPOINT_FAILURE_MESSAGE : IMPORT_FAILURE_MESSAGE,
            details: [["File", failure.path], ["Reason", failure.detail]],
            kind: noticeKind,
            retry: () => {void refresh("retry");},
          });
        }
      } catch { /* A later activity event retries the main-process read. */ }
    };
    const unsubscribe = bridge().onWorkspaceActivity(event => {
      if (event.workspaceId === undefined || event.workspaceId === workspaceId) void refresh();
    });
    void refresh();
    return () => {cancelled = true; unsubscribe();};
  }, [workspaceId, ready, reportShellFailure, clearKind]);
}
