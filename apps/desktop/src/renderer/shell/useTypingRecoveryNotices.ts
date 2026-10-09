import { useEffect } from "react";
import { bridge } from "../bridge";
import { typingRecoveryMessage } from "../../workspaces/typingRecoveryWords";
import type { useShellError } from "./useShellError";

export function useTypingRecoveryNotices(input: {
  workspaceId: string;
  ready: boolean;
} & Pick<ReturnType<typeof useShellError>, "reportShellFailure" | "clearKind" | "clearIdentity">): void {
  const {workspaceId, ready, reportShellFailure, clearKind, clearIdentity} = input;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let request = 0;
    let shown = new Set<string>();
    const refresh = async (action: "read" | "retry" = "read") => {
      const asked = ++request;
      try {
        const failures = await bridge().typingRecovery({workspaceId, action});
        if (cancelled || asked !== request) return;
        const listed = new Set(failures.flatMap(f => f.checkpointId ? [`typing-import:${f.checkpointId}`] : []));
        for (const identity of shown) if (!listed.has(identity)) clearIdentity(identity);
        shown = listed;
        for (const kind of ["checkpoint", "import"] as const) {
          const noticeKind = kind === "checkpoint" ? "typing-checkpoint" : "typing-import";
          const rows = failures.filter(f => f.kind === kind);
          if (!rows.length) {clearKind(noticeKind); continue;}
          for (const failure of kind === "checkpoint" ? rows.slice(0, 1) : rows) {
            const actOnCopy = async (action: "copy" | "dismiss") => {
              if (cancelled || !failure.checkpointId) return;
              try {
                await bridge().typingRecovery({workspaceId, action, checkpointId: failure.checkpointId});
                if (!cancelled) void refresh();
              } catch (error) {
                if (!cancelled) reportShellFailure({message: action === "copy" ? "dohc could not copy your typing." : "dohc could not dismiss the kept copy.", cause: error, retry: () => {void actOnCopy(action);}});
              }
            };
            reportShellFailure({
              message: typingRecoveryMessage(failure),
              details: [["File", failure.path], ["Reason", failure.detail]],
              kind: noticeKind,
              ...(failure.checkpointId ? {
                identity: `typing-import:${failure.checkpointId}`,
                action: {label: "Copy your typing", run: () => {void actOnCopy("copy");}},
                onDismiss: () => {void actOnCopy("dismiss");},
              } : {}),
              ...(failure.retryable === false ? {} : {retry: () => {void refresh("retry");}}),
            });
          }
        }
      } catch { /* A later activity event retries the main-process read. */ }
    };
    const unsubscribe = bridge().onWorkspaceActivity(event => {
      if (event.workspaceId === undefined || event.workspaceId === workspaceId) void refresh();
    });
    void refresh();
    return () => {cancelled = true; unsubscribe();};
  }, [workspaceId, ready, reportShellFailure, clearKind, clearIdentity]);
}
