import { SecondaryButton } from "./ui/controls";
import { DohcMark } from "@dohc/brand";
import { Cloud, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";
import { JoinSyncedWorkspace } from "./JoinSyncedWorkspace";
import { OpenSharedView } from "./OpenSharedView";
import { ShareHandoffSurface } from "./ShareHandoffSurface";
import { Titlebar } from "./Titlebar";
import { PrimaryButton } from "./ui/controls";

// First launch is a working tool, not a marketing page: pick where your
// files live, create the folder, start working. No account exists here —
// unless you're adding a workspace you already sync elsewhere, which is the
// "Join a synced workspace" path.
export function DesktopFirstRun(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
  handoffStatus?: ShareHandoffStatus;
  onDismissShareHandoff?: () => void;
  onShareHandoffOpened?: () => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloudNote, setCloudNote] = useState(false);
  const [joining, setJoining] = useState(false);
  const [openingShare, setOpeningShare] = useState(false);
  const handoffStatus = props.handoffStatus ?? { status: "idle" as const };

  useEffect(() => {
    void bridge()
      .getDefaultWorkspaceRoot()
      .then(setRoot)
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  useEffect(() => {
    if (handoffStatus.status === "idle") return;
    setJoining(false);
    setOpeningShare(false);
  }, [handoffStatus.status]);

  async function chooseFolder() {
    const picked = await bridge().pickWorkspaceRoot();
    if (picked) setRoot(picked);
  }

  async function createWorkspace() {
    if (!root || creating) return;
    setCreating(true);
    try {
      const workspace = await bridge().createLocalWorkspace({
        rootPath: `${root}/personal`,
        kind: "personal",
      });
      props.onWorkspaceReady(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  }

  async function openExisting() {
    const picked = await bridge().pickWorkspaceRoot();
    if (!picked) return;
    try {
      const workspace = await bridge().attachWorkspaceFolder({
        rootPath: picked,
      });
      props.onWorkspaceReady(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="app-chrome flex h-screen flex-col bg-bg text-ink">
      {/* The first-run window is frameless too — without the drag strip it
          could not be moved at all. */}
      <Titlebar />
      <div className="dohc-paper-grid flex min-h-0 flex-1 flex-col items-center justify-center gap-7">
      <div className="flex flex-col items-center gap-2.5">
        <DohcMark size={34} className="text-ink" />
        <h1 className="m-0 font-serif text-[26px] font-medium tracking-tight">
          dohc
        </h1>
        <p className="m-0 text-sm text-muted">Your workspace is a folder.</p>
      </div>

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
      <div className="dohc-elevated flex w-105 flex-col gap-3 rounded-xl border border-line bg-panel p-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-wide text-subtle">
              Workspace location
            </span>
            <button
              type="button"
              onClick={() => void chooseFolder()}
              className="flex shrink-0 items-center gap-1.5 rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
            >
              <FolderOpen size={13} aria-hidden />
              Choose a different folder
            </button>
          </div>
          {/* The whole point of this screen is where files live: give the
              complete selectable path the full card width. */}
          <code className="w-full select-text cursor-text break-all font-mono text-[13px] leading-snug text-ink">
            {root ?? "…"}
          </code>
        </div>

        <PrimaryButton
          type="button"
          disabled={!root || creating}
          onClick={() => void createWorkspace()}
        >
          {creating ? "Creating…" : "Create workspace"}
        </PrimaryButton>

        <SecondaryButton
          type="button"
          onClick={() => void openExisting()}

        >
          Open an existing folder as a workspace
        </SecondaryButton>

        <SecondaryButton
          type="button"
          data-testid="first-run-join-synced"
          onClick={() => setJoining(true)}

        >
          Join a synced workspace from another machine
        </SecondaryButton>

        <SecondaryButton
          type="button"
          data-testid="first-run-open-share"
          onClick={() => setOpeningShare(true)}

        >
          Open a share someone sent you
        </SecondaryButton>

        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}

        <div className="flex items-center justify-between gap-4">
          <p className="m-0 text-xs text-subtle">
            Works offline, no account needed. Cloud sync is optional.
          </p>
          <button
            type="button"
            onClick={() => setCloudNote((open) => !open)}
            className="flex shrink-0 items-center gap-1 text-xs text-subtle hover:text-ink"
          >
            <Cloud size={12} aria-hidden />
            Enable dohc Cloud sync
          </button>
        </div>
        {cloudNote ? (
          <p className="m-0 rounded bg-panel-2 px-2.5 py-2 text-xs leading-relaxed text-muted">
            Cloud sync arrives with dohc Cloud accounts — sharing, backup, and
            teams. Your workspace stays fully functional locally, and you can
            connect it later without moving anything.
          </p>
        ) : null}
      </div>
      )}
      </div>
    </div>
  );
}
