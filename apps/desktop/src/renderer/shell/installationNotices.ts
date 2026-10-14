import { useEffect } from "react";
import type { ConnectionErrorReport } from "./connectionNotices";

// Where a failure that reaches the whole installation goes, such as a
// Disconnect: the notices of whichever workspace this window shows when the
// failure arrives. The workspace shell remounts on a switch, so a handler
// taken from the shell that started the work could be gone by then. The
// open shell registers its own here, and the last one mounted wins.
let current: ((error: ConnectionErrorReport) => void) | null = null;

export function useInstallationNotices(report: (error: ConnectionErrorReport) => void): void {
  useEffect(() => {
    current = report;
    return () => {
      if (current === report) current = null;
    };
  }, [report]);
}

export function reportInstallationFailure(error: ConnectionErrorReport): void {
  current?.(error);
}
