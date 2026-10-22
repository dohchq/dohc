import { useCallback, useEffect } from "react";

/**
 * The notice for a workspace on a network share. On Windows, History is as
 * private as the folder that holds it, and a user's own folder is the one
 * private by default. On a Mac or Linux computer, the engine makes History
 * private on this computer's own disk.
 */
export function networkShareNotice(platform: NodeJS.Platform): { title: string; message: string } {
  const destination = platform === "win32" ? "into your user folder on this computer" : "to this computer's disk";
  return {
    title: "This workspace is on a network share",
    message: `Anyone who can read the share can read its History, including text deleted from its files. To keep History private, move the workspace ${destination}.`,
  };
}

// This computer's dohc profile keeps which workspaces were told, so each
// hears it once per computer. Nothing syncs the profile's storage.
const storageKey = (workspaceId: string) => `dohc:network-share-notice:${workspaceId}`;

// What this session told, so a remount, on every workspace switch, files the
// row again without a toast until it is dismissed.
const session = new Map<string, { dismissed: boolean }>();

export function forgetNetworkShareNoticesForTests(): void {
  session.clear();
}

function toldBefore(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function rememberTold(key: string): void {
  try {
    localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Refused storage tells the person again next launch.
  }
}

// Tells the person once that a network share's readers can read the
// workspace's History: a toast and a row in Notices.
export function useNetworkShareNotice(input: {
  workspaceId: string;
  onNetworkShare: boolean;
  platform: NodeJS.Platform;
  report: (notice: { title: string; message: string; toast: boolean }) => void;
}): { noteDismissed: () => void } {
  const { workspaceId, onNetworkShare, platform, report } = input;
  const key = storageKey(workspaceId);
  useEffect(() => {
    if (!onNetworkShare) return;
    const told = session.get(key);
    if (told?.dismissed) return;
    if (!told) {
      if (toldBefore(key)) return;
      rememberTold(key);
      session.set(key, { dismissed: false });
    }
    report({ ...networkShareNotice(platform), toast: !told });
  }, [key, onNetworkShare, platform, report]);
  const noteDismissed = useCallback(() => {
    session.set(key, { dismissed: true });
  }, [key]);
  return { noteDismissed };
}
