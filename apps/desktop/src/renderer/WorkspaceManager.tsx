import { DohcMark } from "@dohc/brand";
import { FolderOpen, Inbox, Laptop, MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";
import { JoinSyncedWorkspace } from "./JoinSyncedWorkspace";
import { displayPath, NewWorkspaceCard, openExistingFolder } from "./NewWorkspaceCard";
import { OpenSharedView } from "./OpenSharedView";
import { ShareHandoffSurface } from "./ShareHandoffSurface";
import { Titlebar, workspaceName } from "./Titlebar";
import { IconButton, SecondaryButton } from "./ui/controls";
import { useCommitOnRelease } from "./workbench/useCommitOnRelease";

// The workspace manager. It is the first-run screen and the "manage
// workspaces" screen in one: with nothing registered it is only the routes
// on the right; with workspaces, the list on the left is the switcher, each
// row showing the name and the path the dropdown cannot fit. Nothing new to
// learn between the two states.

// One route: what it is, one line on what it does, and the verb that does it.
function RouteRow(props: {
  icon: ReactNode;
  title: string;
  detail: string;
  action: string;
  // Pinned accessible name where e2e matches on it; visible text stays short.
  ariaLabel?: string;
  testId?: string;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-3.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-panel text-muted">
        {props.icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-medium leading-5 text-ink">{props.title}</span>
        <span className="text-[12px] leading-4 text-muted">{props.detail}</span>
      </div>
      <SecondaryButton
        aria-label={props.ariaLabel}
        data-testid={props.testId}
        onClick={props.onClick}
        className="w-16 shrink-0 text-center"
      >
        {props.action}
      </SecondaryButton>
    </div>
  );
}

// Compact: "now", "5m", "3h", "4d", then a short date.
export function openedLabel(thenMs: number, nowMs = Date.now()): string {
  const minutes = Math.floor(Math.max(0, nowMs - thenMs) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(thenMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Most recently opened first; never-stamped rows keep registry order at the end.
export function byRecency(workspaces: readonly Workspace[]): Workspace[] {
  return [...workspaces].sort(
    (a, b) => (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1),
  );
}

const LIST_WIDTH_KEY = "dohc.workspace-manager.list-width";
const LIST_MIN_WIDTH = 220;
const LIST_MAX_WIDTH = 560;
const LIST_DEFAULT_WIDTH = 320;
const KEYBOARD_RESIZE_STEP = 16;

function clampListWidth(width: number): number {
  if (!Number.isFinite(width)) return LIST_DEFAULT_WIDTH;
  return Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.round(width)));
}

function readListWidth(): number {
  try {
    const stored = window.localStorage.getItem(LIST_WIDTH_KEY);
    return stored === null ? LIST_DEFAULT_WIDTH : clampListWidth(Number(stored));
  } catch {
    return LIST_DEFAULT_WIDTH;
  }
}

function writeListWidth(width: number): void {
  try {
    window.localStorage.setItem(LIST_WIDTH_KEY, String(width));
  } catch {
    // The width is a convenience; storage refusal must not break the manager.
  }
}

function WorkspaceRow(props: {
  workspace: Workspace;
  current: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onForget: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  return (
    <li
      data-testid="workspace-manager-row"
      data-workspace-id={props.workspace.workspaceId}
      className={`group relative flex items-center gap-2 rounded-lg px-3 py-2.5 transition-colors ${
        props.current ? "bg-panel-2" : "hover:bg-panel-2"
      }`}
    >
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 flex-col text-left"
      >
        <span className="truncate text-[13px] font-medium leading-5 text-ink">
          {workspaceName(props.workspace)}
        </span>
        <span className="truncate font-mono text-[11px] leading-4 text-subtle">
          {displayPath(props.workspace.rootPath)}
        </span>
      </button>
      {/* One slot at the end: when it was last opened at rest, the row menu
          on hover, focus, or while open. Nothing else moves. */}
      <div ref={menuRef} className="relative grid size-7 shrink-0 place-items-center">
        {props.workspace.lastOpenedAt !== undefined ? (
          <time
            dateTime={new Date(props.workspace.lastOpenedAt).toISOString()}
            className={`col-start-1 row-start-1 text-[11px] tabular-nums text-subtle transition-opacity ${
              menuOpen ? "opacity-0" : "group-hover:opacity-0 group-focus-within:opacity-0"
            }`}
          >
            {openedLabel(props.workspace.lastOpenedAt)}
          </time>
        ) : null}
        <IconButton
          aria-label={`More for ${workspaceName(props.workspace)}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className={`col-start-1 row-start-1 ${
            menuOpen ? "text-ink" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          }`}
        >
          <MoreHorizontal size={14} aria-hidden />
        </IconButton>
        {menuOpen ? (
          <div
            role="menu"
            className="dohc-popover dohc-pop-in absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-line bg-panel p-1"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                props.onReveal();
              }}
              className="flex h-7 w-full items-center rounded px-2 text-left text-[13px] text-muted hover:bg-panel-2 hover:text-ink"
            >
              Reveal in folder
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                props.onForget();
              }}
              className="flex h-7 w-full items-center rounded px-2 text-left text-[13px] text-muted hover:bg-panel-2 hover:text-danger"
            >
              Forget
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function WorkspaceManager(props: {
  workspaces: Workspace[];
  // The workspace open behind the manager, when there is one. Back returns
  // to it; forgetting it drops to whatever remains.
  current: Workspace | null;
  onOpenWorkspace: (workspace: Workspace) => void;
  onForgot: () => Promise<unknown>;
  handoffStatus?: ShareHandoffStatus;
  onDismissShareHandoff?: () => void;
  onShareHandoffOpened?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [openingShare, setOpeningShare] = useState(false);
  const handoffStatus = props.handoffStatus ?? { status: "idle" as const };
  const hasWorkspaces = props.workspaces.length > 0;
  const workspaces = useMemo(() => byRecency(props.workspaces), [props.workspaces]);
  const [listWidth, setListWidth] = useState(readListWidth);
  const asideRef = useRef<HTMLElement | null>(null);
  const dragLeft = useRef<number | null>(null);
  const resize = useCommitOnRelease((width: number) => {
    setListWidth(width);
    writeListWidth(width);
  });
  const width = resize.previewValue ?? listWidth;

  useEffect(() => {
    if (handoffStatus.status === "idle") return;
    setJoining(false);
    setOpeningShare(false);
  }, [handoffStatus.status]);

  async function openExisting() {
    setError(null);
    try {
      const workspace = await openExistingFolder();
      if (workspace) props.onOpenWorkspace(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function reveal(workspace: Workspace) {
    setError(null);
    try {
      await bridge().revealWorkspaceFolder({ workspaceId: workspace.workspaceId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function forget(workspace: Workspace) {
    setError(null);
    setNotice(null);
    try {
      await bridge().forgetWorkspace({ workspaceId: workspace.workspaceId });
      await props.onForgot();
      setNotice(`Forgot ${workspaceName(workspace)}. Its folder was not deleted.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const routes =
    handoffStatus.status !== "idle" ? (
      <ShareHandoffSurface
        status={handoffStatus}
        onWorkspaceReady={props.onOpenWorkspace}
        onBack={() => props.onDismissShareHandoff?.()}
        onOpened={() => props.onShareHandoffOpened?.()}
      />
    ) : joining ? (
      <JoinSyncedWorkspace onWorkspaceReady={props.onOpenWorkspace} onBack={() => setJoining(false)} />
    ) : openingShare ? (
      <OpenSharedView onWorkspaceReady={props.onOpenWorkspace} onBack={() => setOpeningShare(false)} />
    ) : (
      <div className="flex w-full flex-col gap-5">
        <NewWorkspaceCard onWorkspaceReady={props.onOpenWorkspace} />
        <div className="flex flex-col divide-y divide-line">
          <RouteRow
            icon={<FolderOpen size={15} strokeWidth={1.9} aria-hidden />}
            title="Open an existing folder"
            detail="Use a folder of files you already have."
            action="Open"
            ariaLabel="Open an existing folder as a workspace"
            onClick={() => void openExisting()}
          />
          <RouteRow
            icon={<Laptop size={15} strokeWidth={1.9} aria-hidden />}
            title="Join from another machine"
            detail="Bring over a workspace you sync with dohc Drive."
            action="Join"
            testId="first-run-join-synced"
            onClick={() => setJoining(true)}
          />
          <RouteRow
            icon={<Inbox size={15} strokeWidth={1.9} aria-hidden />}
            title="Open a share"
            detail="Open files someone shared with you."
            action="Open"
            testId="first-run-open-share"
            onClick={() => setOpeningShare(true)}
          />
        </div>
        {error ? (
          <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );

  return (
    <div data-testid="workspace-manager" className="app-chrome flex h-screen flex-col bg-bg text-ink">
      {/* Frameless window: without the drag strip it could not be moved. */}
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        {hasWorkspaces ? (
          <aside
            ref={asideRef}
            data-testid="workspace-manager-list"
            className="relative flex shrink-0 flex-col border-r border-line bg-panel"
            style={{ width }}
          >
            <div className="flex h-11 items-center px-4">
              <span className="text-[13px] font-semibold text-ink">Workspaces</span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-0.5 overflow-y-auto px-2 pb-2">
              {workspaces.map((workspace) => (
                <WorkspaceRow
                  key={workspace.workspaceId}
                  workspace={workspace}
                  current={workspace.workspaceId === props.current?.workspaceId}
                  onOpen={() => props.onOpenWorkspace(workspace)}
                  onReveal={() => void reveal(workspace)}
                  onForget={() => void forget(workspace)}
                />
              ))}
            </ul>
            {notice ? <p className="m-0 px-4 pb-3 text-[11px] text-subtle">{notice}</p> : null}
            <div
              data-testid="workspace-manager-list-resize"
              role="separator"
              tabIndex={0}
              aria-orientation="vertical"
              aria-label="Resize workspace list"
              aria-valuemin={LIST_MIN_WIDTH}
              aria-valuemax={LIST_MAX_WIDTH}
              aria-valuenow={width}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowLeft"
                    ? clampListWidth(width - KEYBOARD_RESIZE_STEP)
                    : event.key === "ArrowRight"
                      ? clampListWidth(width + KEYBOARD_RESIZE_STEP)
                      : event.key === "Home"
                        ? LIST_MIN_WIDTH
                        : event.key === "End"
                          ? LIST_MAX_WIDTH
                          : null;
                if (next === null) return;
                event.preventDefault();
                setListWidth(next);
                writeListWidth(next);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                dragLeft.current = asideRef.current?.getBoundingClientRect().left ?? 0;
                resize.begin(event.pointerId, width);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (dragLeft.current === null || !resize.isActive(event.pointerId)) return;
                resize.update(
                  event.pointerId,
                  clampListWidth(event.clientX - dragLeft.current),
                  event.buttons,
                );
              }}
              onPointerUp={(event) => resize.commit(event.pointerId)}
              onPointerCancel={(event) => resize.commit(event.pointerId)}
              onLostPointerCapture={(event) => resize.commit(event.pointerId)}
              className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-line/80 focus-visible:bg-accent/35"
            />
          </aside>
        ) : null}
        <div className="dohc-paper-grid flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-8">
          <div className="m-auto flex w-105 max-w-full flex-col items-center gap-8">
            <DohcMark size={32} className="text-ink" />
            {routes}
          </div>
        </div>
      </div>
    </div>
  );
}
