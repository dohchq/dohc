import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CrashReportSource,
  CrashReportView,
  ReadCrashReportResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import type { CrashReportNotice } from "../workbench/NoticeCenter";

// What stopped, in the words the rest of dohc uses for it.
const CRASH_REPORT_TITLES: Record<CrashReportSource, string> = {
  main: "dohc had an unexpected error",
  window: "A dohc window stopped unexpectedly",
  gpu: "dohc's graphics process stopped unexpectedly",
  utility: "A dohc background process stopped unexpectedly",
  engine: "The workspace engine failed",
};

export interface CrashReportNotify {
  reportError(fallback: string, error: unknown, retry: (() => void) | null): void;
  showSuccess(message: string): void;
}

/**
 * The crash report main keeps on this computer, as a notice. Send report
 * first shows the whole text and where it goes; only the dialog's confirm
 * asks main to send it, naming the revision the person read.
 */
export function useCrashReport(notify: CrashReportNotify): {
  crashReport: CrashReportNotice | null;
  // Absent when this build has no report server: the notice offers Copy only.
  onSendCrashReport?: () => void;
  onDismissCrashReport: () => void;
  sendDialog: ReactNode;
} {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [state, setState] = useState<ReadCrashReportResult>({ report: null, sendTo: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [reviewing, setReviewing] = useState<CrashReportView | null>(null);
  const [sending, setSending] = useState(false);
  // Latest wins, so an older read never repaints a newer report.
  const readToken = useRef(0);
  const reload = useCallback(async () => {
    const token = ++readToken.current;
    const next = await bridge().readCrashReport({});
    if (token === readToken.current) setState(next);
  }, []);
  useEffect(() => {
    void reload().catch(() => undefined);
    return bridge().onCrashReportChanged(() => void reload().catch(() => undefined));
  }, [reload]);

  const send = useCallback(
    async (view: CrashReportView): Promise<void> => {
      setReviewing(null);
      setSending(true);
      try {
        await bridge().sendCrashReport({ revision: view.revision });
        notifyRef.current.showSuccess("Report sent");
      } catch (error) {
        notifyRef.current.reportError(
          "dohc could not send the crash report.",
          new Error(ipcErrorMessage(error)),
          // The same text goes again. A report that changed since is shown
          // again first, because the person has not read the new text.
          () => {
            const current = stateRef.current;
            if (current.report?.revision === view.revision) void send(view);
            else if (current.report && current.sendTo) setReviewing(current.report);
          },
        );
      } finally {
        setSending(false);
        void reload().catch(() => undefined);
      }
    },
    [reload],
  );

  const report = state.report;
  const dismiss = useCallback(() => {
    if (!report) return;
    void bridge()
      .dismissCrashReport({ revision: report.revision })
      .then(async () => await reload())
      .catch((error: unknown) => {
        notifyRef.current.reportError(
          "dohc could not dismiss the crash report.",
          new Error(ipcErrorMessage(error)),
          null,
        );
      });
  }, [report, reload]);

  const crashReport = useMemo<CrashReportNotice | null>(
    () =>
      report
        ? {
            revision: report.revision,
            title: CRASH_REPORT_TITLES[report.source],
            body: report.problems > 1 ? `This report holds ${report.problems} problems.` : "",
            text: report.text,
            atMs: report.atMs,
          }
        : null,
    [report],
  );

  const sendDialog =
    reviewing && state.sendTo ? (
      <ConfirmDialog
        title="Send this crash report?"
        confirmLabel="Send report"
        onCancel={() => setReviewing(null)}
        onConfirm={() => void send(reviewing)}
        testId="crash-report-send"
        cancelTestId="crash-report-send-cancel"
        confirmTestId="crash-report-send-confirm"
      >
        <p className="mb-0 mt-2 text-xs leading-5 text-muted">
          dohc sends this text to <span className="font-mono text-ink">{state.sendTo}</span>.
        </p>
        <pre
          data-testid="crash-report-send-text"
          className="mb-0 mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg p-2 font-mono text-[11px] leading-4 text-ink"
        >
          {reviewing.text}
        </pre>
      </ConfirmDialog>
    ) : null;

  return {
    crashReport,
    ...(report && state.sendTo && !sending ? { onSendCrashReport: () => setReviewing(report) } : {}),
    onDismissCrashReport: dismiss,
    sendDialog,
  };
}
