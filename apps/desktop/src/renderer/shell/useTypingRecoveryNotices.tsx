import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { typingRecoveryMessage } from "../../workspaces/typingRecoveryWords";
import type { useShellError } from "./useShellError";

const dismissedTypingNotices = new Set<string>();

export function useTypingRecoveryNotices(input: {
  workspaceId: string;
  ready: boolean;
  openHistory: () => void;
} & Pick<ReturnType<typeof useShellError>, "reportShellFailure" | "showSuccessNotice" | "showWarningNotice" | "clearKind" | "clearIdentity">) {
  const {workspaceId, ready, openHistory, reportShellFailure, showSuccessNotice, showWarningNotice, clearKind, clearIdentity} = input;
  const [discarding, setDiscarding] = useState<{workspaceId: string; path: string; run: () => void} | null>(null);
  useEffect(() => setDiscarding(null), [workspaceId, ready]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let request = 0;
    let shown = new Set<string>();
    const refresh = async (action: "read" | "retry" = "read") => {
      const asked = ++request;
      try {
        const {failures} = await bridge().typingRecovery({workspaceId, action});
        if (cancelled || asked !== request) return;
        const listed = new Set(failures.flatMap(f => f.checkpointId ? [`typing-import:${f.checkpointId}`] : []));
        for (const identity of shown) if (!listed.has(identity)) clearIdentity(identity);
        shown = listed;
        for (const kind of ["checkpoint", "import"] as const) {
          const noticeKind = kind === "checkpoint" ? "typing-checkpoint" : "typing-import";
          const rows = failures.filter(f => f.kind === kind);
          if (!rows.length) {clearKind(noticeKind); continue;}
          for (const failure of kind === "checkpoint" ? rows.slice(0, 1) : rows) {
            const identity = failure.checkpointId ? `typing-import:${failure.checkpointId}` : undefined;
            if (identity && dismissedTypingNotices.has(`${workspaceId}:${identity}`)) continue;
            const requestDiscard = () => {
              if (!cancelled) setDiscarding({workspaceId, path: failure.path, run: () => {void actOnCopy("discard");}});
            };
            const actOnCopy = async (action: "copy" | "discard") => {
              if (cancelled || !failure.checkpointId) return;
              try {
                const result = await bridge().typingRecovery({workspaceId, action, checkpointId: failure.checkpointId});
                if (cancelled) return;
                if (result.outcome === "missing" || result.outcome === "imported") {
                  clearIdentity(identity!);
                  if (result.outcome === "imported") {
                    showSuccessNotice(`dohc recovered your typing in "${failure.path}".`, undefined, undefined,
                      {label: "Open History", run: () => {if (!cancelled) openHistory();}});
                  } else showWarningNotice("This kept copy is no longer on this computer.");
                }
                void refresh();
              } catch (error) {
                if (!cancelled) reportShellFailure({message: action === "copy" ? "dohc could not copy your typing." : "dohc could not discard your typing.", cause: error,
                  retry: action === "discard" ? requestDiscard : () => {void actOnCopy("copy");}});
              }
            };
            reportShellFailure({
              message: typingRecoveryMessage(failure),
              details: failure.reason === "drawing-unavailable" ? [["File", failure.path]] : [["File", failure.path], ["Reason", failure.detail]],
              kind: noticeKind,
              toast: "preserve",
              ...(failure.checkpointId ? {
                identity,
                action: {label: "Copy your typing", run: () => {void actOnCopy("copy");}, additional: [{label: "Discard your typing", run: requestDiscard}]},
                onDismiss: () => {
                  dismissedTypingNotices.add(`${workspaceId}:${identity}`);
                  if (!cancelled) void bridge().typingRecovery({workspaceId, action: "dismiss", checkpointId: failure.checkpointId!}).catch(() => undefined);
                },
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
  }, [workspaceId, ready, openHistory, reportShellFailure, showSuccessNotice, showWarningNotice, clearKind, clearIdentity]);
  return discarding && discarding.workspaceId === workspaceId && ready ? (
    <ConfirmDialog intent="danger" title="Discard your typing?" confirmLabel="Discard your typing"
      testId="typing-discard-dialog" cancelTestId="typing-discard-cancel" confirmTestId="typing-discard-confirm"
      onCancel={() => setDiscarding(null)}
      onConfirm={() => {setDiscarding(null); discarding.run();}}>
      <p className="m-0 mt-2 text-[13px] text-muted">This deletes the kept typing for "{discarding.path}" from this computer. This cannot be undone.</p>
    </ConfirmDialog>
  ) : null;
}
