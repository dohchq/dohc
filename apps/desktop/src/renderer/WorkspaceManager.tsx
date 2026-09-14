import { DohcMark } from "@dohc/brand";
import { ArrowLeft, FolderOpen, Inbox, Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";
import { JoinSyncedWorkspace } from "./JoinSyncedWorkspace";
import { NewWorkspaceCard, openExistingFolder } from "./NewWorkspaceCard";
import { NewWorkspaceFolder, WorkspaceFolder } from "./WorkspaceFolder";
import { OpenSharedView } from "./OpenSharedView";
import { ShareHandoffSurface } from "./ShareHandoffSurface";
import { Titlebar, workspaceName } from "./Titlebar";
import { IconButton, SecondaryButton } from "./ui/controls";

// The workspace manager. It is the first-run screen and the "manage
// workspaces" screen in one. With nothing registered it is the folder card
// and the three routes. With workspaces it is a shelf of folders, most
// recently opened first, with a dashed folder-to-be at the end; the three
// routes move up beside the title. Clicking a folder opens it.

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

export function WorkspaceManager(props: {
  workspaces: Workspace[];
  // The workspace open behind the manager, when there is one. Back returns
  // to it; forgetting it drops to whatever remains.
  current: Workspace | null;
  onOpenWorkspace: (workspace: Workspace) => void;
  onBack?: () => void;
  onForgot: () => Promise<unknown>;
  handoffStatus?: ShareHandoffStatus;
  onDismissShareHandoff?: () => void;
  onShareHandoffOpened?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [openingShare, setOpeningShare] = useState(false);
  const [creating, setCreating] = useState(false);
  const handoffStatus = props.handoffStatus ?? { status: "idle" as const };
  const hasWorkspaces = props.workspaces.length > 0;

  useEffect(() => {
    if (handoffStatus.status === "idle") return;
    setJoining(false);
    setOpeningShare(false);
    setCreating(false);
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

  const sorted = [...props.workspaces].sort(
    (left, right) => (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0),
  );

  // A sub-flow replaces the shelf: handoff, join, open share, or (with
  // workspaces present) the new-workspace card.
  const flow =
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
    ) : hasWorkspaces && creating ? (
      <div className="flex w-full flex-col gap-4">
        <div className="flex items-center gap-2">
          <IconButton aria-label="Back" onClick={() => setCreating(false)}>
            <ArrowLeft size={13} aria-hidden />
          </IconButton>
          <span className="text-sm font-semibold text-ink">New workspace</span>
        </div>
        <NewWorkspaceCard onWorkspaceReady={props.onOpenWorkspace} />
      </div>
    ) : null;

  const errorLine = error ? (
    <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
      {error}
    </p>
  ) : null;

  // First run: the card and the three explained routes, centered.
  const firstRun = (
    <div className="dohc-paper-grid flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-8">
      <div className="m-auto flex w-105 max-w-full flex-col items-center gap-8">
        <DohcMark size={32} className="text-ink" />
        {flow ?? (
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
            {errorLine}
          </div>
        )}
      </div>
    </div>
  );

  // The shelf: title and routes across the top, folders below.
  const shelf = (
    <div className="dohc-paper-grid flex min-h-0 flex-1 flex-col overflow-y-auto px-12 py-8">
      {flow ? (
        <div className="m-auto flex w-105 max-w-full flex-col items-center gap-8">
          <DohcMark size={32} className="text-ink" />
          {flow}
        </div>
      ) : (
        <div className="flex w-full max-w-5xl flex-col gap-6">
          <div className="flex items-baseline justify-between gap-6">
            <div className="flex items-center gap-2">
              {props.onBack ? (
                <IconButton aria-label="Back to workspace" onClick={props.onBack} className="-ml-1">
                  <ArrowLeft size={13} aria-hidden />
                </IconButton>
              ) : null}
              <h1 className="m-0 font-serif text-[22px] font-medium leading-tight">Workspaces</h1>
            </div>
            <div className="flex items-center gap-4 text-[12px] text-muted">
              <button
                type="button"
                aria-label="Open an existing folder as a workspace"
                onClick={() => void openExisting()}
                className="hover:text-ink"
              >
                Open a folder
              </button>
              <button
                type="button"
                data-testid="first-run-join-synced"
                onClick={() => setJoining(true)}
                className="hover:text-ink"
              >
                Join from another machine
              </button>
              <button
                type="button"
                data-testid="first-run-open-share"
                onClick={() => setOpeningShare(true)}
                className="hover:text-ink"
              >
                Open a share
              </button>
            </div>
          </div>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-0">
            {sorted.map((workspace) => (
              <WorkspaceFolder
                key={workspace.workspaceId}
                workspace={workspace}
                current={workspace.workspaceId === props.current?.workspaceId}
                onOpen={() => props.onOpenWorkspace(workspace)}
                onReveal={() => void reveal(workspace)}
                onForget={() => void forget(workspace)}
              />
            ))}
            <NewWorkspaceFolder onClick={() => setCreating(true)} />
          </ul>
          {notice ? <p className="m-0 text-[11px] text-subtle">{notice}</p> : null}
          {errorLine}
        </div>
      )}
    </div>
  );

  return (
    <div data-testid="workspace-manager" className="app-chrome flex h-screen flex-col bg-bg text-ink">
      {/* Frameless window: without the drag strip it could not be moved. */}
      <Titlebar />
      {hasWorkspaces ? shelf : firstRun}
    </div>
  );
}
