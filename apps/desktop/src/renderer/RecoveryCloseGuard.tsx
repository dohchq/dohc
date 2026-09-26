import { hasPendingEditorDrafts, settlePendingEditorDrafts } from "./pendingEditorDrafts";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { UpdateActionResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import {
  COLLECTION_WRITE_STALL_MS,
  abandonPendingCollectionFieldWrites,
  collectionWriteFailures,
  hasPendingCollectionFieldWrites,
  settleCollectionFieldWrites,
} from "./collections/recordFieldWrites";
import { Overlay } from "./Overlay";
import { atRiskOrphanedDraftIds, useAllOrphanedDrafts } from "./orphanedDrafts";
import { RecoveryList } from "./RecoveryList";

type UnloadKind = "close" | "reload" | "update" | "quit";

// The warning dialog's copy, one row per unload kind so the title, body, and
// confirm button can never name different actions. "update" reads as Restart
// because Restart is the action the user clicked.
const UNLOAD_COPY: Record<
  UnloadKind,
  { title: string; verb: string; confirm: string }
> = {
  close: { title: "Close", verb: "closes", confirm: "Close anyway" },
  reload: { title: "Reload", verb: "reloads", confirm: "Reload anyway" },
  update: { title: "Restart", verb: "restarts", confirm: "Restart anyway" },
  quit: { title: "Quit", verb: "quits", confirm: "Quit anyway" },
};

// The guard cannot tell one unload's beforeunload from another's, but the
// user asked for a specific action by name — confirming must resume that
// action, never swap it for a plain exit. In-app
// reloads route through here so the guard knows what it blocked: one slot,
// consumed by the next beforeunload, cleared when the request itself fails
// without unloading. Quits are decided before they start (main asks), and
// update installs are decided before quitAndInstall is ever called — neither
// uses this slot.
type PendingUnload = {
  kind: "reload" | "update" | "quit";
  // Re-runs the blocked action. Resolves true when the action was accepted
  // and an unload should follow, false when it failed without unloading —
  // the guard re-arms itself on false.
  resume: () => Promise<boolean>;
  // The drain this intent waited on could not land its writes.
  failed?: () => void;
};
let pendingUnload: PendingUnload | null = null;
let exitRequest = 0;

// The mounted guard registers its dialog opener here so the decide-first
// paths (update install) can warn without triggering the destructive call.
let openRecoveryWarning:
  | ((warning: {
      kind: UnloadKind;
      resume: () => Promise<boolean>;
      round?: number;
    }) => void)
  | null = null;

// The exit round this window is currently answering, so a late reply, a
// dialog confirm, or a Go back speaks for the right round and no other.
let activeRound: { id: number; kind: "quit" | "update" } | null = null;
// The round whose exit this window is waiting to see through: the one that
// proceeded last. A retraction for it drops the claimed intent.
let proceededRound: number | null = null;
// The exit request the last round's arrival became. An install started
// here at `request - 1` is still current when the only thing that happened
// since is its own round asking, whether or not that round has proceeded.
let roundRequest: { request: number; kind: "quit" | "update" } | null = null;

function isOwnRoundRequest(request: number): boolean {
  return (
    roundRequest !== null &&
    roundRequest.kind === "update" &&
    roundRequest.request === request + 1 &&
    exitRequest === roundRequest.request
  );
}

function answerRound(roundId: number, decision: "clear" | "hold" | "cancel"): void {
  void bridge().answerExitRound({ roundId, decision }).catch(() => undefined);
}

// The round ended without the exit happening: refused or failed staging,
// or a cancellation. Every window drops the intent it claimed for that
// round, and only that; a reload or a newer action keeps its label.
function forgetRoundIntent(roundId: number): boolean {
  const owned = activeRound?.id === roundId || proceededRound === roundId;
  if (!owned) return false;
  if (activeRound?.id === roundId) activeRound = null;
  if (proceededRound === roundId) proceededRound = null;
  if (pendingUnload?.kind === "update" || pendingUnload?.kind === "quit") {
    pendingUnload = null;
  }
  return true;
}

export function requestGuardedReload(): void {
  exitRequest += 1;
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

// Decide before the destructive call: electron-updater's
// quitAndInstall is ONE-SHOT — calling it and then vetoing the quit would
// burn the latch, and no "Restart anyway" could ever restart. So the drafts
// are checked first: on a clear path the install runs at once (main
// pre-approves the quit it starts), and on a blocked path the dialog opens
// instead of the install, whose confirm makes the one and only call.
// Returns null when the dialog took over — the caller's own flow ends there.
export async function requestGuardedUpdateInstall(): Promise<UpdateActionResult | null> {
  const request = ++exitRequest;
  if (hasUnsettledWrites() && !(await settleWritesForExit())) {
    return null;
  }
  if (request !== exitRequest) return null;
  if (atRiskOrphanedDraftIds().length === 0 || openRecoveryWarning === null) {
    const result = await beginInstall();
    // The install's own round asks this window too, and that ask is part
    // of this request, not a newer action. Only an action from outside the
    // round makes the result stale.
    if (request !== exitRequest && !isOwnRoundRequest(request)) return null;
    if (!result.accepted && hasUnsettledWrites()) return null;
    // Another window's recovery dialog went back, or this one's did: a
    // decision the user already made, not an install failure. The callers'
    // own flow ends here with nothing to report.
    if (result.cancelled) return null;
    // Main's boundary re-check refuses the install when a reopen set an edit
    // aside after this renderer's own check. That refusal
    // is a recovery decision, not an install failure, and the direct branch
    // used to report it as one — the user's Restart click became a generic
    // error and the drafts were never mentioned. The
    // dialog path already re-prompts; both paths reach the same state, so
    // both must say the same thing.
    if (
      !result.accepted &&
      atRiskOrphanedDraftIds().length > 0 &&
      openRecoveryWarning !== null
    ) {
      openRecoveryWarning({ kind: "update", resume: resumeInstall });
      return null;
    }
    return result;
  }
  openRecoveryWarning({ kind: "update", resume: resumeInstall });
  return null;
}

const resumeInstall = () =>
  beginInstall().then((result) => result.accepted, () => false);

// Resumes an exit main has already approved, re-claiming the intent each
// attempt so a draft captured before this attempt's unload still produces a
// warning that names the right action.
function resumeExit(kind: "update" | "quit"): Promise<boolean> {
  pendingUnload = { kind, resume: () => resumeExit(kind) };
  return bridge()
    .resumeQuit()
    .then(
      () => true,
      () => false,
    );
}

// Resumes an intent a round claimed. While that round is still being
// decided, "resume" means answering it again: this window is clear, and
// main proceeds only once every window is. Resuming the quit directly would
// skip a window still holding its warning, and for an update it would quit
// before the install was ever staged. Only after the round proceeded is the
// exit main's to finish, through the approved quit.
function resumeRoundIntent(
  round: { id: number; kind: "update" | "quit" },
  reclaim: () => void,
): Promise<boolean> {
  if (activeRound?.id === round.id) {
    reclaim();
    answerRound(round.id, "clear");
    return Promise.resolve(true);
  }
  if (proceededRound === round.id) return resumeExit(round.kind);
  // The round ended without the exit: nothing to resume.
  return Promise.resolve(false);
}

function hasUnsettledWrites(): boolean {
  return hasPendingEditorDrafts() || hasPendingCollectionFieldWrites() || collectionWriteFailures().length > 0;
}

async function settleWritesForExit(): Promise<boolean> {
  if (!(await settlePendingEditorDrafts())) return false;
  const settled = await settleCollectionFieldWrites(undefined, {
    stallMs: COLLECTION_WRITE_STALL_MS,
  });
  if (settled.stalled) {
    abandonPendingCollectionFieldWrites(
      "dohc could not finish saving this change. Retry it before closing, or discard the unsaved change.",
    );
  }
  return !settled.stalled && settled.failed === 0;
}

// One drain serves every unload attempt it overlaps: a second beforeunload
// while writes are still landing hands its intent to the drain in flight
// instead of racing a second resume against the first.
let pendingWritesDrain: { pending: PendingUnload | null; request: number } | null = null;

function holdUnloadForWrites(pending: PendingUnload | null): void {
  if (pendingWritesDrain) {
    pendingWritesDrain.pending = pending;
    pendingWritesDrain.request = exitRequest;
    return;
  }
  const drain = { pending, request: exitRequest };
  pendingWritesDrain = drain;
  void (async () => {
    const settled = await settleWritesForExit();
    if (pendingWritesDrain !== drain) return;
    pendingWritesDrain = null;
    if (drain.request !== exitRequest) return;
    if (!settled) {
      drain.pending?.failed?.();
      return;
    }
    const claimed = drain.pending;
    if (claimed) pendingUnload = claimed;
    const resume =
      claimed?.resume ??
      (() => {
        window.close();
        return Promise.resolve(true);
      });
    void resume().then((unloading) => {
      // A resume that failed without unloading must not label a later,
      // unrelated close (`requestGuardedReload` precedent).
      if (!unloading && claimed && pendingUnload === claimed) {
        pendingUnload = null;
      }
    });
  })();
}

// Test seam: this module's state is deliberately app-run scoped, so suites
// reset it between tests instead of leaking an unclaimed intent into the next
// one.
export function resetGuardedExits(): void {
  exitRequest += 1;
  pendingUnload = null;
  pendingWritesDrain = null;
  activeRound = null;
  proceededRound = null;
  roundRequest = null;
}

// The install's own exit runs through beforeunload like any other unload, and
// a draft captured between the recovery check and that exit blocks it there.
// The warning must then name what the user was actually
// doing — a restart, not a close — so the intent is claimed before the call.
//
// The resume is the quit, never a second install: quitAndInstall's latch is
// one-shot and already spent by the time beforeunload can fire, and main has
// pre-approved the quit it started. A plain window.close() would also strand
// the staged installer on macOS, where closing a window does not quit.
async function beginInstall(): Promise<UpdateActionResult> {
  const request = exitRequest;
  for (;;) {
    const result = await attemptInstall();
    if (result.accepted || !hasUnsettledWrites()) return result;
    if (request !== exitRequest) return result;
    // Main can observe an edit accepted after the renderer's first drain.
    // A refused install has not consumed the updater's one-shot latch.
    if (!(await settleWritesForExit()) || request !== exitRequest) return result;
  }
}

function attemptInstall(): Promise<UpdateActionResult> {
  const attempt: PendingUnload = {
    kind: "update",
    resume: () => resumeExit("update"),
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
// Set-aside drafts are persisted on capture and restored on launch,
// so most of them now survive closing, reloading, quitting, and
// restarting into an update. What cannot be persisted still dies with the app
// run — a secret-classified path never enters plaintext storage, and a
// storage refusal leaves the text in memory — and destroying that text is
// irreversible, so it must be announced before it runs (product invariant).
// Electron cancels a close silently on preventDefault, so the dialog below is
// the announcement, and it carries the at-risk drafts with their own
// Copy/Dismiss: the warning must offer the very actions it demands (#579
// review, r5).
//
// This mounts above AppErrorBoundary (see main.tsx): a crash unmounts the
// shell, and the crash screen's "Reload dohc" must not destroy the drafts
// unannounced. The store already lives outside React, so this guard needs
// nothing from the crashed tree.
export function RecoveryCloseGuard(props: { children: ReactNode }) {
  const [closeWarning, setCloseWarning] = useState<{
    // What the user asked for — the confirm button resumes exactly it.
    kind: UnloadKind;
    resume: (() => Promise<boolean>) | null;
    // The exit round this dialog answers for, when main is waiting on it.
    round?: number;
  } | null>(null);
  // Live, not a snapshot: the dialog embeds Copy/Dismiss,
  // so the count must follow every dismissal, and an emptied dialog has
  // nothing left to warn about. Only the drafts an exit would destroy belong
  // here — a restored draft comes back on its own.
  const allDrafts = useAllOrphanedDrafts();
  const liveDrafts = useMemo(
    () => allDrafts.filter((row) => !row.persisted),
    [allDrafts],
  );
  const liveCount = liveDrafts.length;
  const warningOpen = closeWarning !== null;
  const warningVisible = warningOpen && liveCount > 0;
  const warningRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const showCloseWarning = (warning: {
    kind: UnloadKind;
    resume: (() => Promise<boolean>) | null;
    round?: number;
  }) => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      !warningRef.current?.contains(active)
    ) {
      returnFocusRef.current = active;
    }
    setCloseWarning(warning);
  };
  useEffect(() => {
    if (!warningOpen || liveCount !== 0) return;
    // The last at-risk draft was resolved from the dialog: nothing left to
    // warn about. A dialog that was answering a round still owes main an
    // answer, or the install it holds never settles. Clear it now that the
    // drafts are gone, unless a collection write is still landing.
    const round = closeWarning?.round;
    setCloseWarning(null);
    if (round !== undefined && activeRound?.id === round) {
      answerRound(round, hasUnsettledWrites() ? "cancel" : "clear");
    }
    // closeWarning is read once, at the moment the count reaches zero.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warningOpen, liveCount]);
  useEffect(() => {
    if (!warningVisible) return;
    return () => {
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected) returnTarget.focus();
      returnFocusRef.current = null;
    };
  }, [warningVisible]);
  const bypassRearmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The drafts the warning listed when the user confirmed. An approval covers
  // exactly those — never a draft a queued reopen
  // sets aside afterwards, which the user was never shown. Every gate below
  // measures the live store against this set, so a new draft stops the exit
  // and comes back to the dialog with its text intact. The approval IS the
  // bypass: an empty set gates nothing, so there is no separate flag to keep
  // in step with it.
  const approvedDraftIds = useRef<ReadonlySet<number>>(new Set());
  const hasUnapprovedDrafts = () =>
    atRiskOrphanedDraftIds().some((id) => !approvedDraftIds.current.has(id));
  const rearmGuard = () => {
    approvedDraftIds.current = new Set();
    if (bypassRearmTimer.current) {
      clearTimeout(bypassRearmTimer.current);
      bypassRearmTimer.current = null;
    }
  };
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      exitRequest += 1;
      // Consumed either way: if this unload proceeds the slot dies with the
      // page, and if it is blocked the dialog now owns the answer.
      const pending = pendingUnload;
      pendingUnload = null;
      if (hasUnsettledWrites()) {
        // An accepted collection cell edit has not reached its record yet.
        // Stop the unload, land the queue, then rerun EXACTLY the requested
        // action — whose own beforeunload re-checks the drafts. The draft
        // approval is NOT consumed here: this is the same attempt, resumed.
        event.preventDefault();
        void bridge().holdQuit();
        holdUnloadForWrites(pending);
        return;
      }
      if (!hasUnapprovedDrafts()) {
        // One-shot: an approval is consumed by the unload it
        // permits — never a later, unrelated close.
        rearmGuard();
        return;
      }
      // Past this line the store holds a draft the user never saw. The earlier
      // approval does not cover it, so the exit stops and asks again with the
      // full list.
      rearmGuard();
      event.preventDefault();
      // Tell main the exit it approved is not happening.
      // An update install pre-approves the quit before this veto is possible,
      // and an approval that outlives its quit makes the next Cmd+Q skip the
      // ask entirely — arriving here with no pending intent and warning about
      // a "close". Confirming that would call window.close(), which does not
      // quit on macOS.
      void bridge().holdQuit();
      showCloseWarning({
        kind: pending?.kind ?? "close",
        resume: pending?.resume ?? null,
      });
    };
    // Required contract, called directly. The bridge and the preload carry
    // this listener together, so an optional call would define a second
    // supported preload — one where the renderer silently drops exit
    // handling instead of showing the mismatched build.
    //
    // Main asks every workspace window before a quit or an update install.
    // The answer is read at answer time: an edit set aside after this
    // renderer's own check still blocks. It is the live store measured
    // against what the user approved, never a blanket "the user already
    // confirmed": a draft captured after the confirm was in no warning, and
    // quitAndInstall is the last chance to stop.
    //
    // Answer promptly — clear when nothing is at stake, hold when the dialog
    // takes over — so main's hung-renderer fail-safe never fires for a live
    // renderer. A window that is not the one that asked for the restart
    // still gets its own dialog, whose confirm clears its part of the round
    // and whose Go back cancels the whole round.
    const unsubscribeExitRound = bridge().onExitRound((message) => {
      if (message.kind === "proceed") {
        // The exit is on its way: the claimed intent stays for its unload,
        // and a retraction for this round can still take it back.
        if (activeRound?.id === message.roundId) {
          activeRound = null;
          proceededRound = message.roundId;
        }
        return;
      }
      if (message.kind !== "request") {
        // The round ended without the exit: cancelled by a window, refused
        // or failed at the updater. A dialog still open for it has nothing
        // left to decide, the approval it granted is off, and the intent
        // claimed for it must not label a later, unrelated close.
        if (!forgetRoundIntent(message.roundId)) return;
        rearmGuard();
        setCloseWarning((current) =>
          current?.round === message.roundId ? null : current,
        );
        return;
      }
      exitRequest += 1;
      roundRequest = { request: exitRequest, kind: message.exit };
      const round = { id: message.roundId, kind: message.exit };
      activeRound = round;
      proceededRound = null;
      // Claim the intent up front: a queued reopen can still capture a
      // draft between a clear answer and the exit's own beforeunload, and
      // the warning that blocks it there must resume the QUIT or RESTART.
      // Falling back to window.close() would leave the process running on
      // macOS, and with agent dispatch still alive. The intent keeps its
      // round: resuming it re-answers the round until main proceeds.
      const intent: PendingUnload = {
        kind: round.kind,
        resume: () => resumeRoundIntent(round, () => { pendingUnload = intent; }),
      };
      const resume = intent.resume;
      pendingUnload = intent;
      if (hasUnsettledWrites()) {
        answerRound(round.id, "hold");
        void bridge().holdQuit();
        holdUnloadForWrites({
          kind: round.kind,
          // The drain lands, then answers this round — if it is still the
          // one main is waiting on. A cancelled or superseded round is not
          // answered; a newer one asks again on its own.
          resume: () => {
            if (activeRound?.id !== round.id) return Promise.resolve(false);
            pendingUnload = intent;
            if (hasUnapprovedDrafts()) {
              showCloseWarning({ kind: round.kind, resume, round: round.id });
              return Promise.resolve(false);
            }
            answerRound(round.id, "clear");
            return Promise.resolve(true);
          },
          // The write could not land: there is no exit to hold for, and no
          // dialog to say so. The round is cancelled so the install settles
          // and the failure notice keeps the person's input. The approval
          // an earlier local warning granted is off too: the person is
          // staying, and main's broadcast will not reach a window that
          // already forgot the round.
          failed: () => {
            if (activeRound?.id !== round.id) return;
            answerRound(round.id, "cancel");
            forgetRoundIntent(round.id);
            rearmGuard();
          },
        });
        return;
      }
      if (!hasUnapprovedDrafts()) {
        answerRound(round.id, "clear");
        return;
      }
      answerRound(round.id, "hold");
      void bridge().holdQuit();
      showCloseWarning({ kind: round.kind, resume, round: round.id });
    });
    // Registered last, so a preload that fails the contract above leaves no
    // listener and no opener behind — a half-installed guard is worse than
    // none, because the cleanup React skips would never remove it.
    window.addEventListener("beforeunload", onBeforeUnload);
    openRecoveryWarning = showCloseWarning;
    return () => {
      openRecoveryWarning = null;
      window.removeEventListener("beforeunload", onBeforeUnload);
      unsubscribeExitRound();
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
        <Overlay
          appearance="warning"
          panelRef={warningRef}
          panelProps={{
            "data-testid": "recovery-close-warning",
            role: "dialog",
            "aria-modal": "true",
            "aria-labelledby": "recovery-close-warning-title",
            className: "dohc-elevated w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5",
          }}
        >
            <h3
              id="recovery-close-warning-title"
              className="m-0 text-sm font-semibold text-ink"
            >
              {UNLOAD_COPY[closeWarning.kind].title}{" "}
              without your set-aside {liveCount === 1 ? "edit" : "edits"}?
            </h3>
            <p className="mb-0 mt-2 text-xs leading-5 text-muted">
              {`${liveCount} set-aside ${
                liveCount === 1 ? "edit is" : "edits are"
              } lost when dohc ${UNLOAD_COPY[closeWarning.kind].verb}.`}{" "}
              Copy {liveCount === 1 ? "it" : "them"} here to keep the text.
            </p>
            <div className="mt-3 max-h-60 overflow-y-auto">
              <RecoveryList rows={liveDrafts} showWorkspace />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-testid="recovery-close-goback"
                autoFocus
                onClick={() => {
                  // Going back on a round cancels it for every window: the
                  // originating install settles, and no other window's
                  // dialog keeps asking about an exit that is off. The
                  // approval an earlier local warning granted is off too:
                  // the person is staying, so the next close asks over the
                  // full list.
                  const round = closeWarning.round;
                  setCloseWarning(null);
                  if (round !== undefined && activeRound?.id === round) {
                    rearmGuard();
                    forgetRoundIntent(round);
                    answerRound(round, "cancel");
                  }
                }}
                className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
              >
                Go back
              </button>
              <button
                type="button"
                data-testid="recovery-close-anyway"
                onClick={() => {
                  // Resume exactly what the user asked for: a requested
                  // reload, restart, or quit must not become a plain exit.
                  const kind = closeWarning.kind;
                  const round = closeWarning.round;
                  const resume =
                    closeWarning.resume ??
                    (() => {
                      window.close();
                      return Promise.resolve(true);
                    });
                  setCloseWarning(null);
                  // The approval is scoped to this attempt:
                  // consumed by the unload it permits, cleared on an explicit
                  // failure signal, and cleared by the fail-safe timer when no
                  // signal exists — a resumed action that never unloads must
                  // not leave a later close unguarded.
                  //
                  // It is scoped to THIS LIST too: the user
                  // approved losing the drafts the dialog just showed, and a
                  // reopen queued behind this click can still set one more
                  // aside. That draft keeps its notice and its Copy button,
                  // and the gates below refuse to exit over it.
                  approvedDraftIds.current = new Set(
                    liveDrafts.map((row) => row.draft.id),
                  );
                  if (bypassRearmTimer.current) {
                    clearTimeout(bypassRearmTimer.current);
                  }
                  bypassRearmTimer.current = setTimeout(
                    rearmGuard,
                    BYPASS_REARM_MS,
                  );
                  // A dialog answering a pending round clears this window's
                  // part of it. Main proceeds only when every window is
                  // clear; the exit itself then comes back through the
                  // approved quit, or the original install, so nothing is
                  // resumed here.
                  if (round !== undefined && activeRound?.id === round) {
                    pendingUnload = { kind: activeRound.kind, resume };
                    answerRound(round, "clear");
                    return;
                  }
                  const request = exitRequest;
                  void resume().then((unloading) => {
                    if (unloading || request !== exitRequest) return;
                    // The action did not unload. When a draft this approval
                    // never covered is why — the boundary re-check refuses an
                    // install for it — the user gets the decision back, now
                    // over the full list. Any other
                    // failure (an updater that is not ready) re-arms in
                    // silence, exactly as before: nothing new is at stake.
                    const uncovered = hasUnapprovedDrafts();
                    rearmGuard();
                    if (uncovered) showCloseWarning({ kind, resume });
                  });
                }}
                className="h-8 cursor-pointer rounded-md bg-accent px-3 text-xs font-semibold text-bg hover:opacity-90"
              >
                {UNLOAD_COPY[closeWarning.kind].confirm}
              </button>
            </div>
        </Overlay>
      ) : null}
    </>
  );
}
