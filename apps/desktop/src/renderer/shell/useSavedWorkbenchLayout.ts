import { useCallback, useEffect, useRef, useState } from "react";
import type { GetWorkspaceUiStateResult } from "../../ipc/bridgeContract";
import { isStoppedWorkspaceRead } from "../../ipc/errorWords";
import { fileOpenStartMark, rendererMarks } from "../../performance/rendererMarks";
import { bridge } from "../bridge";
import type { CommandId } from "../commands/commandRows";
import { openUnseenWhatsNewOnce } from "../whatsNew";
import {
  MAX_OPEN_TABS,
  TAB_KINDS,
  WHATS_NEW_TAB_PATH,
  activeGroup,
  activeTabPath,
  allTabs,
  groupsMountingNewDocument,
  mergeSavedTabs,
  parseTab,
  parseUiState,
  serializeUiState,
} from "../workbench/workbenchState";
import type { WorkspaceAdmission, WorkspaceVisit } from "../workspace/workspaceVisit";
import type { useWorkspaceListing } from "./useWorkspaceListing";

export const WORKBENCH_PERSIST_DELAY_MS = 500;
// How long after admission the opening cover says it waits for the saved tabs.
export const COVER_WAIT_LINES_MS = 5_000;
// Main's layout read waits at most this long for the engine's open of the
// workspace, twice the open's deadline in desktopEngine.ts, then fails. It
// fails sooner when an open attempt passes that deadline.
export const LAYOUT_READ_WAIT_LIMIT_MS = 4 * 60_000;

export const SAVED_TABS_TITLE = "dohc opened this workspace without your saved tabs";
const TOOK_LONG = "Your saved tabs didn't load within 4 minutes.";
const COME_BACK = "They come back the next time the workspace opens. Until then, tab changes aren't saved.";
export const SAVED_TABS_RESTORE = "Restore tabs brings them back. Until you pick it, tab changes aren't saved.";
export const SAVED_TABS_WAITED = `${TOOK_LONG} ${COME_BACK}`;
export const SAVED_TABS_RESTORE_AFTER_WAIT = `${SAVED_TABS_RESTORE} ${TOOK_LONG}`;

export interface SavedTabsNotice {
  message: string;
  restore: (() => void) | null;
  toast: boolean;
}

// The commands that still run under the opening cover. Settings opens from
// every entry, as its shortcut does, and doesn't change the layout.
const SETTINGS_COMMANDS: ReadonlySet<CommandId> = new Set(["settings", "settings-appearance", "settings-agents"]);

type Listing = ReturnType<typeof useWorkspaceListing>;

interface SavedWorkbenchLayoutInput {
  visit: WorkspaceVisit;
  // Listing freshness: a restored tab closes only once a settled listing
  // lacks its file, checked again whenever a listing settles.
  prepareRestoredTabPruning: Listing["prepareRestoredTabPruning"];
  listingsSettled: Listing["listingsSettled"];
  // Dirty-tab protection: a tab with unsaved edits never closes.
  dirtyPaths: ReadonlySet<string>;
  // The Notice row for saved tabs a failed read left out.
  showSavedTabsNotice: (notice: SavedTabsNotice | null) => void;
  // Opens What's new over the restored tabs.
  openVirtualTab: (path: string, recent?: boolean, once?: boolean) => void;
  // A failed open shows in place of the opening cover.
  openFailed: boolean;
}

// Restores the workbench from .dohc/local/ui-state.json, saves it, and keeps
// the opening cover until the read answers. The shell renders at once under
// the cover (launch budgets key off shell visibility); the cover lifts in the
// commit that applies the stored state, or the defaults when there is none or
// the read fails. The stored state replaces whatever changed under the cover,
// and file opens wait for it, so nothing done under the cover loses the saved
// tabs. While the cover shows, a command other than Settings does nothing and
// is not replayed. Writes start once the read answers. A failed read can't say
// what is saved, so after one, writes wait for a later read to apply the saved
// tabs, and a default-state write can never clobber the stored one.
export function useSavedWorkbenchLayout(input: SavedWorkbenchLayoutInput) {
  const { visit, prepareRestoredTabPruning, listingsSettled, dirtyPaths } = input;
  const { workspaceId, selection, admission, ready, markSwitchPhase } = visit;
  const { state: wb, latest: wbRef, replace, update } = visit.workbench;

  // Never reset: like the restored state, it outlives a selection in a shell
  // that is not keyed by workspace.
  const loaded = useRef(false);
  const restoredActiveFileSurface = useRef<{ selection: number; groupId: string; path: string } | null>(null);
  const [restoredSurfaceCommit, setRestoredSurfaceCommit] = useState<{ selection: number; waitsForFile: boolean } | null>(null);
  // Lifts the opening cover in the same commit as the saved layout or the
  // defaults. Admission and the saved-layout read never wait on this state.
  const restored = restoredSurfaceCommit?.selection === selection;
  // Set after the restore commits, so a file open that lands before then
  // still waits behind the held ones.
  const restoredRef = useRef(false);
  const heldFileOpens = useRef<(() => void)[]>([]);
  // The tab paths the stored state restored, the only ones a file listing
  // may close. Empty until the read applies, and forever when nothing was
  // stored. State, not a ref: the listing can win the race against the read,
  // so pruning has to run again when the restore lands.
  const [restoredTabPaths, setRestoredTabPaths] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Read by callbacks when they run.
  const latest = useRef({ input, coverHolds: false });
  latest.current = { input, coverHolds: !restored && (ready || !input.openFailed) };

  // After the saved tabs return, What's new opens over them once per release,
  // reusing a restored What's new tab in any group. At the tab limit, a new
  // tab would close one of the person's tabs, so it waits for a launch with
  // room.
  const openUnseenWhatsNew = useCallback(async () => {
    const { visit: { workspaceId: id, markSwitchPhase: markPhase }, openVirtualTab } = latest.current.input;
    const current = () => latest.current.input.visit.workspaceId === id;
    const canOpen = () => {
      if (!current()) return false;
      const tabs = allTabs(wbRef.current);
      return tabs.length < MAX_OPEN_TABS || tabs.some((tab) => tab.path === WHATS_NEW_TAB_PATH);
    };
    const open = () => openVirtualTab(WHATS_NEW_TAB_PATH, false, true);
    if (!(await openUnseenWhatsNewOnce(canOpen, open)) || !current()) return;
    // A restored file it covers no longer holds back the restored-surface
    // phase. A file in another group still shows and reports itself.
    const surface = restoredActiveFileSurface.current;
    if (
      surface !== null &&
      surface.groupId === activeGroup(wbRef.current).id &&
      activeTabPath(wbRef.current) === WHATS_NEW_TAB_PATH &&
      markPhase("restored-active-surface-ready")
    ) {
      restoredActiveFileSurface.current = null;
    }
  }, [wbRef]);

  const layoutReadStartedAt = useRef(0);
  const [layoutReadFailure, setLayoutReadFailure] = useState<{ admission: WorkspaceAdmission; startedAt: number } | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      await admission.promise;
      if (admission.superseded) throw new DOMException("The workspace selection changed.", "AbortError");
      layoutReadStartedAt.current = Date.now();
      return bridge().getWorkspaceUiState({ workspaceId });
    })().then((stored) => {
      if (!current) return;
      let restoredFileSurface: typeof restoredActiveFileSurface.current = null;
      if (stored) {
        const parsed = parseUiState(stored);
        const restoredGroup = activeGroup(parsed);
        if (restoredGroup.activeTab !== null && !TAB_KINDS[parseTab(restoredGroup.activeTab).kind].virtual) {
          restoredFileSurface = { selection, groupId: restoredGroup.id, path: restoredGroup.activeTab };
        }
        // Order matters: publish the restored state, THEN enable saving — a
        // beforeunload between "loaded" and the restored state's commit must
        // save the restored state, never the stale default.
        replace(parsed);
        setRestoredTabPaths(new Set(allTabs(parsed).map((tab) => tab.path)));
      }
      restoredActiveFileSurface.current = restoredFileSurface;
      setRestoredSurfaceCommit({ selection, waitsForFile: restoredFileSurface !== null });
      loaded.current = true;
      void openUnseenWhatsNew();
    }, (error: unknown) => {
      if (!current) return;
      restoredActiveFileSurface.current = null;
      setRestoredSurfaceCommit({ selection, waitsForFile: false });
      // The window's stop message says why. Nothing reads the tabs again
      // until the workspace opens again, so nothing waits for them either.
      if (isStoppedWorkspaceRead(error)) return;
      setLayoutReadFailure({ admission, startedAt: layoutReadStartedAt.current });
    });
    return () => {
      current = false;
    };
  }, [admission, workspaceId, selection]);

  // The saved layout replaces the defaults, and tabs opened since stay open
  // beside the saved ones, the one in view still in view. A file open in both
  // keeps its saved place, and an app open now stays in its group so it
  // doesn't reload. Past the tab limit, saved tabs make room. Saving starts,
  // with what's shown when nothing was saved.
  const applySavedLayout = useCallback((stored: GetWorkspaceUiStateResult) => {
    const shown = wbRef.current;
    if (stored) {
      const saved = parseUiState(stored);
      replace(mergeSavedTabs(saved, shown));
      setRestoredTabPaths(new Set(allTabs(saved).map((tab) => tab.path)));
    } else {
      replace({ ...shown });
    }
    loaded.current = true;
    void openUnseenWhatsNew();
  }, [wbRef, replace, openUnseenWhatsNew]);

  // After the read fails, the shell shows its defaults and saves nothing. The
  // engine's open of the workspace sends activity, so the layout is read again
  // then, and once now for an open that came while the failed read answered.
  // Once the limit has passed since the first read started, it says so. A
  // read that works applies the saved layout when no tab is open or it saved
  // none, and otherwise offers Restore tabs, which applies it then. One read
  // runs at a time.
  const failed = layoutReadFailure?.admission === admission ? layoutReadFailure : null;
  useEffect(() => {
    if (failed === null) return;
    let done = false;
    let reading = false;
    let again = false;
    let waitedOut = false;
    const show = (notice: SavedTabsNotice | null) => latest.current.input.showSavedTabsNotice(notice);
    const showWaited = () => {
      waitedOut = true;
      show({ message: SAVED_TABS_WAITED, restore: null, toast: true });
    };
    const waitLeft = failed.startedAt + LAYOUT_READ_WAIT_LIMIT_MS - Date.now();
    const waiting = waitLeft > 0 ? setTimeout(showWaited, waitLeft) : undefined;
    if (waitLeft <= 0) showWaited();
    const read = () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      bridge().getWorkspaceUiState({ workspaceId }).then((stored) => {
        if (done) return;
        done = true;
        clearTimeout(waiting);
        stop();
        if (stored === null || allTabs(wbRef.current).length === 0 || allTabs(parseUiState(stored)).length === 0) {
          applySavedLayout(stored);
          show(null);
          return;
        }
        show({
          message: waitedOut ? SAVED_TABS_RESTORE_AFTER_WAIT : SAVED_TABS_RESTORE,
          restore: () => applySavedLayout(stored),
          toast: false,
        });
      }, (error: unknown) => {
        if (done) return;
        // As for the first read: after a stop, nothing waits for the tabs.
        if (isStoppedWorkspaceRead(error)) {
          done = true;
          clearTimeout(waiting);
          stop();
          show(null);
          return;
        }
        reading = false;
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
      clearTimeout(waiting);
      stop();
    };
  }, [failed, workspaceId]);

  // The cover's lines for a saved layout that is slow to load.
  const [coverWaitedFor, setCoverWaitedFor] = useState<WorkspaceAdmission | null>(null);
  useEffect(() => {
    if (!ready || restored) return;
    const timer = setTimeout(() => setCoverWaitedFor(admission), COVER_WAIT_LINES_MS);
    return () => clearTimeout(timer);
  }, [admission, ready, restored]);
  const coverWaits = ready && coverWaitedFor === admission;

  useEffect(() => {
    if (restoredSurfaceCommit?.selection !== selection || restoredSurfaceCommit.waitsForFile) return;
    markSwitchPhase("restored-active-surface-ready");
  }, [markSwitchPhase, restoredSurfaceCommit, selection]);
  const onRestoredFileSurfaceReady = useCallback((path: string, groupId: string) => {
    const target = restoredActiveFileSurface.current;
    if (target?.selection !== selection || target.groupId !== groupId || target.path !== path) return;
    if (markSwitchPhase("restored-active-surface-ready")) restoredActiveFileSurface.current = null;
  }, [markSwitchPhase, selection]);

  // Debounced save (500ms): tabs, view, panel visibility/width, rail.
  useEffect(() => {
    if (!loaded.current) return;
    const timer = setTimeout(() => {
      void bridge().setWorkspaceUiState({ workspaceId, state: serializeUiState(wb) }).catch(() => undefined);
    }, WORKBENCH_PERSIST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [wb, workspaceId]);

  // Durability at the edges: the debounce above silently drops changes made
  // within 500ms of quitting or switching workspaces — save the latest state
  // fire-and-forget on beforeunload and on unmount (a workspace switch
  // remounts the shell via key={workspaceId}). Gated on the read having
  // answered so a default snapshot can never clobber stored state.
  useEffect(() => {
    const flush = () => {
      if (!loaded.current) return;
      void bridge().setWorkspaceUiState({ workspaceId, state: serializeUiState(wbRef.current) }).catch(() => undefined);
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [workspaceId]);

  // Keep a restored tab only while the workspace still lists its file. A
  // rollback, an external delete, or a share pull changes the tree without an
  // explorer op, so nothing remaps the stored tabs and Open Editors keeps a
  // dead path across restarts.
  //
  // Every listing is checked, not just the first. A shared workspace lists
  // twice on open — once at mount, once after refreshShareView pulls the
  // changed paths — and consuming whichever landed first would either miss a
  // remote delete or judge the tabs against a pre-pull snapshot. Only the
  // restored paths are eligible (see pruneMissingRestoredTabs), so a listing
  // that raced a create can never close a tab opened this session.
  //
  // Both inputs are dependencies because either can arrive first: a listing
  // that beats the read finds nothing restored yet, and the restore is what
  // has to run the check again.
  const focusedTabPath = activeTabPath(wb);
  useEffect(() => {
    const prune = prepareRestoredTabPruning(restoredTabPaths, dirtyPaths);
    if (prune === null) return;
    const current = wbRef.current;
    const next = prune(current);
    if (next === current) return;
    // Activating a neighbour remounts the keyed inspector — that is an open
    // (closeFileTab idiom). Without the mark, the inspector's mount measure
    // brackets whatever stale mark came before it.
    for (const groupId of groupsMountingNewDocument(current, next)) {
      rendererMarks.mark(fileOpenStartMark(groupId));
    }
    // Reconciling is not a user action, but it can move the active tab as
    // one does, and then an in-flight DM navigation must not land on top.
    update(() => next);
  }, [prepareRestoredTabPruning, listingsSettled, restoredTabPaths, dirtyPaths, wb.activeEditorGroup, focusedTabPath]);

  // Held file opens run once the restore commits, after pruning.
  useEffect(() => {
    restoredRef.current = restored;
    if (!restored) return;
    for (const open of heldFileOpens.current.splice(0)) open();
  }, [restored]);
  // Holds a file open until the saved layout applies. False once it has.
  const holdFileOpen = useCallback((open: () => void) => {
    if (restoredRef.current) return false;
    heldFileOpens.current.push(open);
    return true;
  }, []);
  // Read when the command runs: the cover as the newest render showed it. A
  // stopped workspace shows in place of the cover.
  const allowsCommand = useCallback((id: CommandId) => {
    const { coverHolds, input: { visit: { stopped } } } = latest.current;
    return !(coverHolds && !stopped.current) || SETTINGS_COMMANDS.has(id);
  }, []);

  return { restored, coverWaits, onRestoredFileSurfaceReady, holdFileOpen, allowsCommand };
}
