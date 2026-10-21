import { useCallback, useEffect } from "react";
import type { SyncStatusResult } from "../../ipc/bridgeContract";

export type WorkspaceLocation = NonNullable<SyncStatusResult["workspaceLocation"]>;

export const LOCATION_NOTICES: Record<WorkspaceLocation, { title: string; message: string }> = {
  "icloud-drive": {
    title: "This workspace is in iCloud Drive",
    message: "If two Macs use it, its Collections can lose recent changes or differ between the Macs. Keep the workspace outside iCloud Drive.",
  },
  "network-share": {
    title: "This workspace is on a network share",
    message: "Anyone who can read the share can read its History, including text deleted from its files. To keep History private, move the workspace to this computer's disk.",
  },
};

// This computer's dohc profile keeps which workspaces were told, so each
// hears it once per computer. Nothing syncs the profile's storage.
const storageKey = (workspaceId: string, location: WorkspaceLocation) => `dohc:location-notice:${location}:${workspaceId}`;

// What this session told, so a remount, on every workspace switch, files the
// row again without a toast until it is dismissed.
const session = new Map<string, { dismissed: boolean }>();

export function forgetLocationNoticesForTests(): void {
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

// Tells the person once that where the workspace is kept limits what dohc
// can promise: a toast and a row in Notices.
export function useLocationNotice(input: {
  workspaceId: string;
  location: WorkspaceLocation | undefined;
  report: (notice: { title: string; message: string; location: WorkspaceLocation; toast: boolean }) => void;
}): { noteDismissed: () => void } {
  const { workspaceId, location, report } = input;
  const key = location ? storageKey(workspaceId, location) : null;
  useEffect(() => {
    if (!location || !key) return;
    const told = session.get(key);
    if (told?.dismissed) return;
    if (!told) {
      if (toldBefore(key)) return;
      rememberTold(key);
      session.set(key, { dismissed: false });
    }
    report({ ...LOCATION_NOTICES[location], location, toast: !told });
  }, [key, location, report]);
  const noteDismissed = useCallback(() => {
    if (key) session.set(key, { dismissed: true });
  }, [key]);
  return { noteDismissed };
}
