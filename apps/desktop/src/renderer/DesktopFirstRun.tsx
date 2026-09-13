import { DohcMark } from "@dohc/brand";
import { FolderOpen, Inbox, Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import type { Workspace } from "./DesktopWorkspaceShell";
import { JoinSyncedWorkspace } from "./JoinSyncedWorkspace";
import { OpenSharedView } from "./OpenSharedView";
import { ShareHandoffSurface } from "./ShareHandoffSurface";
import { Titlebar } from "./Titlebar";
import { SecondaryButton } from "./ui/controls";
import { NewWorkspaceCard, openExistingFolder } from "./NewWorkspaceCard";

// First launch is a working tool, not a marketing page. The one decision on
// this screen is where the files live, so the path is the headline: parent
// folder dimmed, the workspace folder name in ink and editable. Everything
// else (open a folder, join, open a share) is a quieter list below it.

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

export function DesktopFirstRun(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
  handoffStatus?: ShareHandoffStatus;
  onDismissShareHandoff?: () => void;
  onShareHandoffOpened?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [openingShare, setOpeningShare] = useState(false);
  const handoffStatus = props.handoffStatus ?? { status: "idle" as const };

  useEffect(() => {
    if (handoffStatus.status === "idle") return;
    setJoining(false);
    setOpeningShare(false);
  }, [handoffStatus.status]);

  async function openExisting() {
    setError(null);
    try {
      const workspace = await openExistingFolder();
      if (workspace) props.onWorkspaceReady(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="app-chrome flex h-screen flex-col bg-bg text-ink">
      {/* The first-run window is frameless too: without the drag strip it
          could not be moved at all. */}
      <Titlebar />
      <div className="dohc-paper-grid flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-8">
        <div className="m-auto flex w-105 max-w-full flex-col items-center gap-8">
        <DohcMark size={32} className="text-ink" />

        {handoffStatus.status !== "idle" ? (
          <ShareHandoffSurface
            status={handoffStatus}
            onWorkspaceReady={props.onWorkspaceReady}
            onBack={() => props.onDismissShareHandoff?.()}
            onOpened={() => props.onShareHandoffOpened?.()}
          />
        ) : joining ? (
          <JoinSyncedWorkspace
            onWorkspaceReady={props.onWorkspaceReady}
            onBack={() => setJoining(false)}
          />
        ) : openingShare ? (
          <OpenSharedView
            onWorkspaceReady={props.onWorkspaceReady}
            onBack={() => setOpeningShare(false)}
          />
        ) : (
          <div className="flex w-full flex-col gap-5">
            <NewWorkspaceCard onWorkspaceReady={props.onWorkspaceReady} />

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
        )}
        </div>
      </div>
    </div>
  );
}
