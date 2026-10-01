import { Lock, TriangleAlert } from "lucide-react";
import type { EngineDocSaveState } from "../collab/engineDocLease";

// One mark and one label map for every save state a person can see: the
// engine lease's ten states, the plain-text draft's three, the file
// inspector's `deleted`, and Settings' saving/saved/error. The storage unions
// stay where they are; this file only decides how each member is shown.
//
// The shape says what kind of state it is before the word is read. Filled
// means settled, a ring means dohc is still working, a lock means the file
// is held and no edit is lost, a triangle means the person has to act.
// Nothing animates, so reduced motion needs no special case.
//
// A `Record` over the union, so a new state is a compile error here until it
// has a label, and every label is one it can defend from code (see
// StateMark.test.tsx for what each may claim).
export type StateMarkKind = "settled" | "working" | "held" | "attention";

export type StatePresentation = {
  label: string;
  mark: StateMarkKind;
  // Absent where the label already says everything.
  title?: string;
};

export const DELETED_WITHOUT_SET_ASIDE_EDIT_NOTICE =
  "This file was deleted while you had it open. It is in the system trash, or this workspace's .dohc/trash.";

// dohc cannot tell whether the original was moved or deleted, only that
// another file now has its path.
export const REPLACED_WITHOUT_SET_ASIDE_EDIT_NOTICE =
  "Another file replaced this file while you had it open. Close this tab to open the file now at this path.";

// The states a save chip can show. `recovery`, `read-only-transition` and
// `too-large` are the shell's own, not the engine's: an unresolved set-aside
// draft beside a settled document, a document that went read-only under an
// edit, and a file the bounded read cut short so the editor is disabled.
export type SaveStateKey =
  | EngineDocSaveState
  | "recovery"
  | "read-only-transition"
  | "too-large";

export const SAVE_STATE: Record<SaveStateKey, StatePresentation> = {
  saved: { label: "Saved", mark: "settled" },
  "saved-to-host": {
    label: "Saved to host",
    mark: "working",
    title: "The session host accepted your edits. The local file may still be updating.",
  },
  "pending-share": {
    label: "Saved locally · Pending share",
    mark: "working",
    title: "Your edits are saved on this device. The shared file update is pending.",
  },
  saving: { label: "Saving…", mark: "working" },
  error: {
    label: "Couldn't save",
    mark: "attention",
    title:
      "Your edits are still here, but dohc can't confirm the file on disk matches them. Keep this document open and try another edit.",
  },
  "file-locked": {
    label: "File in use",
    mark: "held",
    title:
      "Another program has this file open, so dohc can't update it on disk. dohc has your edits saved and retries until the file is free.",
  },
  "read-only": {
    label: "Read-only",
    mark: "held",
    title: "This document is shared with you to read.",
  },
  "read-only-transition": {
    label: "Read-only",
    mark: "attention",
    title: "This document became read-only. Your edit was set aside in the notice below.",
  },
  "too-large": {
    label: "Read-only",
    mark: "held",
    title: "This file is too large to edit in dohc.",
  },
  "changed-on-disk": {
    label: "Changed on disk",
    mark: "attention",
    title: "This file changed outside dohc while it was open. Open History to restore your text.",
  },
  deleted: {
    label: "Deleted",
    mark: "attention",
    title: DELETED_WITHOUT_SET_ASIDE_EDIT_NOTICE,
  },
  "object-changed": {
    label: "Replaced",
    mark: "attention",
    title: REPLACED_WITHOUT_SET_ASIDE_EDIT_NOTICE,
  },
  recovery: {
    label: "Edit set aside",
    mark: "attention",
    title: "A set-aside edit is not saved. Copy or dismiss it in the notice below.",
  },
};

const MARK_TONE: Record<StateMarkKind, string> = {
  settled: "text-subtle",
  working: "text-subtle",
  held: "text-muted",
  attention: "text-danger",
};

function Mark(props: { kind: StateMarkKind }) {
  switch (props.kind) {
    case "settled":
      return <span aria-hidden className="size-2 shrink-0 rounded-full bg-current" />;
    case "working":
      return <span aria-hidden className="size-2 shrink-0 rounded-full border-[1.5px] border-current" />;
    case "held":
      return <Lock size={12} aria-hidden className="shrink-0" />;
    case "attention":
      return <TriangleAlert size={12} aria-hidden className="shrink-0" />;
  }
}

/** A save-state chip: the mark for its kind, then the label. `state` is the
 * store's own value and lands in `data-state` unchanged, so tests and the
 * shell keep reading it. `shown` picks the row to draw when it differs from
 * the stored state, such as a disabled editor over a `saved` draft. `title`
 * replaces the row's title when the caller knows more, such as the engine's
 * own save error. */
export function StateMark(props: {
  state: string;
  shown: SaveStateKey;
  title?: string;
  testId: string;
  className?: string;
}) {
  const presentation = SAVE_STATE[props.shown];
  return (
    <span
      data-testid={props.testId}
      data-state={props.state}
      title={props.title ?? presentation.title}
      // A 16px line box: the 11px face's default is 16.5px, and a half-pixel
      // chip moves everything under it by half a pixel.
      className={`inline-flex items-center gap-1.5 font-mono text-[11px] leading-4 ${MARK_TONE[presentation.mark]} ${props.className ?? ""}`}
    >
      <Mark kind={presentation.mark} />
      {presentation.label}
    </span>
  );
}
