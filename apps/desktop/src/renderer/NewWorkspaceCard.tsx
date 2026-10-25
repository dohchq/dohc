import { useTooltip } from "@dohc/collection-views/tooltip";
import { workspaceNameError } from "@dohc/workspace-contracts/workspace-paths";
import { Folder, Pencil } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import type { Workspace } from "./DesktopWorkspaceShell";
import { FolderSheets } from "./FolderSheets";
import { ipcErrorMessage } from "./ipcError";
import { GhostButton, PrimaryButton } from "./ui/controls";
import { PathLine } from "./ui/PathLine";
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
  // A picked location shows once its suggested name arrives; until then
  // Create would use the location still on screen.
  const [placing, setPlacing] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  // Until the person types, the name is dohc's suggestion and follows the
  // location.
  const nameTyped = useRef(false);
  const locationTooltip = useTooltip();
  // The default suggestion and the picker race for the same field. The
  // newest request wins: a slow default must not overwrite a folder the
  // person already chose.
  const rootRequests = useRequestSequence();

  // Shows the location with a suggested name no folder there has yet:
  // Windows and macOS take an old "personal" for "Personal", and Create
  // would open that folder. Without an answer, the name stays.
  async function placeAt(location: string, request: number): Promise<boolean> {
    if (!rootRequests.isCurrent(request)) return false;
    setPlacing(true);
    const name = nameTyped.current
      ? null
      : await bridge()
          .suggestWorkspaceFolderName({ rootPath: location, name: DEFAULT_FOLDER_NAME })
          .catch(() => null);
    if (!rootRequests.isCurrent(request)) return false;
    setPlacing(false);
    setRoot(location);
    if (name !== null && !nameTyped.current) setFolderName(name);
    return true;
  }

  function suggestDefaultRoot() {
    const request = rootRequests.next();
    void bridge()
      .getDefaultWorkspaceRoot()
      .then((suggested) => placeAt(suggested, request))
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

  // A new suggestion stays selected in the focused field.
  useLayoutEffect(() => {
    if (!nameTyped.current && document.activeElement === nameField.current) nameField.current?.select();
  }, [folderName]);

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
      if (await placeAt(picked, request)) setError(null);
      return;
    }
    // Cancelled or failed: the location on screen stays. With nothing chosen
    // yet, the default this click retired must still arrive, or the card
    // stays stuck on "…".
    setPlacing(false);
    if (root === null) suggestDefaultRoot();
  }

  // A blank name only leaves Create off; any other name is checked as typed.
  const nameError = folderName.trim() ? workspaceNameError(folderName, window.dohcDesktop?.platform ?? "") : null;
  const canCreate = root !== null && !placing && !creating && !nameError && validFolderName(folderName);

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

  const path = root ? `${displayPath(root)}${isWindows() ? "\\" : "/"}${folderName.trim()}` : null;
  const pathShown = locationTooltip.tooltipProps.open && path !== null;

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
          onChange={(event) => {
            nameTyped.current = true;
            setFolderName(event.currentTarget.value);
          }}
          // A long name scrolls to its caret; at rest the tab shows its start.
          onBlur={(event) => { event.currentTarget.scrollLeft = 0; }}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? "new-workspace-error" : undefined}
          placeholder={DEFAULT_FOLDER_NAME}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={`field-sizing-content min-w-0 border-0 bg-transparent p-0 text-ellipsis text-sm font-medium text-ink placeholder:text-subtle ${nameError ? "shadow-[inset_0_-1px_0_var(--dohc-danger)] focus:shadow-[inset_0_-1px_0_var(--dohc-danger)]!" : ""}`}
        />
        <Pencil size={13} strokeWidth={1.9} aria-hidden className="shrink-0 text-subtle" />
      </label>
      {/* The open path sits over the tab, so the card rises above it. */}
      <div className={`dohc-elevated relative ${pathShown ? "z-4" : "z-2"} flex flex-col gap-4 rounded-xl rounded-tl-none border border-line bg-panel p-5`}>
        <div {...locationTooltip.hoverProps} className="relative flex min-w-0 items-center gap-2 text-subtle">
          <Folder size={13} strokeWidth={1.9} aria-hidden className="shrink-0" />
          <span data-testid="new-workspace-location" className="flex min-w-0 flex-1 text-[12px] leading-5 text-muted">
            {path ? <PathLine path={path} /> : <span className="truncate">{error ? "Choose a folder" : "…"}</span>}
          </span>
          {/* It stays live when no default arrived, so the person can still
              choose a folder by hand. */}
          <GhostButton
            aria-label="Change location"
            {...locationTooltip.focusProps}
            onClick={() => void chooseFolder()}
            className="-mr-2 shrink-0"
          >
            Change
          </GhostButton>
          {/* The path opens above its line, as wide as the card, so a long
              one takes few lines and covers only the tab. Clicks go through
              it, and it closes once the pointer leaves the line. The shared
              Tooltip opens below its holder, at most 16rem wide. */}
          <span
            id={locationTooltip.tooltipProps.id}
            role="tooltip"
            hidden={!pathShown}
            className="pointer-events-none absolute -inset-x-5 bottom-full pb-1"
          >
            <span className="dohc-popover block rounded-lg border border-line bg-panel px-2 py-1 text-left text-[12px] text-ink wrap-anywhere">
              {path}
            </span>
          </span>
        </div>

        {nameError || error ? (
          <p id="new-workspace-error" role="alert" className="-mt-2 text-xs leading-relaxed text-danger">
            {nameError ?? error}
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
