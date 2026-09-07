import { Share2 } from "lucide-react";
import { bridge } from "./bridge";
import type { EngineDocSaveState } from "./collab/useEngineDoc";
import { IconButton, SectionLabel } from "./ui/controls";
import type { SaveState } from "./useAutosavedTextDraft";

// `actions` puts a view's controls (edit toggle, save state, presence) in the
// one document header — views never stack a second near-empty toolbar.
export function ViewHeader(props: {
  icon: React.ReactNode;
  path: string;
  label: string;
  onShare?: () => void;
  actions?: React.ReactNode;
}) {
  // Breadcrumb weighting: the folder path recedes, the file name carries ink.
  const slash = props.path.lastIndexOf("/");
  const dir = slash >= 0 ? props.path.slice(0, slash + 1) : "";
  const leaf = slash >= 0 ? props.path.slice(slash + 1) : props.path;
  return (
    <header className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[13px]">
      {props.icon}
      <span className="min-w-0 truncate font-mono">
        {dir ? <span className="text-subtle">{dir}</span> : null}
        <span className="font-medium text-ink">{leaf}</span>
      </span>
      <SectionLabel className="ml-auto shrink-0">
        {props.label}
      </SectionLabel>
      {props.onShare ? (
        <IconButton
          data-testid="file-share"
          aria-label="Share file"
          title="Share file"
          onClick={props.onShare}
        >
          <Share2 size={13} aria-hidden />
        </IconButton>
      ) : null}
      {props.actions}
    </header>
  );
}

export const DELETED_WITHOUT_SET_ASIDE_EDIT_NOTICE =
  "This file was deleted while you had it open. It is in the system trash, or this workspace's .dohc/trash.";

export type FileSaveState = SaveState | "deleted";

// Document + source-mode editor. Edits autosave on a short settle (and
// Ctrl/Cmd+S) through the bounded write IPC; the watcher then records the
// change into history like any other file change — the editor is just another
// writer, never a privileged one. Live co-editing (Yjs) layers onto this
// surface for shared workspaces in the collab step.
// What the engine save-state chip says, one row per state. A `Record` over the
// state union rather than a ternary chain, so a new save state is a
// compile-time omission instead of one that silently renders "Couldn't save".
// `recovery` is the shell's own state, not an engine one: an unresolved
// set-aside draft beside a settled document.
//
// `title` is absent where the label already says everything.
export const ENGINE_CHIP: Record<
  EngineDocSaveState | "recovery",
  { label: string; title?: string }
> = {
  saved: { label: "Saved" },
  saving: { label: "Saving…" },
  error: {
    label: "Couldn't save",
    title:
      "Your edits are still here, but dohc can't confirm the file on disk matches them. Keep this document open and try another edit.",
  },
  "file-locked": {
    label: "File in use",
    title:
      "Another program has this file open, so dohc can't update it on disk. dohc has your edits saved and retries until the file is free.",
  },
  "read-only": {
    label: "Read-only",
    title:
      "This document is shared with you to read. Your changes stay on screen but are not saved.",
  },
  "changed-on-disk": {
    label: "Changed on disk",
    title:
      "This file changed outside dohc while it was open. Open History to restore your text.",
  },
  deleted: {
    label: "Deleted",
    title: DELETED_WITHOUT_SET_ASIDE_EDIT_NOTICE,
  },
  recovery: {
    label: "Edit set aside",
    title:
      "A set-aside edit is not saved. Copy or dismiss it in the notice below.",
  },
};

export const READ_ONLY_TRANSITION_CHIP = {
  label: "Read-only",
  title:
    "This document became read-only. Your edit was set aside in the notice below.",
};

// The engine open hit its retry deadline. The document stays read-only
// — never the writable plain editor — with the reason stated and the retry
// offered where the user is looking.
export function EngineMayHoldDocumentNotice(props: {
  onRetry: () => void;
  // Is the document's content on screen? When the read failed too, it is
  // not — and "It is read-only for now" would promise read access to
  // content the user cannot see.
  contentShown: boolean;
}) {
  return (
    <div
      data-testid="engine-may-hold-document-notice"
      className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-4 py-1 text-[11px] text-warning"
    >
      {/* "document", the noun the editing controls beside this already use
          ("You can edit this document when it finishes opening.").

          No "in time": this notice answers every refusal `main` maps to
          `engineMayHoldDocument`, and only one of them is a timeout. A session
          the daemon would not release refuses immediately, and naming a cause
          the user did not hit sends them looking for a slow machine (#564,
          codex r20). What is true of all of them is the sentence below, and
          the retry is the same either way. */}
      <span>
        dohc could not open this document for editing.
        {props.contentShown ? " It is read-only for now." : ""}
      </span>
      <button
        type="button"
        onClick={props.onRetry}
        className="text-subtle hover:text-ink"
      >
        Try again
      </button>
    </div>
  );
}

export function EngineArtifactAssetsInvalidNotice(props: {
  workspaceId: string;
  path: string;
}) {
  return (
    <div
      data-testid="engine-artifact-assets-invalid-notice"
      className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-4 py-1 text-[11px] text-warning"
    >
      <span>
        dohc could not verify this drawing's images. The drawing is read-only.
      </span>
      <button
        type="button"
        onClick={() =>
          void bridge().openFileExternally({
            workspaceId: props.workspaceId,
            relativePath: props.path,
          })
        }
        className="text-subtle hover:text-ink"
      >
        Open externally
      </button>
    </div>
  );
}

export function AffordanceCard(props: {
  testId: string;
  title: string;
  body: string;
  openExternally?: { workspaceId: string; path: string };
}) {
  return (
    <div
      data-testid={props.testId}
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <span className="text-sm text-ink">{props.title}</span>
      <span className="max-w-md text-xs text-muted">{props.body}</span>
      {props.openExternally ? (
        <button
          type="button"
          onClick={() =>
            void bridge().openFileExternally({
              workspaceId: props.openExternally!.workspaceId,
              relativePath: props.openExternally!.path,
            })
          }
          className="rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
        >
          Open externally
        </button>
      ) : null}
    </div>
  );
}
