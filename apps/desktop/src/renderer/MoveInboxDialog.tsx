import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Folder, X } from "lucide-react";
import { INBOX_COLLECTION_PATH, type InboxMoveResult } from "@dohc/workspace-contracts/inbox";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { readError } from "../ipc/errorWords";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { FieldError, IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";
import { useWorkspaceQuery } from "./workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "./workspace/workspaceSession";

export interface MoveInboxDialogProps {
  workspaceId: string;
  recordPath: string;
  recordTitle: string;
  onClose(): void;
  onMoved(result: InboxMoveResult, targetFolder: string): void;
}

function collectMovableFolders(
  files: ReadonlyArray<{ path: string }>,
  explicitFolders: readonly string[] = [],
): string[] {
  const folders = new Set<string>();
  const addFolder = (folder: string) => {
    if (!folder) return;
    if (folder === INBOX_COLLECTION_PATH || folder.startsWith(`${INBOX_COLLECTION_PATH}/`)) return;
    if (isSharedWithMePath(folder)) return;
    if (folder.split("/").some((segment) => segment.startsWith("."))) return;
    folders.add(folder);
  };
  for (const folder of explicitFolders) {
    const parts = folder.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      addFolder(parts.slice(0, depth).join("/"));
    }
  }
  for (const entry of files) {
    const parts = entry.path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      addFolder(parts.slice(0, depth).join("/"));
    }
  }
  return [...folders].sort((left, right) => left.localeCompare(right));
}

export function MoveInboxDialog({
  workspaceId,
  recordPath,
  recordTitle,
  onClose,
  onMoved,
}: MoveInboxDialogProps) {
  const titleId = useId();
  const errorId = useId();
  const [filter, setFilter] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    filterRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  const listing = useWorkspaceQuery(useWorkspaceSession(), {
    key: `inbox-move-folders:${workspaceId}`,
    load: () => bridge().listWorkspaceFiles({ workspaceId }),
  });

  const folders = useMemo(() => {
    const all = collectMovableFolders(listing.value?.files ?? [], listing.value?.folders ?? []);
    const q = filter.trim().toLowerCase();
    const candidates = ["", ...all];
    if (!q) return candidates;
    return candidates.filter((folder) =>
      (folder === "" ? "workspace root" : folder).toLowerCase().includes(q),
    );
  }, [listing.value, filter]);

  async function handleMove() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await bridge().inboxMove({
        workspaceId,
        item: recordPath,
        targetFolder: selectedFolder,
      });
      if (!alive.current) return;
      onMoved(result, selectedFolder);
    } catch (cause) {
      if (alive.current) setError(readError(cause).words);
    } finally {
      if (alive.current) setPending(false);
    }
  }

  return (
    <Overlay onClose={pending ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="move-inbox-dialog"
        className="dohc-elevated dohc-pop-in flex max-h-[80vh] w-[440px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-line bg-panel"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="m-0 text-sm font-semibold text-ink">
              Move to folder
            </h2>
            <p className="m-0 truncate text-[12px] text-muted">{recordTitle}</p>
          </div>
          <IconButton aria-label="Close" title="Close" disabled={pending} onClick={onClose}>
            <X size={14} strokeWidth={1.9} aria-hidden />
          </IconButton>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col gap-3 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void handleMove();
          }}
        >
          <input
            ref={filterRef}
            type="text"
            value={filter}
            disabled={pending}
            aria-label="Filter folders"
            placeholder="Filter folders…"
            onChange={(event) => setFilter(event.target.value)}
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-accent focus:outline-none"
          />

          <div
            role="listbox"
            aria-label="Destination folder"
            className="flex max-h-60 min-h-24 flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-bg p-1"
          >
            {folders.map((folder) => {
              const selected = selectedFolder === folder;
              const label = folder === "" ? "Workspace root" : folder;
              return (
                <button
                  key={folder || "__root__"}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={pending}
                  onClick={() => setSelectedFolder(folder)}
                  className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                    selected ? "bg-accent/15 font-medium text-ink" : "text-ink hover:bg-hover"
                  }`}
                >
                  <Folder size={14} strokeWidth={1.8} className="shrink-0 text-muted" aria-hidden />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
            {folders.length === 0 ? (
              <div className="px-2.5 py-4 text-center text-[12px] text-muted">
                No matching folders.
              </div>
            ) : null}
          </div>

          {error ? <FieldError id={errorId}>{error}</FieldError> : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <SecondaryButton type="button" disabled={pending} onClick={onClose}>
              Cancel
            </SecondaryButton>
            <PrimaryButton type="submit" disabled={pending}>
              {pending ? "Moving…" : "Move"}
            </PrimaryButton>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
