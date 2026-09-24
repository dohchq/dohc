import { useCallback, useEffect, useState } from "react";
import type {
  DesktopUserSettingsResult,
  WorkspaceSettingsResult,
} from "../../ipc/bridgeContract";
import type { IgnoredSetting } from "../../settings/settingsFile";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";
import type { SettingsFileKind } from "./useShellError";

interface SettingsRead {
  source: "stored" | "default" | "recovered";
  warning?: string;
  ignored?: readonly IgnoredSetting[];
}

/** What a settings read owes the person, or null when the whole file applies. */
export function settingsFileNotice(
  fileName: string,
  read: SettingsRead | null,
): string | null {
  if (!read) return null;
  // A recovered read's warning names the file dohc could not use. Any other
  // warning reports a finished reset, which Settings shows where it happened.
  if (read.source === "recovered") return read.warning ?? null;
  const ignored = read.ignored ?? [];
  const [first] = ignored;
  if (!first) return null;
  if (ignored.length === 1) {
    const why = first.reason === "unknown"
      ? "it is not a setting dohc knows"
      : "its value is not valid";
    return `dohc ignored ${first.key} in ${fileName} because ${why}. The other settings apply.`;
  }
  const keys = ignored
    .map(({ key, reason }) =>
      `${key} (${reason === "unknown" ? "unknown setting" : "value not valid"})`)
    .join(", ");
  return `dohc ignored ${ignored.length} settings in ${fileName}: ${keys}. The other settings apply.`;
}

/**
 * Tells the person when a settings file they can edit is not fully in
 * effect, as one row per file. The user settings arrive with every change to
 * them. The workspace settings are read once the workspace opens, and again
 * from every read or save in Settings, which the answered callback takes.
 */
export function useSettingsFileNotices(input: {
  workspaceId: string;
  workspaceIsReady: boolean;
  userSettings: DesktopUserSettingsResult | null;
  show: (kind: SettingsFileKind, message: string | null) => void;
}): (read: WorkspaceSettingsResult) => void {
  const { workspaceId, workspaceIsReady, userSettings, show } = input;
  const [workspaceRead, setWorkspaceRead] = useState<WorkspaceSettingsResult | null>(null);
  const reads = useRequestSequence([workspaceId]);

  useEffect(() => {
    if (!workspaceIsReady) return;
    const request = reads.next();
    void bridge()
      .getWorkspaceSettings({ workspaceId })
      .then((read) => {
        if (reads.isCurrent(request)) setWorkspaceRead(read);
      })
      // Settings shows a read that failed; this only reports the file.
      .catch(() => undefined);
  }, [reads, workspaceId, workspaceIsReady]);

  const userMessage = settingsFileNotice("dohc-settings.json", userSettings);
  const workspaceMessage = settingsFileNotice(".dohc/settings.local.json", workspaceRead);
  // The same message arriving again runs nothing, so a row the person
  // dismissed stays dismissed until the file says something new.
  useEffect(() => show("user-settings-file", userMessage), [show, userMessage]);
  useEffect(() => show("workspace-settings-file", workspaceMessage), [show, workspaceMessage]);

  return useCallback((read: WorkspaceSettingsResult) => {
    reads.next();
    setWorkspaceRead(read);
  }, [reads]);
}
