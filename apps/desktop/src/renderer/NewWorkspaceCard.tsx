import { Tooltip, useTooltip } from "@dohc/collection-views/tooltip";
import { Folder, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";
import { FolderSheets } from "./FolderSheets";
import { ipcErrorMessage } from "./ipcError";
import { PrimaryButton } from "./ui/controls";
import { useRequestSequence } from "./useRequestSequence";

// The folder card: the new workspace's name on the folder's tab, where its
// folder goes on one line in the card, then Create. Sheets of the kinds a
// workspace holds stand in the folder behind the tab. First run shows it as
// the primary; the workspace manager shows the same card beside its list.

const DEFAULT_FOLDER_NAME = "Personal";

function isWindows(): boolean {
  return bridge().platform === "win32";
}

// The main process hands back forward-slash roots even on Windows. Show the
// path the way the OS spells it; keep sending the forward-slash form back.
export function displayPath(path: string): string {
  return isWindows() ? path.replaceAll("/", "\\") : path;
}

function validFolderName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed !== "." && trimmed !== ".." && !/[\\/]/.test(trimmed);
}

export function NewWorkspaceCard(props: {
  onWorkspaceReady: (workspace: Workspace) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [folderName, setFolderName] = useState(DEFAULT_FOLDER_NAME);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const locationTooltip = useTooltip();
  // The default suggestion and the picker race for the same field. The
  // newest request wins: a slow default must not overwrite a folder the
  // person already chose.
  const rootRequests = useRequestSequence();

  function suggestDefaultRoot() {
    const request = rootRequests.next();
    void bridge()
      .getDefaultWorkspaceRoot()
      .then((suggested) => {
        if (rootRequests.isCurrent(request)) setRoot(suggested);
      })
      .catch((cause) => {
        if (rootRequests.isCurrent(request)) setError(ipcErrorMessage(cause));
      });
  }

  useEffect(() => {
    // The suggested name starts selected, so typing replaces it.
    nameField.current?.focus();
    nameField.current?.select();
    suggestDefaultRoot();
    // rootRequests is a stable ref holder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function chooseFolder() {
    const request = rootRequests.next();
    let picked: string | null = null;
    try {
      picked = await bridge().pickWorkspaceRoot();
    } catch (cause) {
      if (rootRequests.isCurrent(request)) setError(ipcErrorMessage(cause));
    }
    if (!rootRequests.isCurrent(request)) return;
    if (picked) {
      setRoot(picked);
      setError(null);
      return;
    }
    // Cancelled or failed with nothing chosen yet: the default this click
    // retired must still arrive, or the card stays stuck on "…".
    if (root === null) suggestDefaultRoot();
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
      setError(ipcErrorMessage(cause));
      setCreating(false);
    }
  }

  const separator = isWindows() ? "\\" : "/";
  const parent = root ? displayPath(root) : error ? "Choose a folder" : "…";
  const leaf = root ? `${separator}${folderName.trim()}` : "";

  return (
    <form
      className="relative isolate mt-5 flex w-full flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void createWorkspace();
      }}
    >
      <FolderSheets />
      {/* The card's top-left corner is square so the tab sits on it, and
          the tab's bottom edge matches the card fill to hide the seam. The
          tab stops at 60% of the card, so a long name scrolls inside it and
          two sheets always show. */}
      <label className="relative z-3 -mb-px flex h-8 w-fit max-w-[60%] cursor-text items-center gap-2 rounded-t-lg border border-line border-b-panel bg-panel pl-4 pr-3.5">
        <input
          ref={nameField}
          aria-label="Workspace name"
          value={folderName}
          onChange={(event) => setFolderName(event.currentTarget.value)}
          placeholder={DEFAULT_FOLDER_NAME}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="field-sizing-content min-w-0 border-0 bg-transparent p-0 text-sm font-medium text-ink placeholder:text-subtle"
        />
        <Pencil size={13} strokeWidth={1.9} aria-hidden className="shrink-0 text-subtle" />
      </label>
      <div className="dohc-elevated relative z-2 flex flex-col gap-4 rounded-xl rounded-tl-none border border-line bg-panel p-5">
        <div {...locationTooltip.hoverProps} className="relative flex min-w-0 items-center gap-2 text-subtle">
          <Folder size={13} strokeWidth={1.9} aria-hidden className="shrink-0" />
          {/* Too long for the line, the parent folders give way first, so
              the workspace's own folder stays at the end. A name longer than
              the line keeps its end too: it is laid out from the right. */}
          <span data-testid="new-workspace-location" className="flex min-w-0 flex-1 text-[12px] leading-5 text-muted">
            <span className="min-w-0 truncate">{parent}</span>
            <span dir="rtl" className="max-w-[calc(100%-3em)] shrink-0 truncate">
              <bdi dir="ltr">{leaf}</bdi>
            </span>
          </span>
          {/* It stays live when no default arrived, so the person can still
              choose a folder by hand. */}
          <button
            type="button"
            aria-label="Change location"
            {...locationTooltip.focusProps}
            onClick={() => void chooseFolder()}
            className="-mr-1 shrink-0 rounded px-1 py-0.5 text-[12px] leading-5 text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            Change
          </button>
          {/* The path opens over Create, so clicks go through it, and it
              closes once the pointer leaves the line. */}
          <span className="pointer-events-none contents">
            <Tooltip id={locationTooltip.tooltipProps.id} open={locationTooltip.tooltipProps.open && root !== null}>
              <span className="block wrap-anywhere">{root ? `${parent}${leaf}` : null}</span>
            </Tooltip>
          </span>
        </div>

        {error ? (
          <p role="alert" className="-mt-2 text-xs leading-relaxed text-danger">
            {error}
          </p>
        ) : null}

        <PrimaryButton type="submit" disabled={!canCreate}>
          {creating ? "Creating…" : "Create workspace"}
        </PrimaryButton>
      </div>
    </form>
  );
}

// "Open an existing folder as a workspace": one picker, then attach. Shared
// by first run and the switcher so both spell the route the same way.
export async function openExistingFolder(): Promise<Workspace | null> {
  const picked = await bridge().pickWorkspaceRoot();
  if (!picked) return null;
  return bridge().attachWorkspaceFolder({ rootPath: picked });
}
