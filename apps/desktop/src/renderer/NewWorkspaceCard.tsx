import { FolderOpen, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";
import { PrimaryButton, SectionLabel } from "./ui/controls";

// The folder card: where the new workspace goes and what it is called, then
// Create. Drawn as a folder, with the tab as the label and the sheet holding
// the two fields. First run shows it as the primary; the workspace switcher
// shows the same card in an overlay.

const DEFAULT_FOLDER_NAME = "personal";

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
  // Reported so a host that also offers "open a folder" can show one error
  // slot for both routes.
  onError?: (message: string | null) => void;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [folderName, setFolderName] = useState(DEFAULT_FOLDER_NAME);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void bridge()
      .getDefaultWorkspaceRoot()
      .then(setRoot)
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  async function chooseFolder() {
    const picked = await bridge().pickWorkspaceRoot();
    if (picked) setRoot(picked);
  }

  const canCreate = root !== null && !creating && validFolderName(folderName);

  async function createWorkspace() {
    if (!root || !canCreate) return;
    setCreating(true);
    setError(null);
    props.onError?.(null);
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

  const separator = isWindows() ? "\\" : "/";

  return (
    <form
      className="flex w-full flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void createWorkspace();
      }}
    >
      {/* The sheet's top-left corner is square so the tab sits on it, and
          the tab's bottom edge matches the sheet fill to hide the seam. */}
      <div className="relative z-10 -mb-px flex h-8 w-fit items-center rounded-t-lg border border-line border-b-panel bg-panel px-4">
        <SectionLabel>New workspace</SectionLabel>
      </div>
      <div className="dohc-elevated flex flex-col gap-4 rounded-xl rounded-tl-none border border-line bg-panel p-5">
        <div className="flex flex-col gap-2">
          {/* The parent path is the picker: click it to move the new folder
              somewhere else. */}
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
  );
}

// "Open an existing folder as a workspace": one picker, then attach. Shared
// by first run and the switcher so both spell the route the same way.
export async function openExistingFolder(): Promise<Workspace | null> {
  const picked = await bridge().pickWorkspaceRoot();
  if (!picked) return null;
  return bridge().attachWorkspaceFolder({ rootPath: picked });
}
