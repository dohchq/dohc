import { useCallback, useEffect, useRef, useState } from "react";
import {
  rendererMarks,
  type SwitchCompletionPhase,
  type SwitchPhaseDetails,
} from "../../performance/rendererMarks";
import { activeTabPath, defaultWorkbenchState, type WorkbenchState } from "../workbench/workbenchState";

/** The record a pending canonical DM navigation checks itself against. */
export type DmNavigationRequest = { workspaceId: string; sequence: number };

// Cancel any in-flight canonical DM navigation so its late answer cannot land
// a chat destination over wherever the user went meanwhile. REPLACE the
// record, never increment it in place: openCanonicalDmInTab installs the very
// object it then compares against, so an in-place increment moves the pending
// navigation's captured sequence too, its isCurrent() compares the object with
// itself, and the cancellation is a no-op.
export function invalidateDmNavigation(request: { current: DmNavigationRequest }): void {
  request.current = {
    workspaceId: request.current.workspaceId,
    sequence: request.current.sequence + 1,
  };
}

/** One selection's admission. Each selection of a workspace gets its own. */
export interface WorkspaceAdmission {
  /** Settles once the open answers, or once the selection ends. */
  readonly promise: Promise<void>;
  /** The selection ended: another workspace, or the same one again, replaced it, or the shell unmounted. */
  readonly superseded: boolean;
}

/** The workbench this visit shows, and the only ways to change it. */
export interface VisitWorkbench {
  /** The workbench this render shows. */
  readonly state: WorkbenchState;
  /**
   * The newest workbench, set with each write rather than after commit.
   * Handlers read it to choose what to act on, and a keydown can arrive
   * between a commit and React's passive effects.
   */
  readonly latest: { readonly current: WorkbenchState };
  /**
   * Publishes a replacement at once: `latest` holds it before React commits
   * it, so a save that starts in between saves the replacement.
   */
  replace(next: WorkbenchState): void;
  /**
   * A transition. One that changes the destination, the active group or its
   * active tab, cancels destination-dependent navigation first.
   */
  update(updater: (state: WorkbenchState) => WorkbenchState): void;
  /** What destination-dependent navigation checks itself against. */
  readonly navigation: { current: DmNavigationRequest };
}

/** The shell's selection of one workspace, from the shell's first render of it until another selection or unmount. */
export interface WorkspaceVisit {
  readonly workspaceId: string;
  /** Counts selections in this mount: showing A, then B, then A again is three. */
  readonly selection: number;
  /**
   * The newest selection, read when a callback runs. A new selection replaces
   * the record, so work that kept the record it started under sees the
   * selection end.
   */
  readonly latestSelection: { readonly current: object };
  readonly admission: WorkspaceAdmission;
  /** The open answered for this selection. */
  readonly ready: boolean;
  /** The open answered: settles the admission and makes this selection ready. */
  admit(): void;
  /** Marks a phase of this selection's switch. False when another selection started or the phase was marked. */
  markSwitchPhase(phase: SwitchCompletionPhase, details?: SwitchPhaseDetails): boolean;
  readonly workbench: VisitWorkbench;
}

interface AdmissionGate {
  readonly workspaceId: string;
  readonly selection: number;
  readonly promise: Promise<void>;
  superseded: boolean;
  resolve(): void;
}

/**
 * Selection, admission, readiness and the workbench for the workspace this
 * shell shows. `openWorkspace` installs main's exact renderer session before
 * it waits for watcher readiness. Its response is the renderer's existing
 * proof that both happened; there is no separate admission IPC.
 * Exact-session bootstrap reads wait for that proof before they reach main.
 * Counting selections keeps an A -> B -> A prop sequence from reusing A's
 * earlier proof (DesktopRoot normally gives each workspace a fresh keyed shell).
 */
export function useWorkspaceVisit(workspaceId: string): WorkspaceVisit {
  const [state, setState] = useState<WorkbenchState>(defaultWorkbenchState);
  const latest = useRef(state);
  const replace = useCallback((next: WorkbenchState) => {
    latest.current = next;
    setState(next);
  }, []);

  const selections = useRef({ workspaceId, selection: 0 });
  if (selections.current.workspaceId !== workspaceId) {
    selections.current = { workspaceId, selection: selections.current.selection + 1 };
  }
  const selection = selections.current.selection;

  const switchTimeline = useRef<ReturnType<typeof rendererMarks.startSwitch> | null>(null);
  // Passive effects run after the new keyed shell commits. Starting here
  // excludes abandoned renders while still preceding every async readiness
  // effect the shell declares after this hook.
  useEffect(() => {
    switchTimeline.current = rendererMarks.startSwitch(selection);
  }, [selection]);
  const markSwitchPhase = useCallback(
    (phase: SwitchCompletionPhase, details?: SwitchPhaseDetails) => {
      const token = switchTimeline.current;
      if (token === null || token.selectionGeneration !== selection) return false;
      return rendererMarks.markSwitchPhase(token, phase, details);
    },
    [selection],
  );

  const gate = useRef<AdmissionGate | null>(null);
  if (gate.current?.workspaceId !== workspaceId || gate.current.selection !== selection) {
    if (gate.current) {
      gate.current.superseded = true;
      gate.current.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    gate.current = { workspaceId, selection, promise, resolve, superseded: false };
  }
  const admission = gate.current;
  useEffect(
    () => () => {
      admission.superseded = true;
      admission.resolve();
    },
    [admission],
  );
  const [readyFor, setReadyFor] = useState<{ workspaceId: string; selection: number } | null>(null);
  const ready = readyFor?.workspaceId === workspaceId && readyFor.selection === selection;
  const admit = useCallback(() => {
    admission.resolve();
    setReadyFor({ workspaceId, selection });
  }, [admission, workspaceId, selection]);

  // Every workbench destination change invalidates an in-flight canonical DM
  // lookup. Kept beside the update seam so file/graph/history/tab navigation
  // cannot be missed by a one-off opener.
  const navigation = useRef<DmNavigationRequest>({ workspaceId, sequence: 0 });
  if (navigation.current.workspaceId !== workspaceId) {
    navigation.current = { workspaceId, sequence: navigation.current.sequence + 1 };
  }
  const update = useCallback(
    (updater: (state: WorkbenchState) => WorkbenchState) => {
      // A pending canonical DM navigation loses to a DESTINATION change, not
      // to every workbench write. Most writes are not one: a panel resize
      // commits its final size, and the share-mount poll reaches this seam with
      // no user involved at all — cancelling on those would silently discard a
      // DM the user had just clicked.
      const current = latest.current;
      const next = updater(current);
      if (next === current) return;
      if (
        next.activeEditorGroup !== current.activeEditorGroup ||
        activeTabPath(next) !== activeTabPath(current)
      ) {
        invalidateDmNavigation(navigation);
      }
      replace(next);
    },
    [replace],
  );

  return {
    workspaceId,
    selection,
    latestSelection: selections,
    admission,
    ready,
    admit,
    markSwitchPhase,
    workbench: { state, latest, replace, update, navigation },
  };
}
