import { useEffect, useRef } from "react";
import type { GetWorkspaceUiStateResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { allTabs, parseUiState } from "../workbench/workbenchState";

export const SAVED_TABS_TITLE = "dohc opened this workspace without your saved tabs";
const TOOK_LONG = "The workspace took more than 4 minutes to open.";
const COME_BACK = "Your saved tabs come back the next time it opens. Until then, tab changes aren't saved.";
export const SAVED_TABS_RESTORE = "Restore tabs brings them back. Until you pick it, tab changes aren't saved.";
export const SAVED_TABS_WAITED = `${TOOK_LONG} ${COME_BACK}`;
export const SAVED_TABS_RESTORE_AFTER_WAIT = `${SAVED_TABS_RESTORE} ${TOOK_LONG}`;

// Main's layout read waits this long for the engine's open of the workspace,
// twice the open's deadline in desktopEngine.ts, then fails.
export const LAYOUT_READ_WAIT_LIMIT_MS = 4 * 60_000;

export interface SavedTabsNotice {
  message: string;
  restore: (() => void) | null;
  toast: boolean;
}

// After the saved layout read fails, the shell shows its defaults and saves
// nothing. The engine's open of the workspace sends activity, so the layout is
// read again then, and once now for an open that came while the failed read
// answered. A read that waited out the open says so at once. A read that
// works applies the saved layout when no tab is open or it saved none, and
// otherwise offers Restore tabs, which applies it then. One read runs at a
// time.
export function useSavedTabsReread(input: {
  workspaceId: string;
  // Set when the shell's read failed, once per admission.
  failed: { waitedOut: boolean } | null;
  tabsOpen: () => boolean;
  apply: (stored: GetWorkspaceUiStateResult) => void;
  show: (notice: SavedTabsNotice | null) => void;
}): void {
  const latest = useRef(input);
  latest.current = input;
  const { workspaceId, failed } = input;
  useEffect(() => {
    if (failed === null) return;
    let done = false;
    let reading = false;
    let again = false;
    let waitedOut = failed.waitedOut;
    const showWaited = () => latest.current.show({ message: SAVED_TABS_WAITED, restore: null, toast: true });
    if (waitedOut) showWaited();
    const read = () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      const startedAt = Date.now();
      bridge().getWorkspaceUiState({ workspaceId }).then((stored) => {
        if (done) return;
        done = true;
        stop();
        const { tabsOpen, apply, show } = latest.current;
        if (stored === null || !tabsOpen() || allTabs(parseUiState(stored)).length === 0) {
          apply(stored);
          show(null);
          return;
        }
        show({
          message: waitedOut ? SAVED_TABS_RESTORE_AFTER_WAIT : SAVED_TABS_RESTORE,
          restore: () => apply(stored),
          toast: false,
        });
      }, () => {
        if (done) return;
        reading = false;
        if (!waitedOut && Date.now() - startedAt >= LAYOUT_READ_WAIT_LIMIT_MS) {
          waitedOut = true;
          showWaited();
        }
        if (again) {
          again = false;
          read();
        }
      });
    };
    const stop = bridge().onWorkspaceActivity((event) => {
      if (!done && (event.workspaceId === undefined || event.workspaceId === workspaceId)) read();
    });
    read();
    return () => {
      done = true;
      stop();
    };
  }, [failed, workspaceId]);
}
