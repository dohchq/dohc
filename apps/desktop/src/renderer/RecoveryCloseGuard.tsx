import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UpdateActionResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { orphanedDraftCount } from "./orphanedDrafts";
import { RecoveryList } from "./RecoveryList";

// The guard cannot tell one unload's beforeunload from another's, but the
// user asked for a specific action by name — confirming must resume THAT
// action, never swap a requested reload or update-restart for a plain exit
// (#579 review, r7 + r8). Every in-app unload trigger routes through here so
// the guard knows what it blocked: one slot, consumed by the next
// beforeunload, cleared when the request itself fails without unloading.
type PendingUnload = {
  kind: "reload" | "update";
  resume: () => void;
};
let pendingUnload: PendingUnload | null = null;

export function requestGuardedReload(): void {
  const attempt: PendingUnload = {
    kind: "reload",
    resume: () => void bridge().reloadRenderer(),
  };
  pendingUnload = attempt;
  void bridge()
    .reloadRenderer()
    .catch(() => {
      if (pendingUnload === attempt) pendingUnload = null;
    });
}

// The update install returns a result its callers surface (error copy, retry
// affordances); the guard only records how to RETRY the restart. A request
// main refuses never unloads, so the slot is cleared instead of mislabeling
// the user's next plain close as an update restart.
export async function requestGuardedUpdateInstall(): Promise<UpdateActionResult> {
  const attempt: PendingUnload = {
    kind: "update",
    resume: () => void bridge().installUpdate(),
  };
  pendingUnload = attempt;
  try {
    const result = await bridge().installUpdate();
    if (!result.accepted || result.state.status === "error") {
      if (pendingUnload === attempt) pendingUnload = null;
    }
    return result;
  } catch (error) {
    if (pendingUnload === attempt) pendingUnload = null;
    throw error;
  }
}

// Set-aside drafts (#567) live in renderer memory only, so closing or
// reloading this window is the one exit that destroys them — and an
// irreversible change must be announced before it runs (product invariant).
// Electron cancels the close SILENTLY on preventDefault, so the dialog below
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
    count: number;
    // What the user asked for — the confirm button resumes exactly it.
    kind: "close" | "reload" | "update";
    resume: (() => void) | null;
  } | null>(null);
  const bypassCloseGuard = useRef(false);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Consumed either way: if this unload proceeds the slot dies with the
      // page, and if it is blocked the dialog now owns the answer.
      const pending = pendingUnload;
      pendingUnload = null;
      if (bypassCloseGuard.current) return;
      const count = orphanedDraftCount();
      if (count === 0) return;
      event.preventDefault();
      setCloseWarning({
        count,
        kind: pending?.kind ?? "close",
        resume: pending?.resume ?? null,
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
  return (
    <>
      {props.children}
      {closeWarning !== null ? (
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
                  : "Close"}{" "}
              without your set-aside{" "}
              {closeWarning.count === 1 ? "edit" : "edits"}?
            </h3>
            <p className="mb-0 mt-2 text-xs leading-5 text-muted">
              {`${closeWarning.count} set-aside ${
                closeWarning.count === 1 ? "edit is" : "edits are"
              } lost when dohc ${
                closeWarning.kind === "reload"
                  ? "reloads"
                  : closeWarning.kind === "update"
                    ? "restarts"
                    : "closes"
              }.`}{" "}
              Copy {closeWarning.count === 1 ? "it" : "them"} here to keep the
              text.
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
                  const resume = closeWarning.resume;
                  bypassCloseGuard.current = true;
                  setCloseWarning(null);
                  // Resume exactly what the user asked for: a requested
                  // reload or update restart must not become a plain exit
                  // (#579 review, r7 + r8).
                  if (resume) resume();
                  else window.close();
                }}
                className="h-8 cursor-pointer rounded-md bg-accent px-3 text-xs font-semibold text-bg hover:opacity-90"
              >
                {closeWarning.kind === "reload"
                  ? "Reload anyway"
                  : closeWarning.kind === "update"
                    ? "Restart anyway"
                    : "Close anyway"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
