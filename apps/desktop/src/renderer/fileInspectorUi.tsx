import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { CopyButton } from "./ui/CopyButton";
import { restoreRecoveryDraftText } from "./collab/recoverySnapshot";
import { dismissOrphanedDraft, useOrphanedDrafts } from "./orphanedDrafts";
import { DismissDraftControls } from "./RecoveryList";
import { Share2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { bridge } from "./bridge";
import type { EngineRemovalInProgress } from "./collab/useEngineDoc";
import { DocumentMenu } from "./DocumentMenu";
import { IconButton, SecondaryButton } from "./ui/controls";
import { KindGlyph } from "./ui/KindGlyph";

// The one header over every file view. It is final on the click frame: the
// kind's glyph comes from the path, the same glyph Explorer draws, and it says
// the kind, so loading, ready and
// failed views of one file draw the same header. `actions` are the view's
// controls, right of Share; a view that has controls draws them, disabled,
// while it loads or when it cannot open (DocumentControls). Share and the
// controls never shrink. `status` (a save state, "Opening…") sits left of
// them and gives way first: its words can change width without moving a
// control, and in a narrow pane it ends in an ellipsis. The status slot takes
// only the room the path leaves (flex-1 from a zero basis), so the file name
// stays whole until the status is down to its mark and an ellipsis; only then
// does the path shrink.
export function ViewHeader(props: {
  path: string;
  onShare?: () => void;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  // Breadcrumb weighting: the folder path recedes, the file name carries ink.
  const slash = props.path.lastIndexOf("/");
  const dir = slash >= 0 ? props.path.slice(0, slash + 1) : "";
  const leaf = slash >= 0 ? props.path.slice(slash + 1) : props.path;
  return (
    <header className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[13px]">
      <KindGlyph kind={fileKindForPath(props.path)} size={13} />
      <span className="min-w-0 truncate font-mono">
        {dir ? <span className="text-subtle">{dir}</span> : null}
        <span className="font-medium text-ink">{leaf}</span>
      </span>
      {/* 25px: the widest mark (12px), its gap and an ellipsis. */}
      <div className="flex min-w-[25px] flex-1 items-center justify-end gap-2 empty:min-w-0">{props.status}</div>
      {props.onShare ? (
        <IconButton
          data-testid="file-share"
          aria-label="Share file"
          title="Share file"
          onClick={props.onShare}
          className="shrink-0"
        >
          <Share2 size={13} aria-hidden />
        </IconButton>
      ) : null}
      {props.actions}
    </header>
  );
}

export const OPENING_TITLE = "You can edit this document when it finishes opening.";

// A document's controls, the same pair in every phase of an open: the mode
// toggle and the document menu. The toggle's box holds "Edit", "Source" and
// "Editor", so the words it says on its own never move the menu or Share;
// only a person's own click to "WYSIWYG" widens it. A truncated read never
// has the whole document to copy, so it has no menu, and the menu's place
// stays empty instead of closing up.
export function DocumentControls(props: {
  toggle: {
    label: string;
    testId?: string;
    pressed?: boolean;
    disabled?: boolean;
    title?: string;
    onClick?: () => void;
  };
  menu: ComponentProps<typeof DocumentMenu> | null;
}) {
  const { toggle } = props;
  return (
    <>
      <button
        type="button"
        data-testid={toggle.testId}
        aria-pressed={toggle.pressed}
        disabled={toggle.disabled}
        title={toggle.title}
        onClick={toggle.onClick}
        className="min-w-14 shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {toggle.label}
      </button>
      {props.menu ? <DocumentMenu {...props.menu} /> : <span aria-hidden className="size-6 shrink-0" />}
    </>
  );
}



// What each save state says and how it is marked lives in ui/StateMark.tsx,
// one map over every union a chip can show.

// The engine open hit its retry deadline. The document stays read-only
// — never the writable plain editor — with the reason stated and the retry
// offered where the user is looking.
export function EngineMayHoldDocumentNotice(props: {
  onRetry: () => void;
  // Is the document's content on screen? When the read failed too, it is
  // not — and "It is read-only for now" would promise read access to
  // content the user cannot see.
  contentShown: boolean;
  message?: string;
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
        {props.message ?? "dohc could not open this document for editing."}
        {!props.message && props.contentShown ? " It is read-only for now." : ""}
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

// The next step in a file view that cannot show its file: the system's app
// for it.
export function OpenExternallyButton(props: { workspaceId: string; path: string }) {
  return (
    <SecondaryButton
      onClick={() =>
        void bridge().openFileExternally({
          workspaceId: props.workspaceId,
          relativePath: props.path,
        })
      }
    >
      Open externally
    </SecondaryButton>
  );
}

export function OrphanedDraftNotices(props: {
  workspaceId: string;
  path: string;
  message?: string;
  // When set, the message explains only this draft; older drafts keep theirs.
  messageDraftId?: number | null;
}) {
  const drafts = useOrphanedDrafts(props.workspaceId, props.path);
  if (drafts.length === 0) return null;
  return (
    <div>
      {drafts.map((draft) => (
        <div
          key={draft.id}
          data-testid="orphaned-draft-notice"
          className="flex items-center justify-between gap-2 border-b border-line bg-panel px-4 py-1 text-[11px]"
        >
          <span className="text-danger">
            {(props.messageDraftId === undefined || props.messageDraftId === draft.id ? props.message : undefined) ??
              "This document reopened before your last edit saved. Copy your text to keep it."}
          </span>
          <div className="flex items-center gap-2">
            {/* Same rule as the recovery list's Copy: a draft the projection
                never refined carries the document inside an encoded comment,
                and the decode runs at the click. */}
            <CopyButton
              testId="orphaned-draft-copy"
              getText={() => restoreRecoveryDraftText(draft.text)}
            />
            {/* Deleting the only copy needs the explicit confirm step (#579
                review, r6) — the same control the recovery list uses. */}
            <DismissDraftControls
              onDismiss={() =>
                dismissOrphanedDraft(props.workspaceId, props.path, draft.id)
              }
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EngineRemovalInProgressNotice(props: {
  removal: EngineRemovalInProgress;
  onRetry: () => void;
}) {
  return (
    <div
      data-testid="engine-removal-in-progress-notice"
      data-operation={props.removal.operation}
      className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-4 py-1 text-[11px] text-warning"
    >
      <span>{props.removal.message} Wait for it to finish.</span>
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
