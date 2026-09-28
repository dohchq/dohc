import { useCallback, useEffect } from "react";

const shown = new Map<string, { copies: string; dismissed: boolean }>();

export function useKeptFilesNotice(input: {
  workspaceId: string;
  paths: readonly (readonly [string, string])[] | undefined;
  report: (notice: { paths: readonly (readonly [string, string])[]; toast: boolean }, openFolder: () => void) => void;
  openFolder: () => void;
}): { noteDismissed: () => void } {
  const { workspaceId, paths, report, openFolder } = input;
  const copies = JSON.stringify(paths ?? []);
  useEffect(() => {
    const current: [string, string][] = JSON.parse(copies);
    if (!current.length) {
      if (paths !== undefined) {
        report({ paths: [], toast: false }, openFolder);
        shown.delete(workspaceId);
      }
      return;
    }
    const previous = shown.get(workspaceId);
    if (previous?.copies === copies && previous.dismissed) return;
    report({ paths: current, toast: previous?.copies !== copies }, openFolder);
    shown.set(workspaceId, { copies, dismissed: false });
  }, [workspaceId, copies, paths === undefined, report, openFolder]);
  const noteDismissed = useCallback(() => {
    shown.set(workspaceId, { copies, dismissed: true });
  }, [workspaceId, copies]);
  return { noteDismissed };
}
