import { useEffect, useRef } from "react";
import type { ReportKinds } from "../../ipc/bridgeContract";
import type { PrivacySettings } from "../../settings/userSettings";
import { bridge } from "../bridge";

/** The notice's words for the reports it names. */
export function reportsNoticeText(reports: ReportKinds): string {
  const named = reports.usage && reports.errors ? "usage and error reports" : reports.usage ? "usage reports" : "error reports";
  const id = reports.usage ? " Usage reports include a random ID for this installation." : "";
  return `dohc sends ${named} to its developers.${id} Reports hold no file names, content, chats, or links.`;
}

/**
 * Shows the notice about reports when main says one is due, and tells main
 * once the notice is on screen. Until then no report leaves. A window that
 * closes or changes workspace while it asks shows nothing and tells main
 * nothing, so the next ask shows the notice again. A switch turned on later
 * asks again.
 */
export function useReportsNotice(input: {
  workspaceId: string;
  // The saved switches, or null until the window has read them.
  privacy: PrivacySettings | null;
  // Whether the notice is on screen.
  shown: boolean;
  show(reports: ReportKinds): void;
}): void {
  const { workspaceId, shown } = input;
  const usageReports = input.privacy?.usageReports ?? false;
  const errorReports = input.privacy?.errorReports ?? false;
  const show = useRef(input.show);
  show.current = input.show;

  useEffect(() => {
    if (!usageReports && !errorReports) return;
    let current = true;
    void bridge()
      .readReportsNotice({})
      .then((due) => {
        if (current && (due.usage || due.errors)) show.current(due);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [workspaceId, usageReports, errorReports]);

  useEffect(() => {
    if (shown) void bridge().acknowledgeReportsNotice({}).catch(() => undefined);
  }, [shown]);
}
