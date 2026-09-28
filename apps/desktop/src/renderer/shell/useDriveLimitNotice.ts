import { useCallback, useEffect } from "react";

export const DRIVE_LIMIT_MESSAGE =
  "This drive can't protect a file that another program changes at the same moment dohc saves it. Keep the workspace on your computer's own drive to avoid that.";

// What this session already showed, per workspace. Module state, because the
// shell remounts on every workspace switch: the toast shows once per session,
// and a dismissed row stays dismissed.
const shown = new Map<string, { toasted: boolean; dismissed: boolean }>();

export function forgetDriveLimitNoticesForTests(): void {
  shown.clear();
}

// The engine found that this workspace's drive has no rename that refuses to
// replace a file. The first report toasts and files a row in Notices; a
// remount files the row again without a toast, until it is dismissed.
export function useDriveLimitNotice(input: {
  workspaceId: string;
  unavailable: boolean;
  report: (notice: { message: string; toast: boolean }) => void;
}): { noteDismissed: () => void } {
  const { workspaceId, unavailable, report } = input;
  useEffect(() => {
    if (!unavailable) return;
    const state = shown.get(workspaceId) ?? { toasted: false, dismissed: false };
    if (state.dismissed) return;
    report({ message: DRIVE_LIMIT_MESSAGE, toast: !state.toasted });
    shown.set(workspaceId, { ...state, toasted: true });
  }, [report, unavailable, workspaceId]);
  const noteDismissed = useCallback(() => {
    const state = shown.get(workspaceId) ?? { toasted: true, dismissed: false };
    shown.set(workspaceId, { ...state, dismissed: true });
  }, [workspaceId]);
  return { noteDismissed };
}
