import { Bot, Check, ChevronDown, FileArchive, FileText, Layers, Lock, RefreshCw, Share2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ResolveWorkspaceVersionConflictResult,
  WorkspaceVersionConflict,
  WorkspaceVersionFileChange,
  WorkspaceVersionRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { SectionLabel } from "../ui/controls";
import {
  CONFLICT_COMBINED_EDIT_MAX_BYTES,
  applyCombinedChange,
  conflictPreview,
  exceedsUtf8Bytes,
  utf8ByteLength,
} from "./conflictPane";
import { UnifiedDiffLines, buildUnifiedDiffLines, computeTextDiff } from "./unifiedDiff";

// Named versions surface (PR 0M-4, workspace-engine alpha). Product
// vocabulary only: Version, Main, compare, merge, keep — never git terms.
// The whole surface is flag-gated by the shell (unflagged workspaces never
// mount it), and every async response is gated by a liveness token before it
// touches state (plan-level non-negotiable: a slow response for one
// workspace must never repaint another).

export interface WorkspaceVersionsSnapshot {
  versions: WorkspaceVersionRecord[];
  activeVersionId: string;
}

// Electron wraps handler rejections as
// "Error invoking remote method 'channel': Error: <real message>" — show the
// real message, or the fallback when there is none. Shared with the
// try-in-version surfaces (TryInVersion.tsx).
export function ipcErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  const message = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  return message.trim().length > 0 ? message.trim() : fallback;
}

function versionName(
  snapshot: WorkspaceVersionsSnapshot | null,
  versionId: string | null,
): string {
  if (!versionId) return "Main";
  return (
    snapshot?.versions.find((version) => version.id === versionId)?.name ?? "Main"
  );
}

const MENU_ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted hover:bg-line/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

// Compact version selector for the editor chrome: shows the active version,
// switches on click, creates inline, and opens compare / merge.
export function VersionMenu(props: {
  workspaceId: string;
  activeTabDirty: boolean;
  flushActiveDraft: () => Promise<void>;
  onOpenCompare: (versionId: string) => void;
  // Fired after any operation that may have changed disk or history state so
  // the shell refreshes files/history and reloads open editors.
  // Pass the version that is active NOW when this operation set it. The
  // shell needs the boundary before it can judge answers still in flight,
  // and a lookup it has to await is a window those answers slip through.
  // Omit it only when the operation did not change the active version, or
  // when it failed and nobody knows what stuck.
  onWorkspaceStateChanged: (activeVersionId?: string) => void;
  onError: (message: string) => void;
  // Bumped by the shell when ANOTHER surface switched versions (PR 0N-2's
  // review card switches back to Main) so the selector re-reads the active
  // version instead of showing a stale name.
  refreshKey?: number;
  // "Share this version…" (PR 18): present only when the shell can open the
  // share dialog (synced, non-shared-view workspaces).
  onShareVersion?: (version: { id: string; name: string }) => void;
}) {
  const { workspaceId } = props;
  const [snapshot, setSnapshot] = useState<WorkspaceVersionsSnapshot | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"switch" | "create" | null>(null);
  // Dirty-editor guard: the version id waiting on "Save and switch".
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [mergeSource, setMergeSource] = useState<WorkspaceVersionRecord | null>(null);
  // "Try it in a version" (PR 0N-2): the task prompt dialog.
  const [tryOpen, setTryOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Two questions, and they are not the same one.
  //
  // May THIS read still write the snapshot? A newer read answers no — from a
  // re-key, an unmount, or a mutation about to change what the read describes.
  const snapshotToken = useRef(0);
  // Is THIS mutation still the one running? Only another mutation or an
  // unmount answers no. A re-key must NOT: the announcement that a switch
  // succeeded is itself what re-keys this component, so a shared counter let
  // the switch invalidate its own token — its finally then skipped, and the
  // selector sat disabled on "Switching…" for the rest of the session.
  const operationToken = useRef(0);
  useEffect(
    () => () => {
      operationToken.current += 1;
    },
    [],
  );
  // A mutation supersedes both: it is the running operation now, and any read
  // issued before it describes the world it is about to change.
  const beginOperation = useCallback(() => {
    snapshotToken.current += 1;
    return ++operationToken.current;
  }, []);

  const refresh = useCallback(async () => {
    const token = snapshotToken.current;
    const result = await bridge().listWorkspaceVersions({ workspaceId });
    if (token !== snapshotToken.current) return null;
    setSnapshot(result);
    return result;
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    // The first load can race the workspace open; retry briefly instead of
    // leaving the selector missing for the session.
    void (async () => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
        try {
          await refresh();
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
        }
      }
      // Every attempt failed: say so instead of silently dropping the whole
      // versions surface for the session.
      if (!cancelled) {
        props.onError(
          ipcErrorMessage(lastError, "Version controls are unavailable right now."),
        );
      }
    })();
    return () => {
      cancelled = true;
      snapshotToken.current += 1;
    };
  }, [refresh, props.refreshKey]);

  const active = useMemo(
    () =>
      snapshot?.versions.find((version) => version.id === snapshot.activeVersionId) ??
      null,
    [snapshot],
  );
  const onMain = (active?.kind ?? "main") === "main";

  const closeMenu = useCallback((refocus = true) => {
    setMenuOpen(false);
    setNewName(null);
    setInlineError(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const performSwitch = useCallback(
    async (versionId: string) => {
      const token = beginOperation();
      setBusy("switch");
      setInlineError(null);
      try {
        await props.flushActiveDraft();
        // Re-check liveness after EVERY awaited step: the flush (or the
        // switch) may resolve after this panel was unmounted or superseded,
        // and a stale continuation must not mutate or repaint.
        if (token !== operationToken.current) return;
        await bridge().switchWorkspaceVersion({ workspaceId, versionId });
        if (token !== operationToken.current) return;
        // The switch succeeded, so this IS the active version now — say so
        // before awaiting anything else. Main notifies the renderer BEFORE
        // this invoke returns, so a history refresh for the old version can
        // already be in flight, and every await between here and the
        // announcement is a window it can answer in.
        props.onWorkspaceStateChanged(versionId);
        await refresh();
      } catch (error) {
        if (token !== operationToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not switch versions."));
        // The switch may have partially applied before failing; make the
        // selector and editors reflect reality. Whatever stuck is what the
        // re-read reports, and if that read fails too, nobody knows.
        const recovered = await refresh().catch(() => null);
        if (token !== operationToken.current) return;
        props.onWorkspaceStateChanged(recovered?.activeVersionId);
      } finally {
        if (token === operationToken.current) setBusy(null);
      }
    },
    [beginOperation, props, refresh, workspaceId],
  );

  const requestSwitch = useCallback(
    (versionId: string) => {
      if (versionId === snapshot?.activeVersionId) {
        closeMenu();
        return;
      }
      closeMenu(false);
      if (props.activeTabDirty) {
        // Save-first prompt: switching always saves into the CURRENT version
        // first, and the user should know that before it happens.
        setPendingSwitch(versionId);
        return;
      }
      void performSwitch(versionId);
    },
    [closeMenu, performSwitch, props.activeTabDirty, snapshot?.activeVersionId],
  );

  const performCreate = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        setInlineError("Give the new version a name.");
        return;
      }
      const token = beginOperation();
      setBusy("create");
      setInlineError(null);
      try {
        await props.flushActiveDraft();
        if (token !== operationToken.current) return;
        const result = await bridge().createWorkspaceVersion({
          workspaceId,
          name: trimmed,
        });
        if (token !== operationToken.current) return;
        setSnapshot(result);
        // Create-and-switch: the new version is the active one.
        props.onWorkspaceStateChanged(result.activeVersionId);
        closeMenu();
      } catch (error) {
        if (token !== operationToken.current) return;
        setInlineError(ipcErrorMessage(error, "Could not create that version."));
      } finally {
        if (token === operationToken.current) setBusy(null);
      }
    },
    [beginOperation, closeMenu, props, workspaceId],
  );

  // Keyboard-navigable menu: arrows move focus, Home/End jump, Escape closes
  // and returns focus to the trigger.
  const onMenuKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const menu = menuRef.current;
      if (!menu) return;
      const items = Array.from(
        menu.querySelectorAll<HTMLElement>(
          "[role^='menuitem']:not([aria-disabled='true']), input",
        ),
      );
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (current + 1) % items.length
              : (current - 1 + items.length) % items.length;
      items[next]?.focus();
    },
    [closeMenu],
  );

  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLElement>("[role^='menuitem']");
    first?.focus();
  }, [menuOpen]);

  if (!snapshot) return null;

  const activeName = active?.name ?? "Main";
  const namedVersions = snapshot.versions;

  return (
    <div className="relative flex items-center">
      <button
        ref={triggerRef}
        type="button"
        data-testid="version-menu-button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Version: ${activeName}${onMain ? "" : " (not Main)"}`}
        title={`You're working in the ${activeName} version`}
        disabled={busy !== null}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
        className="flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-line/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60"
      >
        <Layers size={13} aria-hidden className="shrink-0" />
        <span data-testid="version-menu-active" className="min-w-0 truncate">
          {busy === "switch" ? "Switching…" : activeName}
        </span>
        {!onMain ? (
          <span
            data-testid="version-menu-dot"
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
        ) : null}
        <ChevronDown size={12} aria-hidden className="shrink-0 text-subtle" />
      </button>

      {menuOpen ? (
        <>
          <div className="fixed inset-0 z-20" onClick={() => closeMenu(false)} />
          <div
            ref={menuRef}
            role="menu"
            aria-label="Versions"
            data-testid="version-menu"
            onKeyDown={onMenuKeyDown}
            className="dohc-popover dohc-pop-in absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-line bg-panel p-1"
          >
            <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              Versions
            </div>
            {namedVersions.map((version) => {
              const isActive = version.id === snapshot.activeVersionId;
              return (
                <button
                  key={version.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  data-testid="version-item"
                  data-version-id={version.id}
                  data-version-name={version.name}
                  data-active={isActive || undefined}
                  onClick={() => requestSwitch(version.id)}
                  className={MENU_ITEM_CLASS}
                >
                  <span className="grid w-4 shrink-0 place-items-center">
                    {isActive ? (
                      <Check size={13} aria-hidden className="text-accent" />
                    ) : null}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      isActive ? "text-ink" : ""
                    }`}
                  >
                    {version.name}
                  </span>
                </button>
              );
            })}

            <div className="mx-1 my-1 border-t border-line" aria-hidden />

            <button
              type="button"
              role="menuitem"
              data-testid="version-try"
              onClick={() => {
                closeMenu(false);
                setTryOpen(true);
              }}
              className={MENU_ITEM_CLASS}
            >
              <span className="grid w-4 shrink-0 place-items-center">
                <Bot size={13} aria-hidden />
              </span>
              Try in a version…
            </button>

            {props.onShareVersion ? (
              <button
                type="button"
                role="menuitem"
                data-testid="version-share"
                onClick={() => {
                  closeMenu(false);
                  props.onShareVersion?.({
                    id: active?.id ?? "main",
                    name: activeName,
                  });
                }}
                className={MENU_ITEM_CLASS}
              >
                <span className="grid w-4 shrink-0 place-items-center">
                  <Share2 size={13} aria-hidden />
                </span>
                Share this version…
              </button>
            ) : null}

            {newName === null ? (
              <button
                type="button"
                role="menuitem"
                data-testid="version-new"
                onClick={() => {
                  setInlineError(null);
                  setNewName("");
                }}
                className={MENU_ITEM_CLASS}
              >
                <span className="w-4 shrink-0" aria-hidden />
                New version…
              </button>
            ) : (
              <form
                className="px-2 py-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void performCreate(newName);
                }}
              >
                <label className="sr-only" htmlFor="version-new-name">
                  New version name
                </label>
                <input
                  id="version-new-name"
                  data-testid="version-new-input"
                  autoFocus
                  value={newName}
                  disabled={busy === "create"}
                  maxLength={80}
                  placeholder="Version name"
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setNewName(null);
                      setInlineError(null);
                    }
                  }}
                  className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
                />
                <p className="mb-0 mt-1 text-[11px] leading-4 text-subtle">
                  {busy === "create"
                    ? "Creating…"
                    : "Press Enter to create and start working in it."}
                </p>
              </form>
            )}

            {!onMain && active ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="version-compare"
                  onClick={() => {
                    closeMenu(false);
                    props.onOpenCompare(active.id);
                  }}
                  className={MENU_ITEM_CLASS}
                >
                  <span className="w-4 shrink-0" aria-hidden />
                  Compare with Main
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="version-merge"
                  aria-disabled={!active.canMergeIntoMain}
                  disabled={!active.canMergeIntoMain}
                  title={
                    active.canMergeIntoMain
                      ? `Bring everything from ${active.name} into Main`
                      : "This version was created inside another version, so it can't merge straight into Main yet."
                  }
                  onClick={() => {
                    if (!active.canMergeIntoMain) return;
                    closeMenu(false);
                    setMergeSource(active);
                  }}
                  className={MENU_ITEM_CLASS}
                >
                  <span className="w-4 shrink-0" aria-hidden />
                  Merge into Main…
                </button>
              </>
            ) : null}

            {inlineError ? (
              <p
                data-testid="version-menu-error"
                role="alert"
                className="mb-0 mt-1 px-2 pb-1 text-[11px] leading-4 text-danger"
              >
                {inlineError}
              </p>
            ) : (
              <p className="mb-0 mt-1 px-2 pb-1 text-[11px] leading-4 text-subtle">
                Versions cover text files during the alpha.
              </p>
            )}
          </div>
        </>
      ) : null}

      {pendingSwitch !== null ? (
        <Overlay onClose={() => setPendingSwitch(null)}>
          <div
            data-testid="version-switch-save-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="version-switch-save-title"
            className="dohc-elevated w-[min(420px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5"
          >
            <h3
              id="version-switch-save-title"
              className="m-0 text-sm font-semibold text-ink"
            >
              Save your changes first?
            </h3>
            <p className="mb-0 mt-2 text-xs leading-5 text-muted">
              You have unsaved changes. dohc will save them into{" "}
              <span className="font-semibold text-ink">{activeName}</span> and then
              switch to{" "}
              <span className="font-semibold text-ink">
                {versionName(snapshot, pendingSwitch)}
              </span>
              .
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-testid="version-switch-save-cancel"
                onClick={() => setPendingSwitch(null)}
                className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="version-switch-save-continue"
                autoFocus
                onClick={() => {
                  const target = pendingSwitch;
                  setPendingSwitch(null);
                  if (target) void performSwitch(target);
                }}
                className="h-8 cursor-pointer rounded-md bg-accent px-3 text-xs font-semibold text-bg hover:opacity-90"
              >
                Save and switch
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {mergeSource ? (
        <VersionMergeDialog
          workspaceId={workspaceId}
          source={mergeSource}
          activeTabDirty={props.activeTabDirty}
          flushActiveDraft={props.flushActiveDraft}
          onWorkspaceStateChanged={props.onWorkspaceStateChanged}
          onClose={() => {
            setMergeSource(null);
            void refresh().catch(() => undefined);
          }}
        />
      ) : null}

      {tryOpen ? (
        <TryTaskDialog
          workspaceId={workspaceId}
          activeTabDirty={props.activeTabDirty}
          flushActiveDraft={props.flushActiveDraft}
          onStarted={(activeVersionId) => {
            setTryOpen(false);
            // The gesture switched into the new version; refresh the selector
            // and let the shell reload files/history (the running banner
            // arrives through the same refresh). The new version comes back
            // from the gesture itself, so the shell needs no lookup.
            void refresh().catch(() => undefined);
            props.onWorkspaceStateChanged(activeVersionId);
          }}
          onClose={() => setTryOpen(false)}
        />
      ) : null}
    </div>
  );
}

// The "Try it in a version" task prompt (PR 0N-2). One short question; on
// start, main creates the version, switches into it, and starts the run in a
// single serialized gesture. If an installed agent driver is found, it does
// the work; otherwise the run tracks the user's own agent tool.
// Exported for component tests; the product opens it from the version menu.
export function TryTaskDialog(props: {
  workspaceId: string;
  activeTabDirty: boolean;
  flushActiveDraft: () => Promise<void>;
  /** The version the gesture created and switched into. */
  onStarted: (activeVersionId: string) => void;
  onClose: () => void;
}) {
  const { workspaceId } = props;
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helper, setHelper] = useState<
    | { status: "checking" }
    | { status: "driver"; driverId: string; driverName: string }
    | { status: "none" }
  >({ status: "checking" });
  const liveToken = useRef(0);
  useEffect(
    () => () => {
      liveToken.current += 1;
    },
    [],
  );

  useEffect(() => {
    const token = liveToken.current;
    void bridge()
      .probeAgentDrivers({ workspaceId })
      .then((panel) => {
        if (token !== liveToken.current) return;
        const installed = panel.drivers.find((driver) => driver.installed);
        setHelper(
          installed
            ? {
                status: "driver",
                driverId: installed.id,
                driverName: installed.displayName,
              }
            : { status: "none" },
        );
      })
      .catch(() => {
        if (token !== liveToken.current) return;
        setHelper({ status: "none" });
      });
  }, [workspaceId]);

  const start = useCallback(async () => {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      setError("Describe what the agent should try first.");
      return;
    }
    if (helper.status === "checking" || busy) return;
    const token = ++liveToken.current;
    setBusy(true);
    setError(null);
    try {
      await props.flushActiveDraft();
      if (token !== liveToken.current) return;
      const started = await bridge().tryInWorkspaceVersion({
        workspaceId,
        task: trimmed,
        ...(helper.status === "driver" ? { driverId: helper.driverId } : {}),
      });
      if (token !== liveToken.current) return;
      props.onStarted(started.versionId);
    } catch (caught) {
      if (token !== liveToken.current) return;
      setError(ipcErrorMessage(caught, "Could not start trying this."));
      setBusy(false);
    }
  }, [busy, helper, props, task, workspaceId]);

  return (
    <Overlay onClose={() => (busy ? undefined : props.onClose())}>
      <div
        data-testid="try-task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="try-task-title"
        className="dohc-elevated w-[min(460px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5"
      >
        <h3 id="try-task-title" className="m-0 text-sm font-semibold text-ink">
          Try it in a version
        </h3>
        <p className="mb-0 mt-1.5 text-xs leading-5 text-muted">
          dohc creates a fresh version of this workspace and an agent works on
          your task there. Main stays as it is — review and merge when it's
          done.
          {props.activeTabDirty ? " Your unsaved changes are saved first." : ""}
        </p>
        <label
          className="mt-3 block text-[11px] font-medium text-muted"
          htmlFor="try-task-input"
        >
          What should the agent try?
        </label>
        <textarea
          id="try-task-input"
          data-testid="try-task-input"
          autoFocus
          rows={3}
          maxLength={2000}
          value={task}
          disabled={busy}
          placeholder="Tidy the meeting notes into one summary"
          onChange={(event) => setTask(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void start();
            }
          }}
          className="mt-1 w-full resize-none rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] leading-5 text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
        />
        <p
          data-testid="try-task-helper"
          className="mb-0 mt-1 text-[11px] leading-4 text-subtle"
        >
          {helper.status === "checking"
            ? "Checking for agent tools…"
            : helper.status === "driver"
              ? `${helper.driverName} will do the work. Its edits show up in History as they land.`
              : "No agent app was found — start your own agent in this folder and dohc will follow what it changes."}
        </p>
        {error ? (
          <p
            data-testid="try-task-error"
            role="alert"
            className="mb-0 mt-1 text-[11px] leading-4 text-danger"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="try-task-cancel"
            disabled={busy}
            onClick={props.onClose}
            className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="try-task-start"
            disabled={busy || helper.status === "checking" || task.trim().length === 0}
            onClick={() => void start()}
            className="h-8 cursor-pointer rounded-md bg-accent px-3 text-xs font-semibold text-bg hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
          >
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

type MergeStage =
  | { stage: "confirm" }
  | { stage: "running" }
  | { stage: "clean"; mergedFileCount: number }
  // One loaded window of the open-conflict listing (#562): the rows shown so
  // far, and the continuation for the rest. Resolving replaces the window
  // with the first page of what remains.
  | {
      stage: "conflicts";
      conflicts: WorkspaceVersionConflict[];
      nextAfterConflictId: string | null;
    }
  | { stage: "resolved-all" }
  | { stage: "error"; message: string };

// Exported for the try-in-version review card (PR 0N-2), which reuses THIS
// dialog for its "Merge into Main" action — one merge flow everywhere.
export function VersionMergeDialog(props: {
  workspaceId: string;
  source: WorkspaceVersionRecord;
  activeTabDirty: boolean;
  flushActiveDraft: () => Promise<void>;
  // Pass the version that is active NOW when this operation set it. The
  // shell needs the boundary before it can judge answers still in flight,
  // and a lookup it has to await is a window those answers slip through.
  // Omit it only when the operation did not change the active version, or
  // when it failed and nobody knows what stuck.
  onWorkspaceStateChanged: (activeVersionId?: string) => void;
  onClose: () => void;
  // Optional (PR 0N-2): how the dialog was left when it closed — "merged"
  // (clean or all conflicts resolved), "conflicts-open" (Finish later), or
  // "cancelled". Fired just before onClose.
  onOutcome?: (outcome: "merged" | "conflicts-open" | "cancelled") => void;
}) {
  const { workspaceId, source } = props;
  const [stage, setStage] = useState<MergeStage>({ stage: "confirm" });
  const liveToken = useRef(0);
  // Which loaded conflict window a "Show more" answer belongs to. Every
  // REPLACEMENT of the window (the merge result, each resolution's remaining
  // page) advances it: a stale page for a replaced window would append rows
  // the replacement already repositioned (the renderer async-state
  // invariant).
  const windowGeneration = useRef(0);
  useEffect(
    () => () => {
      liveToken.current += 1;
    },
    [],
  );

  const runMerge = useCallback(async () => {
    const token = ++liveToken.current;
    setStage({ stage: "running" });
    try {
      await props.flushActiveDraft();
      if (token !== liveToken.current) return;
      const result = await bridge().mergeWorkspaceVersion({
        workspaceId,
        versionId: source.id,
      });
      if (token !== liveToken.current) return;
      props.onWorkspaceStateChanged();
      // The merge's own count decides the stage: the rows are the first page
      // of ALL open conflicts, and a lingering sync conflict must not turn a
      // clean merge into a conflicted one. The rows gate it too: a count
      // with an empty terminal page means every conflict was already
      // resolved elsewhere between the merge and the listing — painting a
      // zero-card decide stage over that would ask for decisions that no
      // longer exist.
      if (
        result.conflictCount > 0 &&
        (result.conflicts.length > 0 || result.nextAfterConflictId !== null)
      ) {
        windowGeneration.current += 1;
        setStage({
          stage: "conflicts",
          conflicts: result.conflicts,
          nextAfterConflictId: result.nextAfterConflictId,
        });
      } else if (result.conflictCount > 0) {
        setStage({ stage: "resolved-all" });
      } else {
        setStage({ stage: "clean", mergedFileCount: result.mergedFileCount });
      }
    } catch (error) {
      if (token !== liveToken.current) return;
      setStage({
        stage: "error",
        message: ipcErrorMessage(error, "Could not merge this version into Main."),
      });
    }
  }, [props, source.id, workspaceId]);

  const onResolved = useCallback(
    (remaining: ResolveWorkspaceVersionConflictResult) => {
      props.onWorkspaceStateChanged();
      windowGeneration.current += 1;
      setStage(
        remaining.conflicts.length > 0 || remaining.nextAfterConflictId !== null
          ? {
              stage: "conflicts",
              conflicts: remaining.conflicts,
              nextAfterConflictId: remaining.nextAfterConflictId,
            }
          : { stage: "resolved-all" },
      );
    },
    [props],
  );

  const loadMoreConflicts = useCallback(async () => {
    if (stage.stage !== "conflicts" || stage.nextAfterConflictId === null) return;
    const token = liveToken.current;
    const generation = windowGeneration.current;
    const page = await bridge().listWorkspaceVersionConflicts({
      workspaceId,
      afterConflictId: stage.nextAfterConflictId,
    });
    if (token !== liveToken.current) return;
    // A resolution replaced the window while this page was in flight; its
    // rows belong to the window that asked, not the one that remains.
    if (generation !== windowGeneration.current) return;
    setStage((current) =>
      current.stage === "conflicts"
        ? {
            stage: "conflicts",
            conflicts: [...current.conflicts, ...page.conflicts],
            nextAfterConflictId: page.nextAfterConflictId,
          }
        : current,
    );
  }, [stage, workspaceId]);

  // Closing while merging is never allowed. While conflicts are open, closing
  // is EXPLICIT only ("Finish later"): a stray backdrop click or Escape must
  // not unmount ConflictResolver and discard a hand-written combined copy.
  const canCloseExplicitly = stage.stage !== "running";
  const canCloseFromBackdrop =
    stage.stage !== "running" && stage.stage !== "conflicts";

  // Every close path reports its outcome (when a listener asked) then closes.
  const finish = useCallback(() => {
    const outcome =
      stage.stage === "clean" || stage.stage === "resolved-all"
        ? ("merged" as const)
        : stage.stage === "conflicts"
          ? ("conflicts-open" as const)
          : ("cancelled" as const);
    props.onOutcome?.(outcome);
    props.onClose();
  }, [props, stage.stage]);

  return (
    <Overlay onClose={() => (canCloseFromBackdrop ? finish() : undefined)}>
      <div
        data-testid="version-merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-merge-title"
        className="dohc-elevated flex max-h-[calc(100vh-120px)] w-[min(720px,calc(100vw-32px))] flex-col rounded-xl border border-line bg-panel"
      >
        <header className="border-b border-line px-4 py-3">
          <h3 id="version-merge-title" className="m-0 text-sm font-semibold text-ink">
            {stage.stage === "conflicts"
              ? `Decide what Main should keep`
              : `Merge ${source.name} into Main`}
          </h3>
          {stage.stage === "confirm" ? (
            <p className="mb-0 mt-1 text-xs leading-5 text-muted">
              Everything {source.name} changed will be brought into Main.{" "}
              {source.name} stays as it is, so you can keep working in it.
              {props.activeTabDirty ? " Your unsaved changes are saved first." : ""}
            </p>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {stage.stage === "confirm" ? (
            <p className="m-0 text-xs leading-5 text-muted">
              Versions cover text files during the alpha — other files stay exactly
              as they are. If Main changed in ways that clash with {source.name},
              you'll choose what to keep, file by file.
            </p>
          ) : null}
          {stage.stage === "running" ? (
            <p
              data-testid="version-merge-status"
              className="m-0 text-xs leading-5 text-muted"
              role="status"
            >
              Merging {source.name} into Main…
            </p>
          ) : null}
          {stage.stage === "clean" ? (
            <p
              data-testid="version-merge-status"
              className="m-0 text-xs leading-5 text-success"
              role="status"
            >
              {stage.mergedFileCount === 0
                ? "Main already has everything from this version."
                : `Merged ${stage.mergedFileCount} file${
                    stage.mergedFileCount === 1 ? "" : "s"
                  } into Main.`}
            </p>
          ) : null}
          {stage.stage === "resolved-all" ? (
            <p
              data-testid="version-merge-status"
              className="m-0 text-xs leading-5 text-success"
              role="status"
            >
              All conflicts are resolved. Main is up to date.
            </p>
          ) : null}
          {stage.stage === "error" ? (
            <p
              data-testid="version-merge-status"
              className="m-0 text-xs leading-5 text-danger"
              role="alert"
            >
              {stage.message}
            </p>
          ) : null}
          {stage.stage === "conflicts" ? (
            <>
              <p className="m-0 text-xs leading-5 text-muted" role="status" data-testid="version-merge-status">
                {conflictCountCopy(
                  stage.conflicts.length,
                  stage.nextAfterConflictId !== null,
                )}{" "}
                Choose which copy Main should keep — nothing is lost either way.
              </p>
              <div className="mt-3">
                <ConflictList
                  workspaceId={workspaceId}
                  conflicts={stage.conflicts}
                  hasMore={stage.nextAfterConflictId !== null}
                  onLoadMore={loadMoreConflicts}
                  sourceNameFor={() => source.name}
                  onResolved={onResolved}
                />
              </div>
            </>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          {stage.stage === "confirm" ? (
            <>
              <button
                type="button"
                data-testid="version-merge-cancel"
                onClick={finish}
                className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="version-merge-confirm"
                autoFocus
                onClick={() => void runMerge()}
                className="h-8 cursor-pointer rounded-md bg-accent px-3 text-xs font-semibold text-bg hover:opacity-90"
              >
                Merge into Main
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="version-merge-done"
              disabled={!canCloseExplicitly}
              onClick={finish}
              className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
            >
              {stage.stage === "conflicts" ? "Finish later" : "Done"}
            </button>
          )}
        </footer>
      </div>
    </Overlay>
  );
}

function ConflictSidePane(props: {
  heading: string;
  text: string | null;
  /// What the pane says when it has no text to show: this side is a binary
  /// copy, or this side has no file at all.
  note: string;
}) {
  // How many preview windows this side is showing. One press of "Show more"
  // adds one, so the pane paints a bounded amount per press and the rest of
  // the side stays reachable (#536).
  const [windows, setWindows] = useState(1);
  const preview = useMemo(
    () => (props.text === null ? null : conflictPreview(props.text, windows)),
    [props.text, windows],
  );
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line">
      <div className="border-b border-line bg-panel-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">
        {props.heading}
      </div>
      {preview === null ? (
        <p className="m-0 px-2 py-2 text-[11px] italic leading-4 text-subtle">
          {props.note}
        </p>
      ) : (
        <>
          <pre
            data-testid="version-conflict-side-text"
            className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] leading-4 text-muted"
          >
            {preview.text}
          </pre>
          {preview.hiddenChars > 0 ? (
            <div className="flex items-center justify-between gap-2 border-t border-line bg-panel-2 px-2 py-1">
              <span
                data-testid="version-conflict-side-hidden"
                className="text-[10px] leading-4 text-subtle"
              >
                {preview.hiddenChars.toLocaleString("en-US")} more characters
                hidden
              </span>
              <button
                type="button"
                data-testid="version-conflict-side-show-more"
                onClick={() => setWindows((shown) => shown + 1)}
                className="h-5 shrink-0 cursor-pointer rounded px-1.5 text-[10px] text-muted hover:bg-line/50 hover:text-ink"
              >
                Show more
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// What one side says when it carries no text: its size when it is a binary
// copy, or the side's own "no file here" line. A side is never described by
// its sibling's kind — a mixed conflict shows the readable text on one side
// and the size on the other.
function sideNote(
  binary: { byteLength: number } | null | undefined,
  missingNote: string,
): string {
  return binary ? `Binary copy, ${binary.byteLength} bytes` : missingNote;
}

// Side labels depend on where the conflict came from: a version merge names
// the versions ("On Main" / "In Client Draft"); a sync divergence names the
// machines ("On this machine" / "On your other machine") — never sync
// jargon, and never a misleading version name for a two-machine conflict.
// Takes the ORIGIN, not the whole conflict, because it is the only field that
// decides the labels — and because a caller memoizing on the whole conflict
// object would recompute on every render for no reason.
function conflictSideLabels(
  origin: WorkspaceVersionConflict["origin"],
  sourceName: string,
): {
  currentHeading: string;
  incomingHeading: string;
  /// Each side's owner, as a possessive subject: "Keep Main's copy",
  /// "Started from this machine's copy". One name per side, so the two
  /// sentences can never call the same side different things.
  currentName: string;
  incomingName: string;
  keepCurrent: string;
  keepIncoming: string;
  currentMissing: string;
  incomingMissing: string;
} {
  if (origin === "sync") {
    return {
      currentHeading: "On this machine",
      incomingHeading: "On your other machine",
      currentName: "this machine",
      incomingName: "your other machine",
      keepCurrent: "Keep this machine's copy",
      keepIncoming: "Keep your other machine's copy",
      currentMissing: "This machine doesn't have this file.",
      incomingMissing: "Your other machine removed this file.",
    };
  }
  return {
    currentHeading: "On Main",
    incomingHeading: `In ${sourceName}`,
    currentName: "Main",
    incomingName: sourceName,
    keepCurrent: "Keep Main's copy",
    keepIncoming: `Keep ${sourceName}'s copy`,
    currentMissing: "Main doesn't have this file.",
    incomingMissing: `${sourceName} removed this file.`,
  };
}

/// One side, as a candidate to start a hand-written combined copy from.
type SeedCandidate = {
  /// null means the side has no file at all, which is a legitimate — and
  /// zero-byte — place to start from.
  text: string | null;
  /// Whose copy it is, for "Started from Main's copy."
  name: string;
  /// What that side says when it has no file, for the sentence that explains
  /// an empty start.
  missing: string;
};

/// Where "Combine by hand" starts, and the line that says where that is.
type CombineSeed = { text: string; startedFrom: string };

/// Pick where "Combine by hand" starts: the first side, in preference order,
/// that the engine could actually apply — or an empty copy, which it always
/// can.
///
/// There is no unavailable case, because `apply-merged` measures the SUBMITTED
/// text and nothing else (`lib.rs:7587-7594`). Whatever the two sides weigh, a
/// user writing a short replacement by hand is posting a body the engine
/// takes. So the sides only decide what the box is PREFILLED with, never
/// whether the affordance exists.
///
/// Three ways that prefill is chosen, in order. A side that fits wins — and a
/// side over the cap loses to its smaller SIBLING, because a 5 MiB incoming
/// copy beside a 3 KB copy on Main is still a conflict a user can combine.
/// Failing that, a side with no file is a zero-byte start. Failing that, both
/// copies are too large to load into the box, and it starts empty — which is
/// a worse start, but not a refusal.
function chooseCombineSeed(candidates: SeedCandidate[]): CombineSeed {
  const present = candidates.filter(
    (candidate): candidate is SeedCandidate & { text: string } => candidate.text !== null,
  );
  const fitting = present.find(
    (candidate) => !exceedsUtf8Bytes(candidate.text, CONFLICT_COMBINED_EDIT_MAX_BYTES),
  );
  if (fitting) {
    return { text: fitting.text, startedFrom: `Started from ${fitting.name}'s copy.` };
  }
  // Ranked below every present side: starting empty must never beat starting
  // from a copy the user could have edited.
  const absent = candidates.find((candidate) => candidate.text === null);
  if (absent) {
    return { text: "", startedFrom: `${absent.missing} This starts empty.` };
  }
  return {
    text: "",
    startedFrom:
      `Both copies are larger than ` +
      `${CONFLICT_COMBINED_EDIT_MAX_BYTES.toLocaleString("en-US")} bytes, so this ` +
      `starts empty. That is the largest copy you can combine by hand.`,
  };
}

// One conflict card. Expanded, it paints two side panes; collapsed, only its
// header row — so a workspace with many open conflicts paints two panes, not
// two per conflict (#536). The card stays MOUNTED while collapsed, so a
// hand-written combined copy survives being collapsed.
function ConflictResolver(props: {
  workspaceId: string;
  conflict: WorkspaceVersionConflict;
  sourceName: string;
  expanded: boolean;
  onToggle: () => void;
  onResolved: (remaining: ResolveWorkspaceVersionConflictResult) => void;
}) {
  const { conflict, expanded, sourceName, workspaceId } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [combined, setCombined] = useState<string | null>(null);
  // The last change refused for being over the apply cap, in bytes. See the
  // change handler: the combined copy in state is never over the cap, so this
  // is how the attempt is reported.
  const [refusedBytes, setRefusedBytes] = useState<number | null>(null);
  const isBinary = conflict.contentKind === "binary";
  const labels = conflictSideLabels(conflict.origin, sourceName);
  const { currentName, incomingName, currentMissing, incomingMissing } = labels;
  // What "Combine by hand" would start from, and whether the engine could
  // apply it. The seed prefers the incoming side, as it always has, but a side
  // the engine would refuse is not a usable seed — so a side that FITS wins
  // over the preference, and the affordance only disappears when no side does.
  //
  // Gated on `expanded` because it is only read there, and because it is not
  // free: an over-cap side needs an exact byte count for its message, and a
  // dialog can hold hundreds of collapsed cards. Counting all of them on mount
  // was 750 ms for twenty 10 MiB sides against 79 ms for this — the cost this
  // whole change exists to remove, reintroduced one layer up.
  //
  // The dependencies are the PRIMITIVES this reads, never the labels object:
  // that object is rebuilt every render, so depending on it made every local
  // rerender — the one after "Keep Main's copy" sets busy, the one after a
  // refusal — rescan every byte of both sides. A memo that recomputes every
  // render is not a memo.
  const combineSeed = useMemo<CombineSeed | null>(
    () =>
      expanded && !isBinary
        ? chooseCombineSeed([
            {
              text: conflict.incomingText,
              name: incomingName,
              missing: incomingMissing,
            },
            { text: conflict.currentText, name: currentName, missing: currentMissing },
          ])
        : null,
    [
      conflict.currentText,
      conflict.incomingText,
      expanded,
      isBinary,
      currentName,
      incomingName,
      currentMissing,
      incomingMissing,
    ],
  );
  const liveToken = useRef(0);
  useEffect(
    () => () => {
      liveToken.current += 1;
    },
    [],
  );

  // The combined copy in state is NEVER over the apply cap. Every value it can
  // hold comes from here or from a seed that already fits, so the controlled
  // textarea can never be handed a body larger than the cap.
  //
  // This is what stops a paste from recreating the whole defect: an unguarded
  // handler stored a multi-megabyte paste first, and the next render both
  // counted every byte of it and assigned the whole string to the textarea's
  // value. Refusing the change keeps the box at its last good content, so
  // nothing the user already wrote is lost, and names the size they tried.
  // OPENING the box clears the last refusal, and that is the only place that
  // needs to. The warning names a size the user TRIED; carrying it onto a box
  // they have just reopened, holding a seed that fits, describes nothing that
  // is true. Clearing on Cancel as well reads as tidier and is dead: the
  // warning only renders inside the box, so between a cancel and the next open
  // there is nothing to show — and two clears that cover the same path mean
  // neither can be tested, because each masks the other.
  const startCombine = useCallback((seed: string) => {
    setRefusedBytes(null);
    setCombined(seed);
  }, []);

  const onCombinedChange = useCallback((next: string) => {
    const change = applyCombinedChange(next);
    if (!change.accepted) {
      setRefusedBytes(change.refusedBytes);
      return;
    }
    setRefusedBytes(null);
    setCombined(change.text);
  }, []);

  const resolve = useCallback(
    async (
      resolution:
        | { kind: "keep-current" }
        | { kind: "keep-incoming" }
        | { kind: "keep-combined"; text: string },
    ) => {
      const token = ++liveToken.current;
      setBusy(true);
      setError(null);
      try {
        const result = await bridge().resolveWorkspaceVersionConflict({
          workspaceId,
          conflictId: conflict.conflictId,
          resolution,
        });
        if (token !== liveToken.current) return;
        props.onResolved(result);
      } catch (caught) {
        if (token !== liveToken.current) return;
        setError(ipcErrorMessage(caught, "Could not apply that choice."));
        setBusy(false);
      }
    },
    [conflict.conflictId, props, workspaceId],
  );

  return (
    <section
      data-testid="version-conflict"
      data-conflict-path={conflict.path}
      aria-label={`Conflict in ${conflict.path}`}
      className="rounded-lg border border-line bg-bg p-2"
    >
      <button
        type="button"
        data-testid="version-conflict-toggle"
        aria-expanded={expanded}
        onClick={props.onToggle}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded text-left hover:text-ink"
      >
        {isBinary ? (
          <FileArchive size={12} aria-hidden className="shrink-0 text-subtle" />
        ) : (
          <FileText size={12} aria-hidden className="shrink-0 text-subtle" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          {conflict.path}
        </span>
        {!expanded && combined !== null ? (
          <span
            data-testid="version-conflict-draft-marker"
            className="shrink-0 text-[10px] text-subtle"
          >
            Combined copy in progress
          </span>
        ) : null}
        <ChevronDown
          size={12}
          aria-hidden
          className={`shrink-0 text-subtle ${expanded ? "" : "-rotate-90"}`}
        />
      </button>
      {expanded ? (
        <div className="pt-2">
          {isBinary ? (
            <div
              data-testid="version-conflict-binary"
              className="mb-2 rounded-md border border-line bg-panel-2 px-3 py-2 text-[11px] leading-4 text-muted"
            >
              Binary file. Choose which copy to keep.
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <ConflictSidePane
                heading={labels.currentHeading}
                text={conflict.currentText}
                note={sideNote(conflict.currentBinary, labels.currentMissing)}
              />
              <button
                type="button"
                data-testid="version-conflict-keep-current"
                disabled={busy}
                onClick={() => void resolve({ kind: "keep-current" })}
                className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
              >
                {labels.keepCurrent}
              </button>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <ConflictSidePane
                heading={labels.incomingHeading}
                text={conflict.incomingText}
                note={sideNote(conflict.incomingBinary, labels.incomingMissing)}
              />
              <button
                type="button"
                data-testid="version-conflict-keep-incoming"
                disabled={busy}
                onClick={() => void resolve({ kind: "keep-incoming" })}
                className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
              >
                {labels.keepIncoming}
              </button>
            </div>
          </div>
          {combined === null && combineSeed !== null ? (
            <button
              type="button"
              data-testid="version-conflict-combine"
              disabled={busy}
              onClick={() => startCombine(combineSeed.text)}
              className="mt-2 h-7 cursor-pointer rounded-md px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
            >
              Combine by hand instead…
            </button>
          ) : !isBinary ? (
            <div className="mt-2 flex flex-col gap-1.5">
              <label
                className="text-[10px] font-semibold uppercase tracking-wide text-subtle"
                htmlFor={`combined-${conflict.conflictId}`}
              >
                Combined copy for Main
              </label>
              {combineSeed !== null ? (
                <p
                  data-testid="version-conflict-combined-source"
                  className="m-0 text-[11px] leading-4 text-subtle"
                >
                  {combineSeed.startedFrom}
                </p>
              ) : null}
              <textarea
                id={`combined-${conflict.conflictId}`}
                data-testid="version-conflict-combined-input"
                value={combined ?? ""}
                disabled={busy}
                rows={6}
                onChange={(event) => onCombinedChange(event.target.value)}
                className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[11px] leading-4 text-ink focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
              />
              {refusedBytes !== null ? (
                <p
                  data-testid="version-conflict-combined-too-large"
                  role="alert"
                  className="mb-0 text-[11px] leading-4 text-danger"
                >
                  That change would make the combined copy{" "}
                  {refusedBytes.toLocaleString("en-US")} bytes. Combining by hand
                  works up to{" "}
                  {CONFLICT_COMBINED_EDIT_MAX_BYTES.toLocaleString("en-US")} bytes.
                  Add less text.
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="version-conflict-combine-cancel"
                  disabled={busy}
                  onClick={() => setCombined(null)}
                  className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="version-conflict-apply-combined"
                  disabled={busy}
                  onClick={() => void resolve({ kind: "keep-combined", text: combined ?? "" })}
                  className="h-7 cursor-pointer rounded-md bg-accent px-2 text-[11px] font-semibold text-bg hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
                >
                  Use this combined copy
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {/*
        OUTSIDE the collapsible region on purpose. A resolution can be running,
        or can have failed, while the card is collapsed — nothing stops the
        user opening another conflict mid-request — and a refusal that renders
        only inside the expanded body tells them nothing at all.
      */}
      {error ? (
        <p
          data-testid="version-conflict-error"
          role="alert"
          className="mb-0 mt-2 text-[11px] leading-4 text-danger"
        >
          {error}
        </p>
      ) : null}
      {busy ? (
        <p
          data-testid="version-conflict-busy"
          role="status"
          className="mb-0 mt-2 text-[11px] leading-4 text-subtle"
        >
          Applying…
        </p>
      ) : null}
    </section>
  );
}

// The loaded window of open conflicts, one card each, ONE of them expanded
// (#536). Both conflict surfaces render through this: the merge dialog and
// the standalone review dialog. The window is one or more engine pages
// (#562): "Show more files" fetches the next page, and resolving replaces
// the window with the first page of what remains.
function ConflictList(props: {
  workspaceId: string;
  conflicts: WorkspaceVersionConflict[];
  // Whether a continuation exists past the loaded window.
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  sourceNameFor: (conflict: WorkspaceVersionConflict) => string;
  onResolved: (remaining: ResolveWorkspaceVersionConflictResult) => void;
}) {
  // `undefined` means the user has not chosen yet. `null` means the user
  // collapsed the open card, which is a state they are allowed to be in — the
  // two must not be the same value, or closing a card reopens the first one.
  const [chosenId, setChosenId] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const openId = openConflictId(props.conflicts, chosenId);
  const { conflicts, onLoadMore } = props;
  // The pending flag belongs to the loaded window (#602 review): when the
  // window changes identity (a resolution replaced it, or a page appended),
  // any in-flight Show more belongs to the OLD window — clear the flag now
  // rather than when the abandoned request settles (indefinitely, if it
  // never does), and let its settle repaint nothing.
  const loadToken = useRef(0);
  useEffect(() => {
    loadToken.current += 1;
    setLoadingMore(false);
    setLoadMoreError(null);
  }, [conflicts]);
  const loadMore = useCallback(() => {
    const token = ++loadToken.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    void onLoadMore()
      .catch((error) => {
        if (token !== loadToken.current) return;
        setLoadMoreError(
          ipcErrorMessage(error, "Couldn't load more conflicting files."),
        );
      })
      .finally(() => {
        if (token === loadToken.current) setLoadingMore(false);
      });
  }, [onLoadMore]);

  return (
    <div className="flex flex-col gap-3">
      {props.conflicts.map((conflict) => (
        <ConflictResolver
          key={conflict.conflictId}
          workspaceId={props.workspaceId}
          conflict={conflict}
          sourceName={props.sourceNameFor(conflict)}
          expanded={conflict.conflictId === openId}
          onToggle={() =>
            setChosenId(conflict.conflictId === openId ? null : conflict.conflictId)
          }
          onResolved={props.onResolved}
        />
      ))}
      {props.hasMore ? (
        <div className="flex flex-col items-start gap-1">
          <button
            type="button"
            data-testid="conflict-list-show-more"
            disabled={loadingMore}
            onClick={loadMore}
            className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Show more files"}
          </button>
          {loadMoreError ? (
            <p className="m-0 text-[11px] leading-4 text-danger" role="alert">
              {loadMoreError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/// The count sentence both conflict surfaces open with. The loaded window may
/// not be the whole listing (#562): while a continuation is open more
/// conflicts exist past the window, so the sentence says "more than" — never
/// a number that could be under the truth.
export function conflictCountCopy(count: number, hasMore: boolean): string {
  if (hasMore) {
    return count === 1
      ? "More than one file has two copies."
      : `More than ${count} files have two copies.`;
  }
  return count === 1
    ? "One file has two copies."
    : `${count} files have two copies.`;
}

/// Which conflict is expanded. Exported for its own tests: the three states it
/// distinguishes are not obvious from either call site.
export function openConflictId(
  conflicts: WorkspaceVersionConflict[],
  chosenId: string | null | undefined,
): string | null {
  const firstId = conflicts[0]?.conflictId ?? null;
  // Untouched: the first file to decide opens by itself.
  if (chosenId === undefined) return firstId;
  // Collapsed on purpose: leave every card closed.
  if (chosenId === null) return null;
  // A resolved conflict leaves the list, so a chosen id that is no longer in
  // it hands the turn to the next file to decide.
  return conflicts.some((conflict) => conflict.conflictId === chosenId)
    ? chosenId
    : firstId;
}

function changeStatusLabel(status: WorkspaceVersionFileChange["status"]): string {
  if (status === "added") return "Added";
  if (status === "deleted") return "Removed";
  return "Changed";
}

// One compared file's text diff. Its own component so the diff is built once
// per pair of bodies instead of on every render of the whole compare page —
// the same bound the history diff page relies on (see unifiedDiff.tsx).
function CompareFileDiff(props: { currentText?: string; incomingText?: string }) {
  const lines = useMemo(
    () => buildUnifiedDiffLines(computeTextDiff(props.currentText, props.incomingText, 800)),
    [props.currentText, props.incomingText],
  );
  return <UnifiedDiffLines lines={lines} testId="version-compare-diff-lines" />;
}

// Full-page comparison of a version against Main (virtual editor tab).
// Mirrors the history diff page's rendering so diffs look the same
// everywhere.
export function VersionComparePage(props: {
  workspaceId: string;
  versionId: string;
}) {
  const { workspaceId, versionId } = props;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
        status: "ready";
        versionName: string;
        // The loaded window of the comparison (#562): one or more pages, and
        // the continuation for the rest.
        files: WorkspaceVersionFileChange[];
        nextAfterPath: string | null;
      }
  >({ status: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // Which loaded window a page answer belongs to. Every REPLACEMENT of the
  // window (a refresh, a new version) advances it, and a "Show more" answer
  // may only append to the window that asked — a cursor value alone cannot
  // tell two generations apart, because a refreshed comparison can hand out
  // the same cursor again (the renderer async-state invariant).
  const windowGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    windowGeneration.current += 1;
    setState({ status: "loading" });
    // The pending flag belongs to the window too (#602 review): without this
    // reset, a replaced window inherits an abandoned page's "Loading…" until
    // the stale request settles — indefinitely, if it never does.
    setLoadingMore(false);
    setLoadMoreError(null);
    void (async () => {
      const [versions, comparison] = await Promise.all([
        bridge().listWorkspaceVersions({ workspaceId }),
        bridge().compareWorkspaceVersions({ workspaceId, versionId }),
      ]);
      if (cancelled) return;
      const name =
        versions.versions.find((version) => version.id === versionId)?.name ??
        "This version";
      setState({
        status: "ready",
        versionName: name,
        files: comparison.files,
        nextAfterPath: comparison.nextAfterPath,
      });
    })().catch((error) => {
      if (cancelled) return;
      setState({
        status: "error",
        message: ipcErrorMessage(error, "Could not compare with Main."),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, versionId, refreshNonce]);

  const loadMore = useCallback(() => {
    if (state.status !== "ready" || state.nextAfterPath === null) return;
    const afterPath = state.nextAfterPath;
    const generation = windowGeneration.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    void bridge()
      .compareWorkspaceVersions({ workspaceId, versionId, afterPath })
      .then((page) => {
        // A refresh replaced the window while this page was in flight. The
        // refreshed comparison can reuse the same cursor value, so only the
        // generation can prove this answer still has a window to append to.
        if (windowGeneration.current !== generation) return;
        setState((current) =>
          current.status === "ready"
            ? {
                ...current,
                files: [...current.files, ...page.files],
                nextAfterPath: page.nextAfterPath,
              }
            : current,
        );
      })
      .catch((error) => {
        if (windowGeneration.current !== generation) return;
        setLoadMoreError(
          ipcErrorMessage(error, "Couldn't load more changed files."),
        );
      })
      .finally(() => {
        // Only this generation's pending flag: the effect already cleared it
        // for a replaced window, and a stale settle must not repaint it.
        if (windowGeneration.current === generation) setLoadingMore(false);
      });
  }, [state, workspaceId, versionId]);

  return (
    <section
      data-testid="version-compare-page"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg"
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-line bg-panel px-4 py-3">
        <div className="min-w-0 flex-1">
          <SectionLabel>Compare</SectionLabel>
          <h2 className="mb-0 mt-0.5 truncate text-[15px] font-semibold text-ink">
            {state.status === "ready"
              ? `${state.versionName} compared with Main`
              : "Comparing with Main"}
          </h2>
          {state.status === "ready" ? (
            <p className="mb-0 mt-1 text-[11px] text-muted">
              {state.files.length === 0
                ? "The two versions have the same text files."
                : // One numeral style with the conflict copy next door
                  // (docs/brand/copy.md): a lone file is a sentence and
                  // spells "one"; scanned counts above one use numerals.
                  state.nextAfterPath !== null
                  ? state.files.length === 1
                    ? `More than one file differs between ${state.versionName} and Main.`
                    : `More than ${state.files.length} files differ between ${state.versionName} and Main.`
                  : state.files.length === 1
                    ? `One file differs between ${state.versionName} and Main.`
                    : `${state.files.length} files differ between ${state.versionName} and Main.`}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          data-testid="version-compare-refresh"
          aria-label="Refresh comparison"
          title="Refresh comparison"
          disabled={state.status === "loading"}
          onClick={() => setRefreshNonce((nonce) => nonce + 1)}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md border border-line text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto overflow-x-hidden p-4">
        {state.status === "loading" ? (
          <p className="m-0 text-center text-sm text-subtle" role="status">
            Comparing…
          </p>
        ) : state.status === "error" ? (
          <p className="m-0 text-center text-sm text-danger" role="alert">
            {state.message}
          </p>
        ) : state.files.length === 0 ? (
          <div
            data-testid="version-compare-empty"
            className="flex flex-col items-center gap-1 pt-16 text-center"
          >
            <span className="text-sm text-muted">No differences with Main</span>
            <span className="text-xs text-subtle">
              Everything in {state.versionName} matches Main right now.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {state.files.map((file) => (
              <section
                key={file.path}
                data-testid="version-compare-file"
                data-compare-path={file.path}
                className="overflow-hidden rounded-lg border border-line bg-bg"
              >
                <div className="flex min-h-9 items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
                  {file.protected ? (
                    <Lock size={13} aria-hidden className="shrink-0 text-subtle" />
                  ) : file.binary ? (
                    <FileArchive size={13} aria-hidden className="shrink-0 text-subtle" />
                  ) : (
                    <FileText size={13} aria-hidden className="shrink-0 text-subtle" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                    {file.path}
                  </span>
                  <span className="shrink-0 text-[11px] text-subtle">
                    {changeStatusLabel(file.status)}
                  </span>
                </div>
                {file.protected ? (
                  // Secret-backed file (PR 08): the comparison is metadata-only.
                  <div
                    data-testid="version-compare-protected"
                    className="flex flex-col items-center gap-1 px-4 py-8 text-center"
                  >
                    <Lock size={14} aria-hidden className="text-subtle" />
                    <span className="text-sm text-muted">Protected file changed</span>
                    <span className="text-xs text-subtle">
                      This file follows the version, but its contents are never
                      shown in comparisons.
                    </span>
                  </div>
                ) : file.binary ? (
                  <div
                    data-testid="version-compare-binary"
                    className="flex flex-col items-center gap-1 px-4 py-8 text-center"
                  >
                    <FileArchive size={14} aria-hidden className="text-subtle" />
                    <span className="text-sm text-muted">Binary file changed</span>
                    <span className="text-xs text-subtle">
                      This file follows the version byte-for-byte, but contents are
                      not shown in text diffs.
                    </span>
                  </div>
                ) : (
                  <CompareFileDiff
                    currentText={file.currentText}
                    incomingText={file.incomingText}
                  />
                )}
              </section>
            ))}
            {state.nextAfterPath !== null ? (
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  data-testid="version-compare-show-more"
                  disabled={loadingMore}
                  onClick={loadMore}
                  className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Show more files"}
                </button>
                {loadMoreError ? (
                  <p className="m-0 text-[11px] leading-4 text-danger" role="alert">
                    {loadMoreError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

// Standalone review of every OPEN conflict (0P-C). The merge dialog handles
// conflicts born inside a merge; this dialog is how conflicts reach the user
// OUTSIDE that flow — two machines editing the same file while apart, or a
// merge closed with "Finish later". Opened from the notice center's conflict
// notice; reuses the exact ConflictResolver cards so choosing what stays
// looks the same everywhere.
export function ConflictReviewDialog(props: {
  workspaceId: string;
  // Pass the version that is active NOW when this operation set it. The
  // shell needs the boundary before it can judge answers still in flight,
  // and a lookup it has to await is a window those answers slip through.
  // Omit it only when the operation did not change the active version, or
  // when it failed and nobody knows what stuck.
  onWorkspaceStateChanged: (activeVersionId?: string) => void;
  onClose: () => void;
}) {
  const { workspaceId } = props;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
        status: "ready";
        conflicts: WorkspaceVersionConflict[];
        nextAfterConflictId: string | null;
        resolvedAny: boolean;
      }
  >({ status: "loading" });
  const [versionNames, setVersionNames] = useState<Map<string, string>>(new Map());
  const liveToken = useRef(0);
  // Same rule as the merge dialog: a "Show more" answer may only append to
  // the window that asked, and every window replacement (the initial load,
  // each resolution's remaining page) advances this.
  const windowGeneration = useRef(0);
  useEffect(
    () => () => {
      liveToken.current += 1;
    },
    [],
  );

  useEffect(() => {
    const token = liveToken.current;
    void (async () => {
      try {
        const [result, versions] = await Promise.all([
          bridge().listWorkspaceVersionConflicts({ workspaceId }),
          // Version names label merge-origin conflicts; a failure here only
          // degrades labels, never the review itself.
          bridge()
            .listWorkspaceVersions({ workspaceId })
            .catch(() => null),
        ]);
        if (token !== liveToken.current) return;
        setVersionNames(
          new Map(
            (versions?.versions ?? []).map((version) => [version.id, version.name]),
          ),
        );
        windowGeneration.current += 1;
        setState({
          status: "ready",
          conflicts: result.conflicts,
          nextAfterConflictId: result.nextAfterConflictId,
          resolvedAny: false,
        });
      } catch (error) {
        if (token !== liveToken.current) return;
        setState({
          status: "error",
          message: ipcErrorMessage(error, "Couldn't load the conflicting files."),
        });
      }
    })();
  }, [workspaceId]);

  const onResolved = useCallback(
    (remaining: ResolveWorkspaceVersionConflictResult) => {
      props.onWorkspaceStateChanged();
      windowGeneration.current += 1;
      setState({
        status: "ready",
        conflicts: remaining.conflicts,
        nextAfterConflictId: remaining.nextAfterConflictId,
        resolvedAny: true,
      });
    },
    [props],
  );

  const loadMoreConflicts = useCallback(async () => {
    if (state.status !== "ready" || state.nextAfterConflictId === null) return;
    const token = liveToken.current;
    const generation = windowGeneration.current;
    const page = await bridge().listWorkspaceVersionConflicts({
      workspaceId,
      afterConflictId: state.nextAfterConflictId,
    });
    if (token !== liveToken.current) return;
    // A resolution replaced the window while this page was in flight; its
    // rows belong to the window that asked, not the one that remains.
    if (generation !== windowGeneration.current) return;
    setState((current) =>
      current.status === "ready"
        ? {
            ...current,
            conflicts: [...current.conflicts, ...page.conflicts],
            nextAfterConflictId: page.nextAfterConflictId,
          }
        : current,
    );
  }, [state, workspaceId]);

  const conflicts = state.status === "ready" ? state.conflicts : [];
  const hasMoreConflicts =
    state.status === "ready" && state.nextAfterConflictId !== null;
  // A continuation with an empty window still means open conflicts exist —
  // the empty state and the close discipline must not read it as "all done".
  const anyOpen = conflicts.length > 0 || hasMoreConflicts;
  // Same close discipline as the merge dialog: while conflicts are open,
  // closing is explicit only — a stray backdrop click must not discard a
  // hand-written combined copy.
  const canCloseFromBackdrop = state.status !== "ready" || !anyOpen;

  return (
    <Overlay onClose={() => (canCloseFromBackdrop ? props.onClose() : undefined)}>
      <div
        data-testid="conflict-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-review-title"
        className="dohc-elevated flex max-h-[calc(100vh-120px)] w-[min(720px,calc(100vw-32px))] flex-col rounded-xl border border-line bg-panel"
      >
        <header className="border-b border-line px-4 py-3">
          <h3 id="conflict-review-title" className="m-0 text-sm font-semibold text-ink">
            Decide what to keep
          </h3>
          {state.status === "ready" && conflicts.length > 0 ? (
            <p className="mb-0 mt-1 text-xs leading-5 text-muted">
              {conflictCountCopy(conflicts.length, hasMoreConflicts)}{" "}
              Choose what stays — nothing is lost either way, and History keeps
              both.
            </p>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {state.status === "loading" ? (
            <p className="m-0 text-xs leading-5 text-muted" role="status">
              Looking for conflicting files…
            </p>
          ) : null}
          {state.status === "error" ? (
            <p className="m-0 text-xs leading-5 text-danger" role="alert">
              {state.message}
            </p>
          ) : null}
          {state.status === "ready" && !anyOpen ? (
            <p
              data-testid="conflict-review-empty"
              className="m-0 text-xs leading-5 text-success"
              role="status"
            >
              {state.resolvedAny
                ? "All set — every conflict is resolved."
                : "Nothing needs your attention here."}
            </p>
          ) : null}
          {state.status === "ready" && conflicts.length > 0 ? (
            <ConflictList
              workspaceId={workspaceId}
              conflicts={conflicts}
              hasMore={hasMoreConflicts}
              onLoadMore={loadMoreConflicts}
              sourceNameFor={(conflict) =>
                versionNames.get(conflict.sourceVersionId) ?? "the other version"
              }
              onResolved={onResolved}
            />
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            data-testid="conflict-review-done"
            onClick={props.onClose}
            className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
          >
            {anyOpen ? "Finish later" : "Done"}
          </button>
        </footer>
      </div>
    </Overlay>
  );
}
