import { useEffect, useRef } from "react";
import { INVALID_USAGE_RECORD } from "../../ipc/bridgeContract";
import { withErrorWords } from "../../ipc/errorWords";
import { bridge } from "../bridge";

// The shell and Privacy both report a usage record dohc cannot read.
export const unreadableWords = (code: string) => `dohc could not read the usage record (${code}).`;
export const unreadableNotice = (code: string) => `${unreadableWords(code)} ${code === INVALID_USAGE_RECORD
  ? "Start a new record in Privacy, or fix the file and try again."
  : "Fix the file or its permissions, then try again."}`;
export const USAGE_RECORD_STOPPED = "dohc stopped counting, because the usage record changed outside dohc.";

type ReportFailure = (message: string, cause?: unknown, retry?: () => Promise<void>) => void;

/** A timed save that found the file changed stops counting in main. Try
 * again reads the file again, which resumes counting when it reads, and
 * reports again when it does not. */
export function useUsageRecordStops(report: ReportFailure): void {
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => {
    let live = true;
    const readAgain = async (): Promise<void> => {
      try {
        const result = await bridge().readUsageRecord({});
        if (live && result.status === "unreadable") reportRef.current(unreadableNotice(result.code), undefined, readAgain);
      } catch (cause) {
        if (live) reportRef.current(withErrorWords("dohc could not open the usage record.", cause), cause, readAgain);
      }
    };
    const unsubscribe = bridge().onUsageRecordStopped(() => {
      if (live) reportRef.current(USAGE_RECORD_STOPPED, undefined, readAgain);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
}
