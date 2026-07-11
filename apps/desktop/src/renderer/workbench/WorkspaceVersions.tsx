import { Bot, Check, ChevronDown, FileArchive, FileText, Layers, Lock, RefreshCw, Share2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  WorkspaceVersionConflict,
  WorkspaceVersionFileChange,
  WorkspaceVersionRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { SectionLabel } from "../ui/controls";
import { UnifiedDiffLines, buildUnifiedDiffLines } from "./unifiedDiff";

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
  onWorkspaceStateChanged: () => void;
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
  // Liveness token: bumped on unmount and on every new mutating operation, so
  // a stale response can never apply state (workspace-switch race safety —
  // the shell remounts per workspace, this guards the unmount edge and
  // overlapping operations).
  const liveToken = useRef(0);

  const refresh = useCallback(async () => {
    const token = liveToken.current;
    const result = await bridge().listWorkspaceVersions({ workspaceId });
    if (token !== liveToken.current) return null;
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
      liveToken.current += 1;
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
      const token = ++liveToken.current;
      setBusy("switch");
      setInlineError(null);
      try {
        await props.flushActiveDraft();
        // Re-check liveness after EVERY awaited step: the flush (or the
        // switch) may resolve after this panel was unmounted or superseded,
        // and a stale continuation must not mutate or repaint.
        if (token !== liveToken.current) return;
        await bridge().switchWorkspaceVersion({ workspaceId, versionId });
        if (token !== liveToken.current) return;
        await refresh();
        if (token !== liveToken.current) return;
        props.onWorkspaceStateChanged();
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not switch versions."));
        // The switch may have partially applied before failing; make the
        // selector and editors reflect reality.
        await refresh().catch(() => undefined);
        if (token !== liveToken.current) return;
        props.onWorkspaceStateChanged();
      } finally {
        if (token === liveToken.current) setBusy(null);
      }
    },
    [props, refresh, workspaceId],
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
      const token = ++liveToken.current;
      setBusy("create");
      setInlineError(null);
      try {
        await props.flushActiveDraft();
        if (token !== liveToken.current) return;
        const result = await bridge().createWorkspaceVersion({
          workspaceId,
          name: trimmed,
        });
        if (token !== liveToken.current) return;
        setSnapshot(result);
        props.onWorkspaceStateChanged();
        closeMenu();
      } catch (error) {
        if (token !== liveToken.current) return;
        setInlineError(ipcErrorMessage(error, "Could not create that version."));
      } finally {
        if (token === liveToken.current) setBusy(null);
      }
    },
    [closeMenu, props, workspaceId],
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
          onStarted={() => {
            setTryOpen(false);
            // The gesture switched into the new version; refresh the selector
            // and let the shell reload files/history (the running banner
            // arrives through the same refresh).
            void refresh().catch(() => undefined);
            props.onWorkspaceStateChanged();
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
  onStarted: () => void;
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
      await bridge().tryInWorkspaceVersion({
        workspaceId,
        task: trimmed,
        ...(helper.status === "driver" ? { driverId: helper.driverId } : {}),
      });
      if (token !== liveToken.current) return;
      props.onStarted();
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
              ? `${helper.driverName} will do the work. Watch it in the agent panel.`
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
  | { stage: "conflicts"; conflicts: WorkspaceVersionConflict[] }
  | { stage: "resolved-all" }
  | { stage: "error"; message: string };

// Exported for the try-in-version review card (PR 0N-2), which reuses THIS
// dialog for its "Merge into Main" action — one merge flow everywhere.
export function VersionMergeDialog(props: {
  workspaceId: string;
  source: WorkspaceVersionRecord;
  activeTabDirty: boolean;
  flushActiveDraft: () => Promise<void>;
  onWorkspaceStateChanged: () => void;
  onClose: () => void;
  // Optional (PR 0N-2): how the dialog was left when it closed — "merged"
  // (clean or all conflicts resolved), "conflicts-open" (Finish later), or
  // "cancelled". Fired just before onClose.
  onOutcome?: (outcome: "merged" | "conflicts-open" | "cancelled") => void;
}) {
  const { workspaceId, source } = props;
  const [stage, setStage] = useState<MergeStage>({ stage: "confirm" });
  const liveToken = useRef(0);
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
      if (result.conflicts.length > 0) {
        setStage({ stage: "conflicts", conflicts: result.conflicts });
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
    (remaining: WorkspaceVersionConflict[]) => {
      props.onWorkspaceStateChanged();
      setStage(
        remaining.length > 0
          ? { stage: "conflicts", conflicts: remaining }
          : { stage: "resolved-all" },
      );
    },
    [props],
  );

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
                {source.name} and Main both changed{" "}
                {stage.conflicts.length === 1
                  ? "one file"
                  : `${stage.conflicts.length} files`}
                . Choose which copy Main should keep — nothing is lost either way.
              </p>
              <div className="mt-3 flex flex-col gap-3">
                {stage.conflicts.map((conflict) => (
                  <ConflictResolver
                    key={conflict.conflictId}
                    workspaceId={workspaceId}
                    conflict={conflict}
                    sourceName={source.name}
                    onResolved={onResolved}
                  />
                ))}
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
  missingNote: string;
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line">
      <div className="border-b border-line bg-panel-2 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">
        {props.heading}
      </div>
      {props.text === null ? (
        <p className="m-0 px-2 py-2 text-[11px] italic leading-4 text-subtle">
          {props.missingNote}
        </p>
      ) : (
        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[11px] leading-4 text-muted">
          {props.text}
        </pre>
      )}
    </div>
  );
}

// Side labels depend on where the conflict came from: a version merge names
// the versions ("On Main" / "In Client Draft"); a sync divergence names the
// machines ("On this machine" / "On your other machine") — never sync
// jargon, and never a misleading version name for a two-machine conflict.
function conflictSideLabels(
  conflict: WorkspaceVersionConflict,
  sourceName: string,
): {
  currentHeading: string;
  incomingHeading: string;
  keepCurrent: string;
  keepIncoming: string;
  currentMissing: string;
  incomingMissing: string;
} {
  if (conflict.origin === "sync") {
    return {
      currentHeading: "On this machine",
      incomingHeading: "On your other machine",
      keepCurrent: "Keep this machine's copy",
      keepIncoming: "Keep the other machine's copy",
      currentMissing: "This machine doesn't have this file.",
      incomingMissing: "Your other machine removed this file.",
    };
  }
  return {
    currentHeading: "On Main",
    incomingHeading: `In ${sourceName}`,
    keepCurrent: "Keep Main's copy",
    keepIncoming: `Keep ${sourceName}'s copy`,
    currentMissing: "Main doesn't have this file.",
    incomingMissing: `${sourceName} removed this file.`,
  };
}

function ConflictResolver(props: {
  workspaceId: string;
  conflict: WorkspaceVersionConflict;
  sourceName: string;
  onResolved: (remaining: WorkspaceVersionConflict[]) => void;
}) {
  const { conflict, sourceName, workspaceId } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [combined, setCombined] = useState<string | null>(null);
  const isBinary = conflict.contentKind === "binary";
  const labels = conflictSideLabels(conflict, sourceName);
  const liveToken = useRef(0);
  useEffect(
    () => () => {
      liveToken.current += 1;
    },
    [],
  );

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
        props.onResolved(result.conflicts);
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
      <div className="flex items-center gap-1.5 pb-2">
        {isBinary ? (
          <FileArchive size={12} aria-hidden className="shrink-0 text-subtle" />
        ) : (
          <FileText size={12} aria-hidden className="shrink-0 text-subtle" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          {conflict.path}
        </span>
      </div>
      {isBinary ? (
        <div
          data-testid="version-conflict-binary"
          className="mb-2 rounded-md border border-line bg-panel-2 px-3 py-2 text-[11px] leading-4 text-muted"
        >
          Binary file. {labels.currentHeading}:{" "}
          {conflict.currentBinary ? `${conflict.currentBinary.byteLength} bytes` : "no copy"};{" "}
          {labels.incomingHeading.toLowerCase()}:{" "}
          {conflict.incomingBinary ? `${conflict.incomingBinary.byteLength} bytes` : "no copy"}.
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          {isBinary ? null : (
            <ConflictSidePane
              heading={labels.currentHeading}
              text={conflict.currentText}
              missingNote={labels.currentMissing}
            />
          )}
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
          {isBinary ? null : (
            <ConflictSidePane
              heading={labels.incomingHeading}
              text={conflict.incomingText}
              missingNote={labels.incomingMissing}
            />
          )}
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
      {!isBinary && combined === null ? (
        <button
          type="button"
          data-testid="version-conflict-combine"
          disabled={busy}
          onClick={() =>
            setCombined(conflict.incomingText ?? conflict.currentText ?? "")
          }
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
          <textarea
            id={`combined-${conflict.conflictId}`}
            data-testid="version-conflict-combined-input"
            value={combined ?? ""}
            disabled={busy}
            rows={6}
            onChange={(event) => setCombined(event.target.value)}
            className="w-full resize-y rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[11px] leading-4 text-ink focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
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
      {error ? (
        <p role="alert" className="mb-0 mt-2 text-[11px] leading-4 text-danger">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="mb-0 mt-2 text-[11px] leading-4 text-subtle">
          Applying…
        </p>
      ) : null}
    </section>
  );
}

function changeStatusLabel(status: WorkspaceVersionFileChange["status"]): string {
  if (status === "added") return "Added";
  if (status === "deleted") return "Removed";
  return "Changed";
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
        files: WorkspaceVersionFileChange[];
      }
  >({ status: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      const [versions, comparison] = await Promise.all([
        bridge().listWorkspaceVersions({ workspaceId }),
        bridge().compareWorkspaceVersions({ workspaceId, versionId }),
      ]);
      if (cancelled) return;
      const name =
        versions.versions.find((version) => version.id === versionId)?.name ??
        "This version";
      setState({ status: "ready", versionName: name, files: comparison.files });
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
                : `${state.files.length} file${
                    state.files.length === 1 ? "" : "s"
                  } differ${state.files.length === 1 ? "s" : ""} between ${
                    state.versionName
                  } and Main.`}
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
                  <UnifiedDiffLines
                    lines={buildUnifiedDiffLines(file.currentText, file.incomingText, 800)}
                  />
                )}
              </section>
            ))}
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
  onWorkspaceStateChanged: () => void;
  onClose: () => void;
}) {
  const { workspaceId } = props;
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; conflicts: WorkspaceVersionConflict[]; resolvedAny: boolean }
  >({ status: "loading" });
  const [versionNames, setVersionNames] = useState<Map<string, string>>(new Map());
  const liveToken = useRef(0);
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
        setState({ status: "ready", conflicts: result.conflicts, resolvedAny: false });
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
    (remaining: WorkspaceVersionConflict[]) => {
      props.onWorkspaceStateChanged();
      setState({ status: "ready", conflicts: remaining, resolvedAny: true });
    },
    [props],
  );

  const conflicts = state.status === "ready" ? state.conflicts : [];
  // Same close discipline as the merge dialog: while conflicts are open,
  // closing is explicit only — a stray backdrop click must not discard a
  // hand-written combined copy.
  const canCloseFromBackdrop = state.status !== "ready" || conflicts.length === 0;

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
              {conflicts.length === 1
                ? "One file has two copies."
                : `${conflicts.length} files have two copies.`}{" "}
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
          {state.status === "ready" && conflicts.length === 0 ? (
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
            <div className="flex flex-col gap-3">
              {conflicts.map((conflict) => (
                <ConflictResolver
                  key={conflict.conflictId}
                  workspaceId={workspaceId}
                  conflict={conflict}
                  sourceName={
                    versionNames.get(conflict.sourceVersionId) ?? "the other version"
                  }
                  onResolved={onResolved}
                />
              ))}
            </div>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            data-testid="conflict-review-done"
            onClick={props.onClose}
            className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
          >
            {conflicts.length > 0 ? "Finish later" : "Done"}
          </button>
        </footer>
      </div>
    </Overlay>
  );
}
