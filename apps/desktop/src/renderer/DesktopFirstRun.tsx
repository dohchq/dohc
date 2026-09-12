import { DohcMark } from "@dohc/brand";
import { FolderOpen, Inbox, Laptop, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";
import { JoinSyncedWorkspace } from "./JoinSyncedWorkspace";
import { OpenSharedView } from "./OpenSharedView";
import { ShareHandoffSurface } from "./ShareHandoffSurface";
import { Titlebar } from "./Titlebar";
import { PrimaryButton, SecondaryButton, SectionLabel } from "./ui/controls";

// First launch is a working tool, not a marketing page. The one decision on
// this screen is where the files live, so the path is the headline: parent
// folder dimmed, the workspace folder name in ink and editable. Everything
// else (open a folder, join, open a share) is a quieter list below it.

const DEFAULT_FOLDER_NAME = "personal";

function isWindows(): boolean {
  return bridge().platform === "win32";
}

// The main process hands back forward-slash roots even on Windows. Show the
// path the way the OS spells it; keep sending the forward-slash form back.
function displayPath(path: string): string {
  return isWindows() ? path.replaceAll("/", "\\") : path;
}

function validFolderName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed !== "." && trimmed !== ".." && !/[\\/]/.test(trimmed);
}

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
  const [root, setRoot] = useState<string | null>(null);
  const [folderName, setFolderName] = useState(DEFAULT_FOLDER_NAME);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const canCreate = root !== null && !creating && validFolderName(folderName);

  async function createWorkspace() {
    if (!root || !canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const workspace = await bridge().createLocalWorkspace({
        rootPath: `${root}/${folderName.trim()}`,
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
    setError(null);
    try {
      const workspace = await bridge().attachWorkspaceFolder({
        rootPath: picked,
      });
      props.onWorkspaceReady(workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const separator = isWindows() ? "\\" : "/";

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
            {/* Drawn as a folder: the tab is the label, the sheet holds the
                path. The sheet's top-left corner is square so the tab sits on
                it, and the tab's bottom edge matches the sheet fill to hide
                the seam. */}
            <form
              className="flex flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                void createWorkspace();
              }}
            >
              <div className="relative z-10 -mb-px flex h-8 w-fit items-center rounded-t-lg border border-line border-b-panel bg-panel px-4">
                <SectionLabel>New workspace</SectionLabel>
              </div>
              <div className="dohc-elevated flex flex-col gap-4 rounded-xl rounded-tl-none border border-line bg-panel p-5">
                {/* The path is the point of this screen. Parent folder dimmed,
                    the workspace folder in ink, and that last segment is the
                    input, so the whole line reads as one path. */}
                <div className="flex flex-col gap-2">
                  {/* The parent path is the picker: click it to move the new
                      folder somewhere else. */}
                  <button
                    type="button"
                    aria-label="Change location"
                    disabled={root === null}
                    onClick={() => void chooseFolder()}
                    className="group flex h-9 w-full items-center gap-2.5 rounded-md border border-line bg-bg px-3 text-left transition-colors hover:border-ink disabled:pointer-events-none"
                  >
                    <FolderOpen size={13} strokeWidth={1.9} aria-hidden className="shrink-0 text-subtle" />
                    <code className="min-w-0 flex-1 truncate font-mono text-[13px] leading-snug text-muted group-hover:text-ink">
                      {root ? `${displayPath(root)}${separator}` : "…"}
                    </code>
                    <span aria-hidden className="shrink-0 text-[11px] text-subtle group-hover:text-ink">
                      Change
                    </span>
                  </button>
                  {/* Same chip as the location above, so the two read as one
                      form: where it goes, what it is called. */}
                  <label className="flex h-9 w-full items-center gap-2.5 rounded-md border border-line bg-bg px-3 transition-colors focus-within:border-ink">
                    <Pencil size={13} strokeWidth={1.9} aria-hidden className="shrink-0 text-subtle" />
                    <input
                      aria-label="Folder name"
                      value={folderName}
                      onChange={(event) => setFolderName(event.currentTarget.value)}
                      placeholder={DEFAULT_FOLDER_NAME}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[14px] leading-snug text-ink outline-none placeholder:text-subtle"
                    />
                  </label>
                </div>

                <PrimaryButton type="submit" disabled={!canCreate}>
                  {creating ? "Creating…" : "Create workspace"}
                </PrimaryButton>

                {error ? (
                  <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
                    {error}
                  </p>
                ) : null}
              </div>
            </form>

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

          </div>
        )}
        </div>
      </div>
    </div>
  );
}
