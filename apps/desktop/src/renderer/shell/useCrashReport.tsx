import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CrashReportSource, ReadCrashReportResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
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
 * asks main, which shows its own dialog with the destination and the exact
 * text. The renderer never answers that dialog.
 */
export function useCrashReport(notify: CrashReportNotify): {
  crashReport: CrashReportNotice | null;
  // Absent when this build has no report server, or while main is asking:
  // the notice offers Copy only.
  onSendCrashReport?: () => void;
  onDismissCrashReport: () => void;
} {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [state, setState] = useState<ReadCrashReportResult>({ report: null, sendTo: null });
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

  const send = useCallback(async (): Promise<void> => {
    setSending(true);
    try {
      const { sent } = await bridge().sendCrashReport({});
      if (sent) notifyRef.current.showSuccess("Report sent");
    } catch (error) {
      notifyRef.current.reportError(
        "dohc could not send the crash report.",
        new Error(ipcErrorMessage(error)),
        () => void send(),
      );
    } finally {
      setSending(false);
      void reload().catch(() => undefined);
    }
  }, [reload]);

  const report = state.report;
  const dismiss = useCallback(() => {
    if (!report) return;
    void bridge()
      .dismissCrashReport({ through: report.through })
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

  return {
    crashReport,
    ...(report && state.sendTo && !sending ? { onSendCrashReport: () => void send() } : {}),
    onDismissCrashReport: dismiss,
  };
}
