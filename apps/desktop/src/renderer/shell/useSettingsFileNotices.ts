import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DesktopUserSettingsResult,
  WorkspaceSettingsResult,
} from "../../ipc/bridgeContract";
import type { IgnoredSetting } from "../../settings/settingsFile";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { useRequestSequence } from "../useRequestSequence";
import type { SettingsFileKind } from "./useShellError";

interface SettingsRead {
  source: "stored" | "default" | "recovered";
  warning?: string;
  ignored?: readonly IgnoredSetting[];
}

const USER_FILE = "dohc-settings.json";
const WORKSPACE_FILE = ".dohc/settings.local.json";

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
 * effect, as one row per file that opens the file and reads it again. The
 * user settings arrive with every change to them. The workspace settings are
 * read once the workspace opens, and again from every read or save in
 * Settings, which the answered callback takes.
 */
export function useSettingsFileNotices(input: {
  workspaceId: string;
  workspaceIsReady: boolean;
  userSettings: DesktopUserSettingsResult | null;
  show: (
    kind: SettingsFileKind,
    message: string | null,
    steps: { retry: () => void; open: () => void },
  ) => void;
  reportError: (message: string) => void;
}): (read: WorkspaceSettingsResult) => void {
  const { workspaceId, workspaceIsReady, userSettings, show, reportError } = input;
  const [workspaceRead, setWorkspaceRead] = useState<WorkspaceSettingsResult | null>(null);
  const reads = useRequestSequence([workspaceId]);

  const readWorkspaceFile = useCallback(async () => {
    const request = reads.next();
    const read = await bridge().getWorkspaceSettings({ workspaceId });
    if (reads.isCurrent(request)) setWorkspaceRead(read);
    return read;
  }, [reads, workspaceId]);

  useEffect(() => {
    if (!workspaceIsReady) return;
    // Settings shows a read that failed; this only reports the file.
    void readWorkspaceFile().catch(() => undefined);
  }, [readWorkspaceFile, workspaceIsReady]);

  // Each row's two steps. Try again shows the row again when the file still
  // says the same thing, because the retry has already cleared it.
  const stepsRef = useRef<Record<SettingsFileKind, { retry: () => void; open: () => void }> | null>(null);
  stepsRef.current = {
    "user-settings-file": {
      retry: () => {
        void bridge()
          .reloadUserSettings()
          .then((read) => showNotice("user-settings-file", settingsFileNotice(USER_FILE, read)))
          .catch((error: unknown) => reportError(ipcErrorMessage(error, "dohc could not read its settings file.")));
      },
      open: () => {
        void bridge()
          .openUserSettingsFile()
          .catch((error: unknown) => reportError(ipcErrorMessage(error, "dohc could not open its settings file.")));
      },
    },
    "workspace-settings-file": {
      retry: () => {
        void readWorkspaceFile()
          .then((read) =>
            showNotice("workspace-settings-file", settingsFileNotice(WORKSPACE_FILE, read)))
          .catch((error: unknown) =>
            reportError(ipcErrorMessage(error, "dohc could not read this workspace's settings.")));
      },
      open: () => {
        void bridge()
          .openWorkspaceSettingsFile({ workspaceId })
          .catch((error: unknown) =>
            reportError(ipcErrorMessage(error, "dohc could not open this workspace's settings.")));
      },
    },
  };
  const showNotice = useCallback(
    (kind: SettingsFileKind, message: string | null) =>
      show(kind, message, {
        retry: () => stepsRef.current?.[kind].retry(),
        open: () => stepsRef.current?.[kind].open(),
      }),
    [show],
  );

  const userMessage = settingsFileNotice(USER_FILE, userSettings);
  const workspaceMessage = settingsFileNotice(WORKSPACE_FILE, workspaceRead);
  // The same message arriving again runs nothing, so a row the person
  // dismissed stays dismissed until the file says something new.
  useEffect(() => showNotice("user-settings-file", userMessage), [showNotice, userMessage]);
  useEffect(
    () => showNotice("workspace-settings-file", workspaceMessage),
    [showNotice, workspaceMessage],
  );

  return useCallback((read: WorkspaceSettingsResult) => {
    reads.next();
    setWorkspaceRead(read);
  }, [reads]);
}
