import { DohcMark } from "@dohc/brand";
import { Tooltip, useTooltip } from "@dohc/collection-views/tooltip";
import {
  ArrowLeft,
  Folder,
  FolderOpen,
  Laptop,
  Link,
  Link2,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopUserSettingsResult, ShareHandoffStatus } from "../ipc/bridgeContract";
import type { NoticeTarget } from "../notices/noticeTarget";
import type { PrivacySettings } from "../settings/userSettings";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";
import { CloudLogin } from "./CloudLogin";
import { JoinSyncedWorkspace } from "./JoinSyncedWorkspace";
import { Overlay } from "./Overlay";
import { displayPath, NewWorkspaceCard, openExistingFolder } from "./NewWorkspaceCard";
import { OpenSharedView } from "./OpenSharedView";
import { ShareHandoffSurface } from "./ShareHandoffSurface";
import { ReportsPrivacyDialog } from "./settings/ReportsPrivacyDialog";
import { ConnectionNotices, useConnectionNotices } from "./shell/connectionNotices";
import { reportInstallationFailure } from "./shell/installationNotices";
import { useKeptTyping } from "./shell/useKeptTyping";
import { useCrashReport } from "./shell/useCrashReport";
import { useStandaloneReportsNotice } from "./shell/useReportsNotice";
import { ShellErrorReporter } from "./shell/useShellError";
import { useWorkspacePathOpenFailures } from "./shell/workspacePathOpenFailures";
import { useMenuCommandsWithoutWorkspace } from "./appMenuCommands";
import { JoinedWorkspaceMark, Titlebar, workspaceName } from "./Titlebar";
import { TitlebarUpdateButton, useDesktopUpdate, useUpdateFailureNotices } from "./UpdateButton";
import { ipcErrorMessage } from "./ipcError";
import { REMOVE_FAILED, RemoveFromListDialog } from "./RemoveFromListDialog";
import { GhostButton, IconButton } from "./ui/controls";
import { Menu } from "./ui/Menu";
import { removalFacts } from "./workspaceRemoval";
import { PathLine } from "./ui/PathLine";
import { useCommitOnRelease } from "./workbench/useCommitOnRelease";
import { useRequestSequence } from "./useRequestSequence";
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
  return [...workspaces].sort((a, b) => (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1));
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
const LIST_REFRESH = "workspace-list:refresh";

function reportCutOffPrivacySave(
  change: {
    settings: DesktopUserSettingsResult["settings"];
    base: DesktopUserSettingsResult["settings"];
  },
  cause: unknown,
): void {
  reportInstallationFailure({
    message: ipcErrorMessage(cause, "dohc could not save your settings."),
    cause,
    serverUrl: null,
    retry: () => {
      void bridge()
        .setUserSettings(change)
        .catch((next: unknown) => reportCutOffPrivacySave(change, next));
      return true;
    },
  });
}
type RemovalDialog = { workspace: Workspace; busy: boolean; error: string | null };
const ROW_ACTIONS = ["open", "reveal", "remove"] as const;
type RowAction = (typeof ROW_ACTIONS)[number];
const rowIdentity = (action: RowAction, workspaceId: string) =>
  `workspace-row:${action}:${workspaceId}`;

function WorkspaceRow(props: {
  workspace: Workspace;
  current: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const label = `More for ${workspaceName(props.workspace)}`;

  return (
    <li
      data-testid="workspace-manager-row"
      data-workspace-id={props.workspace.workspaceId}
      className={`group relative flex items-center gap-2 rounded-lg px-3 py-2.5 transition-colors ${
        props.current ? "bg-selected font-medium" : "hover:bg-hover"
      }`}
    >
      <button
        type="button"
        title={displayPath(props.workspace.rootPath)}
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {props.workspace.kind === "shared" || props.workspace.shareView ? (
          <Link2 size={14} aria-hidden className="shrink-0 text-subtle" />
        ) : (
          <Folder size={14} aria-hidden className="shrink-0 text-subtle" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium leading-5 text-ink">
            <span className="truncate">{workspaceName(props.workspace)}</span>
            {props.workspace.shareView?.membership ? <JoinedWorkspaceMark /> : null}
          </span>
          <PathLine
            path={displayPath(props.workspace.rootPath)}
            className="text-[12px] leading-4 text-subtle"
          />
        </span>
      </button>
      {/* One slot at the end: when it was last opened at rest, the row menu
          on hover, focus, or while open. Nothing else moves. */}
      <div className="relative grid size-7 shrink-0 place-items-center">
        {props.workspace.lastOpenedAt !== undefined ? (
          <time
            dateTime={new Date(props.workspace.lastOpenedAt).toISOString()}
            className={`pointer-events-none col-start-1 row-start-1 text-[12px] tabular-nums text-subtle transition-opacity ${
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
                menuOpen
                  ? "text-ink"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              }`}
            >
              <MoreHorizontal size={14} aria-hidden />
            </IconButton>
          )}
          items={[
            {
              id: "reveal",
              label: revealInFileManagerLabel(window.dohcDesktop?.platform),
              onSelect: props.onReveal,
            },
            { id: "remove", label: "Remove from list", onSelect: props.onRemove },
          ]}
        />
      </div>
    </li>
  );
}

export function WorkspaceManager(props: {
  workspaces: Workspace[];
  // The workspace open behind the manager, when there is one. Back returns
  // to it; removing it from the list drops to whatever remains.
  current: Workspace | null;
  userSettings?: DesktopUserSettingsResult | null;
  onUserSettingsChange?: (result: DesktopUserSettingsResult) => void;
  // May reject: the manager stays open and a toast says why.
  onOpenWorkspace: (workspace: Workspace) => void | Promise<void>;
  onForgot: () => Promise<unknown>;
  handoffStatus?: ShareHandoffStatus;
  onDismissShareHandoff?: () => void;
  onShareHandoffOpened?: () => void;
  // A dohc://connect link's server, until this manager shows it.
  connectServerUrl?: string | null;
  onConnectServerShown?: () => void;
}) {
  const [joining, setJoining] = useState(false);
  // The connection dialog a dohc://connect link opened, with its address.
  const [connectingTo, setConnectingTo] = useState<string | null>(null);
  const [openingShare, setOpeningShare] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [pendingPrivacy, setPendingPrivacy] = useState<Partial<PrivacySettings>>({});
  const [removing, setRemovingState] = useState<RemovalDialog | null>(null);
  // Written only with the state, so two requests in one turn see each other
  // whenever React renders.
  const removingRef = useRef<RemovalDialog | null>(null);
  const setRemoving = (next: RemovalDialog | null) => {
    removingRef.current = next;
    setRemovingState(next);
  };
  // The manager owns connection notices rather than the route that raised
  // them: a route change unmounts the panel, and the failure has to survive
  // it along with the way to try again.
  const connectionNotices = useConnectionNotices();
  const { connectServerUrl, onConnectServerShown } = props;
  useEffect(() => {
    if (!connectServerUrl) return;
    onConnectServerShown?.();
    // A dialog already open may be waiting on a code: leave its sign-in alone.
    setConnectingTo((open) => open ?? connectServerUrl);
  }, [connectServerUrl, onConnectServerShown]);
  const keptTyping = useKeptTyping();
  const crashReportNotice = useCrashReport(connectionNotices);
  const committedSettingsRef = useRef(props.userSettings ?? null);
  const broadcastSettingsRef = useRef<DesktopUserSettingsResult | null>(null);
  const inFlightPrivacyRef = useRef<Partial<PrivacySettings>>({});
  const queuedPrivacyRef = useRef<Partial<PrivacySettings>>({});
  const savingPrivacyRef = useRef(false);
  const mountedRef = useRef(true);
  const onUserSettingsChangeRef = useRef(props.onUserSettingsChange);
  onUserSettingsChangeRef.current = props.onUserSettingsChange;
  useEffect(() => {
    if (!savingPrivacyRef.current) {
      committedSettingsRef.current = props.userSettings ?? null;
      broadcastSettingsRef.current = null;
    } else if (props.userSettings && props.userSettings !== committedSettingsRef.current) {
      broadcastSettingsRef.current = props.userSettings;
    }
  }, [props.userSettings]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const committedPrivacy = props.userSettings?.settings.privacy ?? null;
  const committedUsage = committedPrivacy?.usageReports;
  const committedErrors = committedPrivacy?.errorReports;
  const pendingUsage = pendingPrivacy.usageReports;
  const pendingErrors = pendingPrivacy.errorReports;
  const effectivePrivacy = useMemo<PrivacySettings | null>(
    () =>
      committedUsage === undefined || committedErrors === undefined
        ? null
        : {
            usageReports: pendingUsage ?? committedUsage,
            errorReports: pendingErrors ?? committedErrors,
          },
    [committedUsage, committedErrors, pendingUsage, pendingErrors],
  );
  const { showReportsNotice: pushReportsNotice, reportsNotice } = connectionNotices;
  const reportsNoticeShown = useStandaloneReportsNotice({
    enabled: props.userSettings !== undefined,
    privacy: committedPrivacy,
    notice: reportsNotice,
    show: (reports) => pushReportsNotice(reports, () => setPrivacyOpen(true)),
  });
  const enqueuePrivacyPatch = useCallback(
    (patch: Partial<PrivacySettings>) => {
      const keys = Object.keys(patch) as Array<keyof PrivacySettings>;
      if (keys.length === 0) return;
      queuedPrivacyRef.current = { ...queuedPrivacyRef.current, ...patch };
      if (mountedRef.current) {
        setPendingPrivacy({ ...inFlightPrivacyRef.current, ...queuedPrivacyRef.current });
      }
      if (savingPrivacyRef.current) return;
      savingPrivacyRef.current = true;
      void (async () => {
        try {
          while (Object.keys(queuedPrivacyRef.current).length > 0) {
            const current = committedSettingsRef.current;
            if (!current) {
              queuedPrivacyRef.current = {};
              inFlightPrivacyRef.current = {};
              if (mountedRef.current) setPendingPrivacy({});
              return;
            }
            const batch = queuedPrivacyRef.current;
            queuedPrivacyRef.current = {};
            inFlightPrivacyRef.current = batch;
            const batchKeys = Object.keys(batch) as Array<keyof PrivacySettings>;
            const nextPrivacy: PrivacySettings = { ...current.settings.privacy, ...batch };
            const change = {
              settings: { ...current.settings, privacy: nextPrivacy },
              base: current.settings,
            };
            try {
              const saved = await bridge().setUserSettings(change);
              committedSettingsRef.current = saved;
              broadcastSettingsRef.current = null;
              inFlightPrivacyRef.current = {};
              const nextPending = { ...queuedPrivacyRef.current };
              if (mountedRef.current) {
                onUserSettingsChangeRef.current?.(saved);
                for (const key of batchKeys) {
                  connectionNotices.clearIdentity(`first-run-privacy:${key}`);
                }
                setPendingPrivacy(nextPending);
              }
            } catch (cause) {
              if (broadcastSettingsRef.current) {
                committedSettingsRef.current = broadcastSettingsRef.current;
                broadcastSettingsRef.current = null;
              }
              inFlightPrivacyRef.current = {};
              const nextPending = { ...queuedPrivacyRef.current };
              if (mountedRef.current) {
                setPendingPrivacy(nextPending);
                for (const key of batchKeys) {
                  const value = batch[key];
                  if (value === undefined) continue;
                  const retryPatch: Partial<PrivacySettings> = { [key]: value };
                  connectionNotices.reportError(
                    "dohc could not save your settings.",
                    cause,
                    () => enqueuePrivacyPatch(retryPatch),
                    undefined,
                    `first-run-privacy:${key}`,
                  );
                }
              } else {
                reportCutOffPrivacySave(change, cause);
              }
            }
          }
        } finally {
          if (broadcastSettingsRef.current) {
            committedSettingsRef.current = broadcastSettingsRef.current;
            broadcastSettingsRef.current = null;
          }
          inFlightPrivacyRef.current = {};
          savingPrivacyRef.current = false;
        }
      })();
    },
    [connectionNotices.clearIdentity, connectionNotices.reportError],
  );
  const savePrivacy = useCallback(
    (nextPrivacy: PrivacySettings) => {
      if (!effectivePrivacy) return;
      const patch: Partial<PrivacySettings> = {};
      if (nextPrivacy.usageReports !== effectivePrivacy.usageReports) {
        patch.usageReports = nextPrivacy.usageReports;
      }
      if (nextPrivacy.errorReports !== effectivePrivacy.errorReports) {
        patch.errorReports = nextPrivacy.errorReports;
      }
      enqueuePrivacyPatch(patch);
    },
    [effectivePrivacy, enqueuePrivacyPatch],
  );
  const openNoticeTarget = useCallback((target: NoticeTarget) => {
    if (target.to === "privacy-settings") setPrivacyOpen(true);
    return Promise.resolve(null);
  }, []);
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

  const currentWorkspace = props.current;
  const openCurrentRef = useRef<() => void>(() => undefined);
  openCurrentRef.current = () => {
    if (currentWorkspace) void open(currentWorkspace);
  };
  useEffect(() => {
    if (
      !currentWorkspace ||
      joining ||
      openingShare ||
      privacyOpen ||
      handoffStatus.status !== "idle" ||
      removing !== null
    )
      return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.documentElement.dataset.menuOpen !== undefined) return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        )
      ) {
        return;
      }
      event.preventDefault();
      openCurrentRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [currentWorkspace, handoffStatus.status, joining, openingShare, privacyOpen, removing]);

  // A failed row action is a toast and a Notices row with Try again: the list
  // stays as it was, so the row is still there to act on. Each failure has an
  // identity, so a repeat replaces its row and a later success takes it back.
  const { reportError, clearIdentity } = connectionNotices;
  // A retry that returns false started nothing, so its failure stays listed.
  const reportRowError = (
    action: RowAction,
    workspaceId: string,
    fallback: string,
    cause: unknown,
    retry: () => void | false,
  ) => reportError(fallback, cause, retry, undefined, rowIdentity(action, workspaceId));
  // The removed row is gone, so none of its failures has anything to retry.
  const clearRow = (workspaceId: string) => {
    for (const action of ROW_ACTIONS) clearIdentity(rowIdentity(action, workspaceId));
  };
  // A retry reads the list as it is now: the row may have gone, or gained
  // something the removal has to ask about.
  const listRefresh = useRequestSequence();
  const workspacesRef = useRef(props.workspaces);
  workspacesRef.current = props.workspaces;

  async function open(workspace: Workspace) {
    try {
      await props.onOpenWorkspace(workspace);
      clearIdentity(rowIdentity("open", workspace.workspaceId));
    } catch (cause) {
      reportRowError(
        "open",
        workspace.workspaceId,
        "dohc could not open this workspace.",
        cause,
        () => void open(workspace),
      );
    }
  }

  async function openExisting() {
    const workspace = await openExistingFolder((cause, folder) =>
      connectionNotices.reportOpenFolderFailure(cause, folder, () => void openExisting()),
    );
    if (workspace) await open(workspace);
  }

  async function reveal(workspace: Workspace) {
    try {
      await bridge().revealWorkspaceFolder({ workspaceId: workspace.workspaceId });
      clearIdentity(rowIdentity("reveal", workspace.workspaceId));
    } catch (cause) {
      reportRowError(
        "reveal",
        workspace.workspaceId,
        "dohc could not show this workspace's folder.",
        cause,
        () => void reveal(workspace),
      );
    }
  }

  // The row leaves the list, which is the result in view, so success says
  // nothing.
  async function removeFromList(workspace: Workspace) {
    const { workspaceId } = workspace;
    try {
      await bridge().forgetWorkspace({ workspaceId });
    } catch (cause) {
      reportRowError("remove", workspaceId, REMOVE_FAILED, cause, () => {
        const current = workspacesRef.current.find((row) => row.workspaceId === workspaceId);
        if (!current) {
          clearIdentity(rowIdentity("remove", workspaceId));
          return undefined;
        }
        // Blocked by another row's open dialog: false keeps this failure listed.
        return requestRemoval(current) ? undefined : false;
      });
      return;
    }
    clearRow(workspaceId);
    await refreshAfterRemoval();
  }

  // The removal already worked, so trying again only refreshes the list.
  // Only the newest refresh reports, so an older one can't undo its result.
  async function refreshAfterRemoval() {
    const token = listRefresh.next();
    try {
      await props.onForgot();
      if (listRefresh.isCurrent(token)) clearIdentity(LIST_REFRESH);
    } catch (cause) {
      if (!listRefresh.isCurrent(token)) return;
      reportError(
        "dohc could not refresh the workspace list.",
        cause,
        () => void refreshAfterRemoval(),
        undefined,
        LIST_REFRESH,
      );
    }
  }

  // A row that holds more than its place asks first and says what goes. An
  // open dialog stays as it is, and the request says it started nothing.
  function requestRemoval(workspace: Workspace): boolean {
    if (removalFacts(workspace).length === 0) {
      void removeFromList(workspace);
      return true;
    }
    if (removingRef.current) return false;
    setRemoving({ workspace, busy: false, error: null });
    return true;
  }

  async function confirmRemoval(workspace: Workspace) {
    setRemoving({ workspace, busy: true, error: null });
    try {
      await bridge().forgetWorkspace({ workspaceId: workspace.workspaceId });
    } catch (cause) {
      setRemoving({ workspace, busy: false, error: ipcErrorMessage(cause, REMOVE_FAILED) });
      return;
    }
    clearRow(workspace.workspaceId);
    setRemoving(null);
    await refreshAfterRemoval();
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
            detail="Open a folder you already have."
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
            detail="Open a workspace synced to your server."
            testId="first-run-join-synced"
            onClick={() => setJoining(true)}
          />
        </div>
      </div>
    );

  return (
    <div
      data-testid="workspace-manager"
      className="app-chrome flex h-screen flex-col bg-bg text-ink"
    >
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
            <div className="flex h-11 items-center gap-2 px-4">
              <span className="text-[13px] font-semibold text-ink">Workspaces</span>
              {props.current ? (
                <GhostButton
                  data-testid="workspace-manager-back"
                  onClick={() => void open(props.current!)}
                  className="ml-auto"
                >
                  <ArrowLeft size={14} aria-hidden />
                  Back
                </GhostButton>
              ) : null}
            </div>
            <ul className="m-0 flex list-none flex-col gap-0.5 overflow-y-auto px-2 pb-2">
              {workspaces.map((workspace) => (
                <WorkspaceRow
                  key={workspace.workspaceId}
                  workspace={workspace}
                  current={workspace.workspaceId === props.current?.workspaceId}
                  onOpen={() => void open(workspace)}
                  onReveal={() => void reveal(workspace)}
                  onRemove={() => requestRemoval(workspace)}
                />
              ))}
            </ul>
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
              onDoubleClick={() => {
                setListWidth(LIST_DEFAULT_WIDTH);
                writeListWidth(LIST_DEFAULT_WIDTH);
              }}
              className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-line/80 keyboard:focus-visible:bg-focus"
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
      {connectingTo !== null ? (
        <Overlay onClose={() => setConnectingTo(null)}>
          <CloudLogin
            initialServerUrl={connectingTo}
            onClose={() => setConnectingTo(null)}
            onConnected={() => setConnectingTo(null)}
            onConnectionError={connectionNotices.reporter((serverUrl) =>
              setConnectingTo(serverUrl ?? ""),
            )}
          />
        </Overlay>
      ) : null}
      {removing ? (
        <RemoveFromListDialog
          workspace={removing.workspace}
          busy={removing.busy}
          error={removing.error}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void confirmRemoval(removing.workspace)}
        />
      ) : null}
      {privacyOpen && effectivePrivacy ? (
        <ShellErrorReporter.Provider value={connectionNotices.reportFailure}>
          <ReportsPrivacyDialog
            privacy={effectivePrivacy}
            onChange={savePrivacy}
            onError={(message, cause) => connectionNotices.reportError(message, cause, null)}
            onClose={() => setPrivacyOpen(false)}
          />
        </ShellErrorReporter.Provider>
      ) : null}
      <ConnectionNotices
        notices={connectionNotices.notices}
        reportFailure={connectionNotices.reportFailure}
        onRetry={connectionNotices.retryNotice}
        onAction={connectionNotices.runNoticeAction}
        onHide={connectionNotices.hideNotice}
        onDismiss={connectionNotices.dismissNotice}
        onShown={reportsNoticeShown}
        onOpenTarget={openNoticeTarget}
        {...crashReportNotice}
        keptTyping={keptTyping.keptTyping}
        onDismissKeptTyping={keptTyping.dismiss}
      />
    </div>
  );
}
