import { useCallback, useEffect, useRef } from "react";
import type { ReportKinds } from "../../ipc/bridgeContract";
import type { PrivacySettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";

/** The notice's words for the reports it names. */
export function reportsNoticeText(reports: ReportKinds): string {
  const usageDetails =
    "usage reports (launches, active days, updates, workspaces, actions, CLI and MCP calls, sharing, apps, chat, and crash counts, with a random installation ID)";
  if (reports.usage && reports.errors) {
    return `dohc sends ${usageDetails} and error reports to its developers. Reports hold no file names, content, chats, prompts, account details, or links.`;
  }
  if (reports.usage) {
    return `dohc sends ${usageDetails} to its developers. Reports hold no file names, content, chats, prompts, account details, or links.`;
  }
  return "dohc sends error reports to its developers. Reports hold no file names, content, chats, prompts, account details, or links.";
}

/**
 * Shows the notice about reports when main says one is due. Returns what the
 * notice center calls when a toast comes on screen: the notice's own toast
 * tells main which reports its words name, and until then none of them
 * leaves. A notice waiting behind a newer toast tells main nothing yet. A
 * window that closes or changes workspace while it asks shows nothing and
 * tells main nothing, so the next ask shows the notice again. A switch
 * turned on later asks again.
 */
export function useReportsNotice(input: {
  workspaceId: string;
  privacy: PrivacySettings | null;
  notice: { id: string; reports: ReportKinds } | null;
  show(reports: ReportKinds): void;
}): (toastId: string) => void {
  const { workspaceId } = input;
  const usageReports = input.privacy?.usageReports ?? false;
  const errorReports = input.privacy?.errorReports ?? false;
  const show = useRef(input.show);
  show.current = input.show;
  const notice = useRef(input.notice);
  notice.current = input.notice;

  const { value: due } = useWorkspaceQuery(useWorkspaceSession(), {
    key: JSON.stringify([workspaceId, usageReports, errorReports]),
    manual: !usageReports && !errorReports,
    load: () => bridge().readReportsNotice({}),
  });
  useEffect(() => {
    if (due && (due.usage || due.errors)) show.current(due);
  }, [due]);

  return useCallback((toastId: string) => {
    const shown = notice.current;
    if (shown?.id === toastId)
      void bridge()
        .acknowledgeReportsNotice(shown.reports)
        .catch(() => undefined);
  }, []);
}
