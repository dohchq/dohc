import { Check, ChevronDown, FileText, Layers, RefreshCw } from "lucide-react";
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
// real message, or the fallback when there is none.
function ipcErrorMessage(error: unknown, fallback: string): string {
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
  "flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-muted hover:bg-line/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

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
      for (let attempt = 0; attempt < 5 && !cancelled; attempt += 1) {
        try {
          await refresh();
          return;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
        }
      }
    })();
    return () => {
      cancelled = true;
      liveToken.current += 1;
    };
  }, [refresh]);

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
        await bridge().switchWorkspaceVersion({ workspaceId, versionId });
        if (token !== liveToken.current) return;
        await refresh();
        props.onWorkspaceStateChanged();
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not switch versions."));
        // The switch may have partially applied before failing; make the
        // selector and editors reflect reality.
        await refresh().catch(() => undefined);
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
        className="flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded px-2 text-[12px] text-muted hover:bg-line/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60"
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
            className="absolute right-0 top-full z-30 mt-1 w-64 rounded border border-line bg-panel p-1 shadow-lg"
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
                    {isActive ? <Check size={13} aria-hidden /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{version.name}</span>
                </button>
              );
            })}

            <div className="mx-1 my-1 border-t border-line" aria-hidden />

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
                  className="h-7 w-full rounded border border-line bg-bg px-2 text-[12px] text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
                />
                <p className="mb-0 mt-1 text-[10px] leading-4 text-subtle">
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
              <p className="mb-0 mt-1 px-2 pb-1 text-[10px] leading-4 text-subtle">
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
            className="w-[min(420px,calc(100vw-32px))] rounded border border-line bg-panel p-4 shadow-xl"
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
                className="h-8 cursor-pointer rounded border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
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
                className="h-8 cursor-pointer rounded bg-ink px-3 text-xs font-semibold text-bg hover:opacity-90"
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
    </div>
  );
}

type MergeStage =
  | { stage: "confirm" }
  | { stage: "running" }
  | { stage: "clean"; mergedFileCount: number }
  | { stage: "conflicts"; conflicts: WorkspaceVersionConflict[] }
  | { stage: "resolved-all" }
  | { stage: "error"; message: string };

function VersionMergeDialog(props: {
  workspaceId: string;
  source: WorkspaceVersionRecord;
  activeTabDirty: boolean;
  flushActiveDraft: () => Promise<void>;
  onWorkspaceStateChanged: () => void;
  onClose: () => void;
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

  // Only the confirm/summary stages close on backdrop click; while merging or
  // resolving, closing is explicit so a stray click can't hide open work.
  const closable = stage.stage !== "running";

  return (
    <Overlay onClose={() => (closable ? props.onClose() : undefined)}>
      <div
        data-testid="version-merge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-merge-title"
        className="flex max-h-[calc(100vh-120px)] w-[min(720px,calc(100vw-32px))] flex-col rounded border border-line bg-panel shadow-xl"
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
                onClick={props.onClose}
                className="h-8 cursor-pointer rounded border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="version-merge-confirm"
                autoFocus
                onClick={() => void runMerge()}
                className="h-8 cursor-pointer rounded bg-ink px-3 text-xs font-semibold text-bg hover:opacity-90"
              >
                Merge into Main
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="version-merge-done"
              disabled={!closable}
              onClick={props.onClose}
              className="h-8 cursor-pointer rounded border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
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
    <div className="flex min-w-0 flex-col overflow-hidden rounded border border-line">
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
      className="rounded border border-line bg-bg p-2"
    >
      <div className="flex items-center gap-1.5 pb-2">
        <FileText size={12} aria-hidden className="shrink-0 text-subtle" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          {conflict.path}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <ConflictSidePane
            heading="On Main"
            text={conflict.currentText}
            missingNote="Main doesn't have this file."
          />
          <button
            type="button"
            data-testid="version-conflict-keep-current"
            disabled={busy}
            onClick={() => void resolve({ kind: "keep-current" })}
            className="h-7 cursor-pointer rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
          >
            Keep Main's copy
          </button>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <ConflictSidePane
            heading={`In ${sourceName}`}
            text={conflict.incomingText}
            missingNote={`${sourceName} removed this file.`}
          />
          <button
            type="button"
            data-testid="version-conflict-keep-incoming"
            disabled={busy}
            onClick={() => void resolve({ kind: "keep-incoming" })}
            className="h-7 cursor-pointer rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
          >
            Keep {sourceName}'s copy
          </button>
        </div>
      </div>
      {combined === null ? (
        <button
          type="button"
          data-testid="version-conflict-combine"
          disabled={busy}
          onClick={() =>
            setCombined(conflict.incomingText ?? conflict.currentText ?? "")
          }
          className="mt-2 h-7 cursor-pointer rounded px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
        >
          Combine by hand instead…
        </button>
      ) : (
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
            value={combined}
            disabled={busy}
            rows={6}
            onChange={(event) => setCombined(event.target.value)}
            className="w-full resize-y rounded border border-line bg-bg px-2 py-1.5 font-mono text-[11px] leading-4 text-ink focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setCombined(null)}
              className="h-7 cursor-pointer rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="version-conflict-apply-combined"
              disabled={busy}
              onClick={() => void resolve({ kind: "keep-combined", text: combined })}
              className="h-7 cursor-pointer rounded bg-ink px-2 text-[11px] font-semibold text-bg hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
            >
              Use this combined copy
            </button>
          </div>
        </div>
      )}
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
          <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
            Compare
          </span>
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
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded border border-line text-muted hover:bg-line/50 hover:text-ink disabled:cursor-wait disabled:opacity-50"
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
                className="overflow-hidden rounded border border-line bg-bg shadow-sm"
              >
                <div className="flex min-h-9 items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
                  <FileText size={13} aria-hidden className="shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                    {file.path}
                  </span>
                  <span className="shrink-0 text-[11px] text-subtle">
                    {changeStatusLabel(file.status)}
                  </span>
                </div>
                <UnifiedDiffLines
                  lines={buildUnifiedDiffLines(file.currentText, file.incomingText, 800)}
                />
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
