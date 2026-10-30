import { DohcMark } from "@dohc/brand";
import { Tooltip, useTooltip } from "@dohc/collection-views/tooltip";
import { FolderOpen, Laptop, Link, MoreHorizontal, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";
import { ipcErrorMessage } from "./ipcError";
import { JoinSyncedWorkspace } from "./JoinSyncedWorkspace";
import { displayPath, NewWorkspaceCard, openExistingFolder } from "./NewWorkspaceCard";
import { OpenSharedView } from "./OpenSharedView";
import { ShareHandoffSurface } from "./ShareHandoffSurface";
import { ConnectionNotices, useConnectionNotices } from "./shell/connectionNotices";
import { useCrashReport } from "./shell/useCrashReport";
import { useWorkspacePathOpenFailures } from "./shell/workspacePathOpenFailures";
import { useMenuCommandsWithoutWorkspace } from "./appMenuCommands";
import { Titlebar, workspaceName } from "./Titlebar";
import { TitlebarUpdateButton, useDesktopUpdate, useUpdateFailureNotices } from "./UpdateButton";
import { GhostButton, IconButton } from "./ui/controls";
import { Menu } from "./ui/Menu";
import { PathLine } from "./ui/PathLine";
import { useCommitOnRelease } from "./workbench/useCommitOnRelease";
import { revealInFileManagerLabel } from "../workspaces/explorerMenu";

// The workspace manager. It is the first-run screen and the "manage
// workspaces" screen in one: with nothing registered it is only the routes
// on the right; with workspaces, the list on the left is the switcher, each
// row showing the name and the path the dropdown cannot fit. Nothing new to
// learn between the two states.

// One other way in: its icon and verb, with the line on what it does in a
// tooltip on hover or keyboard focus.
function RouteButton(props: {
  icon: LucideIcon;
  label: string;
  detail: string;
  testId?: string;
  onClick: () => void;
}) {
  const tooltip = useTooltip();
  const Icon = props.icon;
  return (
    <span {...tooltip.hoverProps} className="relative">
      <GhostButton {...tooltip.focusProps} data-testid={props.testId} onClick={props.onClick}>
        <Icon size={14} strokeWidth={1.9} aria-hidden className="shrink-0" />
        {props.label}
      </GhostButton>
      <Tooltip {...tooltip.tooltipProps}>{props.detail}</Tooltip>
    </span>
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

const ROW_MENU_WIDTH = 176;

function WorkspaceRow(props: {
  workspace: Workspace;
  current: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onForget: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const label = `More for ${workspaceName(props.workspace)}`;

  return (
    <li
      data-testid="workspace-manager-row"
      data-workspace-id={props.workspace.workspaceId}
      className={`group relative flex items-center gap-2 rounded-lg px-3 py-2.5 transition-colors ${
        props.current ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      <button
        type="button"
        title={displayPath(props.workspace.rootPath)}
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 flex-col text-left"
      >
        <span className="truncate text-[13px] font-medium leading-5 text-ink">
          {workspaceName(props.workspace)}
        </span>
        <PathLine path={displayPath(props.workspace.rootPath)} className="text-[11px] leading-4 text-subtle" />
      </button>
      {/* One slot at the end: when it was last opened at rest, the row menu
          on hover, focus, or while open. Nothing else moves. */}
      <div className="relative grid size-7 shrink-0 place-items-center">
        {props.workspace.lastOpenedAt !== undefined ? (
          <time
            dateTime={new Date(props.workspace.lastOpenedAt).toISOString()}
            className={`pointer-events-none col-start-1 row-start-1 text-[11px] tabular-nums text-subtle transition-opacity ${
              menuOpen ? "opacity-0" : "group-hover:opacity-0 group-focus-within:opacity-0"
            }`}
          >
            {openedLabel(props.workspace.lastOpenedAt)}
          </time>
        ) : null}
        <Menu
          label={label}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          width={ROW_MENU_WIDTH}
          trigger={(trigger) => (
            <IconButton
              {...trigger}
              aria-label={label}
              title={label}
              className={`col-start-1 row-start-1 ${
                menuOpen ? "text-ink" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              }`}
            >
              <MoreHorizontal size={14} aria-hidden />
            </IconButton>
          )}
          items={[
            { id: "reveal", label: revealInFileManagerLabel(window.dohcDesktop?.platform), onSelect: props.onReveal },
            { id: "forget", label: "Forget", danger: true, onSelect: props.onForget },
          ]}
        />
      </div>
    </li>
  );
}

export function WorkspaceManager(props: {
  workspaces: Workspace[];
  // The workspace open behind the manager, when there is one. Back returns
  // to it; forgetting it drops to whatever remains.
  current: Workspace | null;
  // May reject: the manager stays open and shows why.
  onOpenWorkspace: (workspace: Workspace) => void | Promise<void>;
  onForgot: () => Promise<unknown>;
  handoffStatus?: ShareHandoffStatus;
  onDismissShareHandoff?: () => void;
  onShareHandoffOpened?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [openingShare, setOpeningShare] = useState(false);
  // The manager owns connection notices rather than the route that raised
  // them: a route change unmounts the panel, and the failure has to survive
  // it along with the way to try again.
  const connectionNotices = useConnectionNotices();
  const crashReportNotice = useCrashReport(connectionNotices);
  // A folder the command line or the OS asked for that did not open.
  useWorkspacePathOpenFailures(null, connectionNotices.reportFailure);
  const update = useDesktopUpdate(connectionNotices.reportFailure);
  const { clearKind } = connectionNotices;
  const clearUpdateFailure = useCallback(() => clearKind("update"), [clearKind]);
  useUpdateFailureNotices(update, "", connectionNotices.reportFailure, clearUpdateFailure);
  // Without the workspace shell, the manager answers the menu commands that
  // need no workspace.
  useMenuCommandsWithoutWorkspace(connectionNotices.reportError, update.run);
  // The address a failed attempt used, put back when a notice's Try again
  // reopens the route it came from.
  const [retryServerUrl, setRetryServerUrl] = useState("");
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

  async function open(workspace: Workspace) {
    setError(null);
    try {
      await props.onOpenWorkspace(workspace);
    } catch (cause) {
      setError(ipcErrorMessage(cause, "Couldn't open the workspace."));
    }
  }

  async function openExisting() {
    setError(null);
    try {
      const workspace = await openExistingFolder();
      if (workspace) await open(workspace);
    } catch (cause) {
      connectionNotices.reportError("Could not open that workspace folder.", cause, () => void openExisting());
    }
  }

  async function reveal(workspace: Workspace) {
    setError(null);
    try {
      await bridge().revealWorkspaceFolder({ workspaceId: workspace.workspaceId });
    } catch (cause) {
      setError(ipcErrorMessage(cause));
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
      setError(ipcErrorMessage(cause));
    }
  }

  const onWorkspaceReady = (workspace: Workspace) => void open(workspace);
  // Where Try again goes when the panel that failed is gone. A handoff is
  // driven from outside the manager, so its retry lands on the share route,
  // which is the same connect step the user was on.
  function reopen(route: "join" | "share") {
    return (serverUrl: string | null) => {
      setRetryServerUrl(serverUrl ?? "");
      setJoining(route === "join");
      setOpeningShare(route === "share");
    };
  }
  function leaveRoute() {
    setRetryServerUrl("");
    setJoining(false);
    setOpeningShare(false);
  }
  const routes =
    handoffStatus.status !== "idle" ? (
      <ShareHandoffSurface
        status={handoffStatus}
        onWorkspaceReady={onWorkspaceReady}
        onBack={() => props.onDismissShareHandoff?.()}
        onOpened={() => props.onShareHandoffOpened?.()}
        ownWorkspace={props.workspaces.some((candidate) => candidate.shareView === undefined)}
        onConnectionError={connectionNotices.reporter(reopen("share"))}
        initialServerUrl={retryServerUrl}
      />
    ) : joining ? (
      <JoinSyncedWorkspace
        onWorkspaceReady={onWorkspaceReady}
        onBack={leaveRoute}
        onConnectionError={connectionNotices.reporter(reopen("join"))}
        initialServerUrl={retryServerUrl}
      />
    ) : openingShare ? (
      <OpenSharedView
        onWorkspaceReady={onWorkspaceReady}
        onBack={leaveRoute}
        onConnectionError={connectionNotices.reporter(reopen("share"))}
        initialServerUrl={retryServerUrl}
      />
    ) : (
      <div className="flex w-full flex-col items-center gap-5">
        <NewWorkspaceCard onWorkspaceReady={onWorkspaceReady} />
        <div className="flex flex-wrap justify-center gap-1">
          <RouteButton
            icon={FolderOpen}
            label="Open folder"
            detail="Use a folder of files you already have."
            onClick={() => void openExisting()}
          />
          <RouteButton
            icon={Link}
            label="Open a share"
            detail="Open files someone shared with you."
            testId="first-run-open-share"
            onClick={() => setOpeningShare(true)}
          />
          <RouteButton
            icon={Laptop}
            label="Join a synced workspace"
            detail="Bring over a workspace you sync through your server."
            testId="first-run-join-synced"
            onClick={() => setJoining(true)}
          />
        </div>
      </div>
    );

  return (
    <div data-testid="workspace-manager" className="app-chrome flex h-screen flex-col bg-bg text-ink">
      {/* Frameless window: without the drag strip it could not be moved. */}
      <Titlebar update={<TitlebarUpdateButton update={update} />} />
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
                  onOpen={() => void open(workspace)}
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
              className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-line/80 keyboard:focus-visible:bg-accent/35"
            />
          </aside>
        ) : null}
        <div className="dohc-paper-grid flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-8">
          <div className="m-auto flex w-105 max-w-full flex-col items-center gap-8">
            <DohcMark size={32} className="text-ink" />
            {routes}
            {/* Below every route: a failed open from the list or a finished
                route must stay visible with the manager. */}
            {error ? (
              <p role="alert" className="m-0 w-full text-xs leading-relaxed text-danger">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <ConnectionNotices
        notices={connectionNotices.notices}
        reportFailure={connectionNotices.reportFailure}
        onRetry={connectionNotices.retryNotice}
        onHide={connectionNotices.hideNotice}
        onDismiss={connectionNotices.dismissNotice}
        {...crashReportNotice}
      />
    </div>
  );
}
