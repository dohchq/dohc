import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UpdateActionResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import {
  orphanedDraftCount,
  orphanedDraftIds,
  useAllOrphanedDrafts,
} from "./orphanedDrafts";
import { RecoveryList } from "./RecoveryList";

type UnloadKind = "close" | "reload" | "update" | "quit";

// The guard cannot tell one unload's beforeunload from another's, but the
// user asked for a specific action by name — confirming must resume THAT
// action, never swap it for a plain exit (#579 review, r7 + r8). In-app
// reloads route through here so the guard knows what it blocked: one slot,
// consumed by the next beforeunload, cleared when the request itself fails
// without unloading. Quits are decided BEFORE they start (main asks), and
// update installs are decided before quitAndInstall is ever called — neither
// uses this slot.
type PendingUnload = {
  kind: "reload" | "update";
  // Re-runs the blocked action. Resolves TRUE when the action was accepted
  // and an unload should follow, FALSE when it failed without unloading —
  // the guard re-arms itself on false (#579 review, r9).
  resume: () => Promise<boolean>;
};
let pendingUnload: PendingUnload | null = null;

// The mounted guard registers its dialog opener here so the decide-first
// paths (update install) can warn WITHOUT triggering the destructive call.
let openRecoveryWarning:
  | ((warning: { kind: UnloadKind; resume: () => Promise<boolean> }) => void)
  | null = null;

export function requestGuardedReload(): void {
  const attempt: PendingUnload = {
    kind: "reload",
    resume: () =>
      bridge()
        .reloadRenderer()
        .then(
          () => true,
          () => false,
        ),
  };
  pendingUnload = attempt;
  void bridge()
    .reloadRenderer()
    .catch(() => {
      if (pendingUnload === attempt) pendingUnload = null;
    });
}

// Decide BEFORE the destructive call (#579 review, r10): electron-updater's
// quitAndInstall is ONE-SHOT — calling it and then vetoing the quit would
// burn the latch, and no "Restart anyway" could ever restart. So the drafts
// are checked first: on a clear path the install runs at once (main
// pre-approves the quit it starts), and on a blocked path the dialog opens
// INSTEAD of the install, whose confirm makes the one and only call.
// Returns null when the dialog took over — the caller's own flow ends there.
export async function requestGuardedUpdateInstall(): Promise<UpdateActionResult | null> {
  if (orphanedDraftCount() === 0 || openRecoveryWarning === null) {
    return beginInstall();
  }
  openRecoveryWarning({
    kind: "update",
    resume: () => beginInstall().then((result) => result.accepted, () => false),
  });
  return null;
}

// The install's own exit runs through beforeunload like any other unload, and
// a draft captured between the recovery check and that exit blocks it there
// (#579 review, r13). The warning must then name what the user was actually
// doing — a RESTART, not a close — so the intent is claimed before the call
// (#579 review, r16).
//
// The resume is the QUIT, never a second install: quitAndInstall's latch is
// one-shot and already spent by the time beforeunload can fire, and main has
// pre-approved the quit it started. A plain window.close() would also strand
// the staged installer on macOS, where closing a window does not quit.
function beginInstall(): Promise<UpdateActionResult> {
  const attempt: PendingUnload = {
    kind: "update",
    resume: () =>
      bridge()
        .resumeQuit()
        .then(
          () => true,
          () => false,
        ),
  };
  pendingUnload = attempt;
  const forget = () => {
    // An install that never started must not label a later, unrelated close
    // "Restart" (`requestGuardedReload` precedent).
    if (pendingUnload === attempt) pendingUnload = null;
  };
  return bridge()
    .installUpdate()
    .then(
      (result) => {
        if (!result.accepted) forget();
        return result;
      },
      (error: unknown) => {
        forget();
        throw error;
      },
    );
}

// Fail-safe for a bypassed unload that never happens and gives no failure
// signal (window.close can be vetoed by another listener): the guard comes
// back on its own. Not a rejection limit — real unloads land in
// milliseconds; this only bounds how long the drafts go unguarded.
const BYPASS_REARM_MS = 10_000;

// Set-aside drafts (#567) live in renderer memory only, so closing,
// reloading, quitting, or restarting into an update destroys them — and an
// irreversible change must be announced before it runs (product invariant).
// Electron cancels a close SILENTLY on preventDefault, so the dialog below
// is the announcement, and it carries the full recovery list: the warning
// must offer the very actions it demands (#579 review, r5).
//
// This mounts ABOVE AppErrorBoundary (see main.tsx): a crash unmounts the
// shell, and the crash screen's "Reload dohc" must not destroy the drafts
// unannounced. The store already lives outside React, so this guard needs
// nothing from the crashed tree.
//
// Persisting the drafts instead is a separate durability decision
// (storage location, lifetime, secret-path handling), deliberately not
// taken here (#579 review, r4).
export function RecoveryCloseGuard(props: { children: ReactNode }) {
  const [closeWarning, setCloseWarning] = useState<{
    // What the user asked for — the confirm button resumes exactly it.
    kind: UnloadKind;
    resume: (() => Promise<boolean>) | null;
  } | null>(null);
  // LIVE, not a snapshot (#579 review, r10): the dialog embeds Copy/Dismiss,
  // so the count must follow every dismissal, and an emptied dialog has
  // nothing left to warn about.
  const liveDrafts = useAllOrphanedDrafts();
  const liveCount = liveDrafts.length;
  const warningOpen = closeWarning !== null;
  useEffect(() => {
    if (warningOpen && liveCount === 0) setCloseWarning(null);
  }, [warningOpen, liveCount]);
  const bypassCloseGuard = useRef(false);
  const bypassRearmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The drafts the warning LISTED when the user confirmed. An approval covers
  // exactly those (#579 review, r13 + r14) — never a draft a queued reopen
  // sets aside afterwards, which the user was never shown. Every gate below
  // measures the LIVE store against this set instead of reading the bypass as
  // "the user already decided", so a new draft stops the exit and comes back
  // to the dialog with its text intact.
  const approvedDraftIds = useRef<ReadonlySet<number>>(new Set());
  const hasUnapprovedDrafts = () =>
    orphanedDraftIds().some((id) => !approvedDraftIds.current.has(id));
  const rearmGuard = () => {
    bypassCloseGuard.current = false;
    approvedDraftIds.current = new Set();
    if (bypassRearmTimer.current) {
      clearTimeout(bypassRearmTimer.current);
      bypassRearmTimer.current = null;
    }
  };
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Consumed either way: if this unload proceeds the slot dies with the
      // page, and if it is blocked the dialog now owns the answer.
      const pending = pendingUnload;
      pendingUnload = null;
      if (!hasUnapprovedDrafts()) {
        // One-shot (#579 review, r9): a bypass is consumed by the unload it
        // permits — never a later, unrelated close.
        if (bypassCloseGuard.current) rearmGuard();
        return;
      }
      // Past this line the store holds a draft the user never saw. The earlier
      // approval does not cover it, so the exit stops and asks again with the
      // full list (#579 review, r13).
      rearmGuard();
      event.preventDefault();
      setCloseWarning({
        kind: pending?.kind ?? "close",
        resume: pending?.resume ?? null,
      });
    };
    // Required contract, called directly (#579 review, r15). The bridge and
    // the preload gained both listeners in this same change, so an optional
    // call would define a SECOND supported preload — one where the renderer
    // silently drops native-quit handling instead of showing the mismatched
    // build. There are no users and no old preloads to carry.
    //
    // Main re-asks at the quit boundary (#579 review, r12) — the answer is
    // read at ANSWER time, so an edit set aside after this renderer's own
    // check still blocks the install. The answer is the LIVE store measured
    // against what the user approved (#579 review, r13), never a blanket
    // "the user already confirmed": a draft captured after the confirm was in
    // no warning, and quitAndInstall is the last chance to stop. A refusal
    // here is what brings the dialog back with that draft listed.
    const unsubscribeRecoveryCheck = bridge().onRecoveryCheckRequested(
      (requestId) => {
        void bridge().answerRecoveryCheck({
          requestId,
          blocked: hasUnapprovedDrafts(),
        });
      },
    );
    // A native quit (Cmd+Q, tray Quit) is main-initiated: answer promptly —
    // resume when nothing is at stake, hold when the dialog takes over — so
    // main's hung-renderer fail-safe never fires for a live renderer.
    const unsubscribeQuit = bridge().onQuitRequested(() => {
      if (!hasUnapprovedDrafts()) {
        void bridge().resumeQuit();
        return;
      }
      void bridge().holdQuit();
      setCloseWarning({
        kind: "quit",
        resume: () =>
          bridge()
            .resumeQuit()
            .then(
              () => true,
              () => false,
            ),
      });
    });
    // Registered LAST, so a preload that fails the contract above leaves no
    // listener and no opener behind — a half-installed guard is worse than
    // none, because the cleanup React skips would never remove it.
    window.addEventListener("beforeunload", onBeforeUnload);
    openRecoveryWarning = (warning) => setCloseWarning(warning);
    return () => {
      openRecoveryWarning = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
      unsubscribeQuit();
      unsubscribeRecoveryCheck();
      if (bypassRearmTimer.current) clearTimeout(bypassRearmTimer.current);
    };
    // rearmGuard and hasUnapprovedDrafts read refs and the module store, never
    // render state, so the first closure stays correct; the handlers register
    // once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      {props.children}
      {closeWarning !== null && liveCount > 0 ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/20">
          <div
            data-testid="recovery-close-warning"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recovery-close-warning-title"
            className="dohc-elevated w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5"
          >
            <h3
              id="recovery-close-warning-title"
              className="m-0 text-sm font-semibold text-ink"
            >
              {closeWarning.kind === "reload"
                ? "Reload"
                : closeWarning.kind === "update"
                  ? "Restart"
                  : closeWarning.kind === "quit"
                    ? "Quit"
                    : "Close"}{" "}
              without your set-aside {liveCount === 1 ? "edit" : "edits"}?
            </h3>
            <p className="mb-0 mt-2 text-xs leading-5 text-muted">
              {`${liveCount} set-aside ${
                liveCount === 1 ? "edit is" : "edits are"
              } lost when dohc ${
                closeWarning.kind === "reload"
                  ? "reloads"
                  : closeWarning.kind === "update"
                    ? "restarts"
                    : closeWarning.kind === "quit"
                      ? "quits"
                      : "closes"
              }.`}{" "}
              Copy {liveCount === 1 ? "it" : "them"} here to keep the text.
            </p>
            <div className="mt-3 max-h-60 overflow-y-auto">
              <RecoveryList />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-testid="recovery-close-goback"
                autoFocus
                onClick={() => setCloseWarning(null)}
                className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
              >
                Go back
              </button>
              <button
                type="button"
                data-testid="recovery-close-anyway"
                onClick={() => {
                  // Resume exactly what the user asked for: a requested
                  // reload, restart, or quit must not become a plain exit
                  // (#579 review, r7 + r8 + r10).
                  const kind = closeWarning.kind;
                  const resume =
                    closeWarning.resume ??
                    (() => {
                      window.close();
                      return Promise.resolve(true);
                    });
                  setCloseWarning(null);
                  // The bypass is scoped to THIS attempt (#579 review, r9):
                  // consumed by the unload it permits, restored on an
                  // explicit failure signal, and restored by the fail-safe
                  // timer when no signal exists — a resumed action that
                  // never unloads must not leave a later close unguarded.
                  //
                  // It is scoped to THIS LIST too (#579 review, r13): the user
                  // approved losing the drafts the dialog just showed, and a
                  // reopen queued behind this click can still set one more
                  // aside. That draft keeps its notice and its Copy button,
                  // and the gates below refuse to exit over it.
                  approvedDraftIds.current = new Set(
                    liveDrafts.map((row) => row.draft.id),
                  );
                  bypassCloseGuard.current = true;
                  if (bypassRearmTimer.current) {
                    clearTimeout(bypassRearmTimer.current);
                  }
                  bypassRearmTimer.current = setTimeout(
                    rearmGuard,
                    BYPASS_REARM_MS,
                  );
                  void resume().then((unloading) => {
                    if (unloading) return;
                    // The action did not unload. When a draft this approval
                    // never covered is WHY — the boundary re-check refuses an
                    // install for it — the user gets the decision back, now
                    // over the full list (#579 review, r14). Any other
                    // failure (an updater that is not ready) re-arms in
                    // silence, exactly as before: nothing new is at stake.
                    const uncovered = hasUnapprovedDrafts();
                    rearmGuard();
                    if (uncovered) setCloseWarning({ kind, resume });
                  });
                }}
                className="h-8 cursor-pointer rounded-md bg-accent px-3 text-xs font-semibold text-bg hover:opacity-90"
              >
                {closeWarning.kind === "reload"
                  ? "Reload anyway"
                  : closeWarning.kind === "update"
                    ? "Restart anyway"
                    : closeWarning.kind === "quit"
                      ? "Quit anyway"
                      : "Close anyway"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
