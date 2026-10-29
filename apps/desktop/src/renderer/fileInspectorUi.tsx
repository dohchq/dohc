import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { createPortal } from "react-dom";
import { CopyButton } from "./ui/CopyButton";
import { restoreRecoveryDraftText } from "./collab/recoverySnapshot";
import { dismissOrphanedDraft, isOrphanedDraftStored, useOrphanedDrafts } from "./orphanedDrafts";
import { DismissDraftControls } from "./RecoveryList";
import { Lock, Play, Share2 } from "lucide-react";
import { useEffect, useId, useState, type ComponentProps, type ReactNode } from "react";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { bridge } from "./bridge";
import type { EngineRemovalInProgress } from "./collab/useEngineDoc";
import type { ReportButtonError } from "./collections/useAutomationButtons";
import { DocumentMenu } from "./DocumentMenu";
import { IconButton, SecondaryButton } from "./ui/controls";
import { useTabRowActionsSlot } from "./workbench/tabRowActions";
import { useShownAfter } from "./ui/useShownAfter";

// A file view's actions, at the right end of its editor group's tab row: the
// tab already names the file, so no header repeats it above the page. They
// are final on the click frame, so loading, ready and failed views of one
// file draw the same actions. `actions` are the view's controls, right of
// Share; a view that has controls draws them, disabled, while it loads or
// when it cannot open (DocumentControls). Share and the controls never
// shrink. `status` (a save state that needs the person, a slow open's
// "Opening…") sits left of them and gives way first, before the tab names:
// its words can change width without moving a control, and in a narrow pane
// it ends in an ellipsis. A status with nothing visible, such as a calm save
// state or a quick open kept for screen readers, draws no box, so loading,
// ready and failed views take the same width. Outside an editor group, as on the states page, they draw
// in a row of their own.
//
// `onRun` is for an app's entry file: Run opens the app's local preview. It
// stands left of Share, so when it arrives nothing right of it moves.
export function ViewActions(props: {
  onShare?: () => void;
  onRun?: () => void;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  const slot = useTabRowActionsSlot();
  const content = (
    <>
      {/* 28px: the widest mark (12px), its gap and an ellipsis. A grid of
          minmax(auto, max-content) columns, so its words set how wide it can
          grow and each item's own minimum how narrow: a label (min-w-0)
          shrinks, and the row shrinks it to 28px before any tab name gives
          way, while Try again keeps its natural width. */}
      {props.status ? (
        <div
          data-view-status=""
          className="contents [&:has(>:not(.sr-only))]:grid [&:has(>:not(.sr-only))]:min-w-[28px] auto-cols-[minmax(auto,max-content)] grid-flow-col items-center justify-end gap-2"
        >
          {props.status}
        </div>
      ) : null}
      {props.onRun ? (
        <IconButton
          data-testid="file-run-app"
          aria-label="Run app"
          title="Run app"
          onClick={props.onRun}
          className="shrink-0"
        >
          <Play size={14} aria-hidden />
        </IconButton>
      ) : null}
      {props.onShare ? (
        <IconButton
          data-testid="file-share"
          aria-label="Share file"
          title="Share file"
          onClick={props.onShare}
          className="shrink-0"
        >
          <Share2 size={14} aria-hidden />
        </IconButton>
      ) : null}
      {props.actions}
    </>
  );
  if (slot === undefined) {
    return <div data-testid="view-actions" className="flex h-9 items-center justify-end gap-1 border-b border-line bg-panel pl-2 pr-1">{content}</div>;
  }
  return slot ? createPortal(content, slot) : null;
}

export const OPENING_TITLE = "You can edit this document when it finishes opening.";

// The wait before a slow open says so, the same wait as the loading lines'
// (styles.css, dohc-reveal-if-slow).
export const OPENING_WORDS_DELAY_MS = 150;

// A document still opening, as its save state slot says it. An open can last
// (until the engine's retry deadline, or while a guest waits for the host),
// and meanwhile the page shows the disk copy read-only, so a slow open says
// "Opening…" in words. A quick one keeps them for screen readers only: it
// draws nothing, and the actions stay where the ready document draws them.
export function OpeningState() {
  const slow = useShownAfter(true, OPENING_WORDS_DELAY_MS);
  return (
    <span
      data-testid="markdown-open-state"
      data-state="opening"
      role="status"
      title={OPENING_TITLE}
      className={slow ? "min-w-0 truncate text-[11px] leading-4 text-subtle" : "sr-only"}
    >
      Opening…
    </span>
  );
}

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
  // Actions left of Try again.
  children?: ReactNode;
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
      <span className="flex shrink-0 items-center gap-3">
        {props.children}
        <button
          type="button"
          onClick={props.onRetry}
          className="whitespace-nowrap text-subtle hover:text-ink"
        >
          Try again
        </button>
      </span>
    </div>
  );
}

// An Open externally control, then a lock and "Read-only copy" when the file
// is from someone else. Main answers by the open's own rule. Until it answers
// for this file, or when it can't, no words show, and the open decides alone.
export function OpenExternallyControl(props: {
  workspaceId: string;
  path: string;
  className?: string;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const asked = `${props.workspaceId}\u0000${props.path}`;
  const [answer, setAnswer] = useState<{ asked: string; readOnlyCopy: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => bridge().readExternalOpen({ workspaceId: props.workspaceId, relativePath: props.path }))
      .then(({ readOnlyCopy }) => {
        if (live) setAnswer({ asked, readOnlyCopy });
      }, () => undefined);
    return () => {
      live = false;
    };
  }, [asked, props.workspaceId, props.path]);
  const readOnlyCopy = answer?.asked === asked && answer.readOnlyCopy;
  return (
    <span className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap ${props.className ?? ""}`}>
      {props.children(readOnlyCopy ? id : undefined)}
      {readOnlyCopy ? (
        <span className="inline-flex items-center gap-1 text-subtle">
          <Lock aria-hidden size={12} className="shrink-0" />
          <span id={id}>Read-only copy</span>
        </span>
      ) : null}
    </span>
  );
}

// Opens a read-only note in the system's app for the file.
export function OpenExternallyLink(props: { workspaceId: string; path: string; onError?: ReportButtonError }) {
  const openExternally = () => {
    void bridge()
      .openFileExternally({ workspaceId: props.workspaceId, relativePath: props.path })
      .catch((error: unknown) =>
        props.onError?.("dohc could not open this document externally.", error, openExternally, `lossy-note-open:${props.path}`),
      );
  };
  return (
    <OpenExternallyControl workspaceId={props.workspaceId} path={props.path}>
      {(describedBy) => (
        <button
          type="button"
          data-testid="lossy-note-open-externally"
          aria-describedby={describedBy}
          onClick={openExternally}
          className="whitespace-nowrap text-subtle hover:text-ink"
        >
          Open externally
        </button>
      )}
    </OpenExternallyControl>
  );
}

// A lossy note (CONTEXT.md) opens read-only. The way forward is the system's
// app for the file, which edits it without dohc's editor.
export function LossyNoteNotice(props: {
  workspaceId: string;
  path: string;
  // The hash of the bytes the note was read from, which saving would rewrite.
  contentHash: string | null;
  onError?: ReportButtonError;
  // Binds the editor for this open, after the person confirms the warning.
  onEditAnyway?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Each opening of the warning asks History again: capture can record an
  // outside edit after the note opened.
  const [opened, setOpened] = useState(0);
  // History keeps the original only when its latest moment for the file
  // recorded these exact bytes. A path files.toml leaves out has none to
  // restore. Neither has a file capture has not recorded yet, or an outside
  // edit capture holds. History's own list for the file answers, as About's
  // does, with its rules applied. Until it answers, the warning says nothing
  // about History.
  const asked = `${props.workspaceId}\u0000${props.path}\u0000${props.contentHash}\u0000${opened}`;
  const [history, setHistory] = useState<{ asked: string; keeps: HistoryKeeps } | null>(null);
  useEffect(() => {
    if (!confirming) return;
    let live = true;
    void historyKeeps(props.workspaceId, props.path, props.contentHash)
      .then((keeps) => {
        if (live && keeps !== null) setHistory({ asked, keeps });
      }, () => undefined);
    return () => {
      live = false;
    };
  }, [confirming, asked, props.workspaceId, props.path, props.contentHash]);
  const historyLine = history?.asked !== asked ? null
    : history.keeps === "kept" ? "History keeps the original."
    : history.keeps === "untracked" ? "History does not track this file, so dohc can't restore the original."
    : "dohc could not confirm that History can restore the original.";
  return (
    <div
      data-testid="lossy-note-notice"
      role="status"
      className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-4 py-1 text-[11px] text-warning"
    >
      <span className="flex min-w-0 items-center gap-1">
        <Lock aria-hidden size={12} className="shrink-0" />
        dohc can't edit this document yet without changing parts it can't show.
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <OpenExternallyLink workspaceId={props.workspaceId} path={props.path} onError={props.onError} />
        {props.onEditAnyway ? (
          <button
            type="button"
            data-testid="lossy-note-edit-anyway"
            onClick={() => {
              setOpened((count) => count + 1);
              setConfirming(true);
            }}
            className="whitespace-nowrap text-subtle hover:text-ink"
          >
            Edit anyway
          </button>
        ) : null}
      </span>
      {confirming && props.onEditAnyway ? (
        <ConfirmDialog
          title="Edit this document anyway?"
          intent="danger"
          confirmLabel="Edit anyway"
          testId="lossy-note-edit-anyway-dialog"
          cancelTestId="lossy-note-edit-anyway-cancel"
          confirmTestId="lossy-note-edit-anyway-confirm"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            props.onEditAnyway?.();
          }}
        >
          <p className="mt-2 text-[13px] text-muted">
            Saving rewrites the parts dohc can't show, such as raw HTML or reference links.
            {historyLine ? ` ${historyLine}` : null}
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

type HistoryKeeps = "kept" | "untracked" | "not-recorded";

// Whether History's latest moment for the note holds the bytes `contentHash`
// names; null when History can't say.
async function historyKeeps(workspaceId: string, path: string, contentHash: string | null): Promise<HistoryKeeps | null> {
  const chats = await bridge().listFileChats({ workspaceId, path });
  if (!("fileObjectId" in chats)) return null;
  if (chats.fileObjectId === null) return "untracked";
  const moments = await bridge().listEngineMoments({ workspaceId, objectId: chats.fileObjectId, limit: 1 });
  if (!("moments" in moments)) return null;
  const latest = moments.moments[0];
  if (latest === undefined || contentHash === null) return "not-recorded";
  const read = await bridge().readEngineMoment({ workspaceId, momentId: latest.id });
  if ("status" in read) return read.status === "untracked" ? "untracked" : null;
  const text = read.moment?.afterText;
  if (typeof text !== "string") return "not-recorded";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex === contentHash ? "kept" : "not-recorded";
}

// Opens a file in the system's app for it. A failure goes to the shell's
// toasts and Notices, with Try again.
export function openExternally(props: { workspaceId: string; path: string; onError?: ReportButtonError }): void {
  void bridge()
    .openFileExternally({ workspaceId: props.workspaceId, relativePath: props.path })
    .catch((error: unknown) =>
      props.onError?.("dohc could not open this file externally.", error, () => openExternally(props), `open-externally:${props.path}`),
    );
}

export function EngineArtifactAssetsInvalidNotice(props: {
  workspaceId: string;
  path: string;
  onError?: ReportButtonError;
}) {
  return (
    <div
      data-testid="engine-artifact-assets-invalid-notice"
      className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-4 py-1 text-[11px] text-warning"
    >
      <span>
        dohc could not verify this drawing's images. The drawing is read-only.
      </span>
      <OpenExternallyControl workspaceId={props.workspaceId} path={props.path}>
        {(describedBy) => (
          <button
            type="button"
            aria-describedby={describedBy}
            onClick={() => openExternally(props)}
            className="text-subtle hover:text-ink"
          >
            Open externally
          </button>
        )}
      </OpenExternallyControl>
    </div>
  );
}

// The next step in a file view that cannot show its file: the system's app
// for it.
export function OpenExternallyButton(props: { workspaceId: string; path: string; onError?: ReportButtonError }) {
  return (
    <OpenExternallyControl workspaceId={props.workspaceId} path={props.path} className="text-xs">
      {(describedBy) => (
        <SecondaryButton aria-describedby={describedBy} onClick={() => openExternally(props)}>
          Open externally
        </SecondaryButton>
      )}
    </OpenExternallyControl>
  );
}

// Why the rich-text editor does not open a note, as its toast and Notices row
// read: its containers nest past the live document contract's limits, or
// lexing them passes its budget.
export const RICH_TEXT_REFUSED = {
  depth: "This file is nested too deeply for rich-text editing. Open the source to reduce nesting.",
  lexing: "This file has too much nested content for rich-text editing. Open the source to reduce nesting.",
} as const;

// In place of the editor, for a note it does not read as rich text: the
// source, or the system's app for it. The file stays as it is.
export function RichTextRefused(props: {
  workspaceId: string;
  path: string;
  limit: keyof typeof RICH_TEXT_REFUSED;
  onSource: () => void;
  onReport?: ReportButtonError;
}) {
  const { workspaceId, path, limit, onReport } = props;
  useEffect(() => {
    onReport?.(RICH_TEXT_REFUSED[limit], null, null, `rich-text-refused:${workspaceId}:${path}`);
  }, [workspaceId, path, limit, onReport]);
  return (
    <div
      role="group"
      aria-label={RICH_TEXT_REFUSED[limit]}
      data-testid="rich-text-refused"
      className="flex min-h-48 flex-1 items-center justify-center gap-2 px-6"
    >
      <SecondaryButton onClick={props.onSource}>Edit source</SecondaryButton>
      <OpenExternallyButton workspaceId={workspaceId} path={path} />
    </div>
  );
}

// The toast for a finished history replacement says the same first sentence.
export const REPLACED_HISTORY_DRAFT_NOTICE =
  "This document changed while you were editing. Your earlier edits are set aside here.";
// So does the notice for a save refused because the file is gone.
export const DELETED_FILE_DRAFT_NOTICE = "The file was moved or deleted outside dohc. Copy your text to keep it.";

export function OrphanedDraftNotices(props: {
  workspaceId: string;
  path: string;
  message?: string;
  // When set, the message explains only this draft; older drafts keep theirs.
  messageDraftId?: number | null;
  // Drafts a finished history replacement set aside, where `message` does not
  // explain them.
  replacedDraftIds?: readonly number[];
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
              (draft.recovery?.reason === "deleted"
                ? DELETED_FILE_DRAFT_NOTICE
                // Until storage keeps the draft, a copy is still the way to keep it.
                : props.replacedDraftIds?.includes(draft.id) && isOrphanedDraftStored(draft.id)
                  ? REPLACED_HISTORY_DRAFT_NOTICE
                  : "This document reopened before your last edit saved. Copy your text to keep it.")}
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
