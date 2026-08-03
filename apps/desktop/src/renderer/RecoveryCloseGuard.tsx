import { useEffect, useRef, useState, type ReactNode } from "react";
import { bridge } from "./bridge";
import { orphanedDraftCount } from "./orphanedDrafts";
import { RecoveryList } from "./RecoveryList";

// The guard cannot tell a reload's beforeunload from a close's, but the user
// asked for one of them by name — confirming must resume THAT action, never
// swap a requested reload for an exit (#579 review, r7). In-app reload
// triggers route through here so the guard knows what it blocked.
let pendingReload = false;
export function requestGuardedReload(): void {
  pendingReload = true;
  void bridge().reloadRenderer();
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
    action: "close" | "reload";
  } | null>(null);
  const bypassCloseGuard = useRef(false);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Consumed either way: if this unload proceeds the flag dies with the
      // page, and if it is blocked the dialog now owns the answer.
      const action = pendingReload ? ("reload" as const) : ("close" as const);
      pendingReload = false;
      if (bypassCloseGuard.current) return;
      const count = orphanedDraftCount();
      if (count === 0) return;
      event.preventDefault();
      setCloseWarning({ count, action });
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
              {closeWarning.action === "reload" ? "Reload" : "Close"} without
              your set-aside {closeWarning.count === 1 ? "edit" : "edits"}?
            </h3>
            <p className="mb-0 mt-2 text-xs leading-5 text-muted">
              {`${closeWarning.count} set-aside ${
                closeWarning.count === 1 ? "edit is" : "edits are"
              } lost when dohc ${
                closeWarning.action === "reload" ? "reloads" : "closes"
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
                  const action = closeWarning.action;
                  bypassCloseGuard.current = true;
                  setCloseWarning(null);
                  // Resume exactly what the user asked for: a requested
                  // reload must not become an exit (#579 review, r7).
                  if (action === "reload") void bridge().reloadRenderer();
                  else window.close();
                }}
                className="h-8 cursor-pointer rounded-md bg-accent px-3 text-xs font-semibold text-bg hover:opacity-90"
              >
                {closeWarning.action === "reload"
                  ? "Reload anyway"
                  : "Close anyway"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
