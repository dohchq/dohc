import { useEffect, useRef, useState } from "react";
import { useRecoveredDraftText } from "./collab/recoverySnapshot";
import {
  dismissOrphanedDraft,
  type OrphanedDraftRow,
} from "./orphanedDrafts";

// The path-independent recovery surface (#579 review, r5). The in-document
// notice needs a mounted inspector, and three states have none: a path whose
// read fails, a deleted file whose tab closed, and the crash screen. This
// list renders unresolved set-aside drafts with the same Copy/Dismiss the
// notice offers — so any surface that names the drafts (the close-warning
// dialog, the notice center) can also resolve them.
//
// The caller supplies the rows, because each one already has them: the notice
// center holds its workspace's drafts (another workspace's paths must not leak
// across a switch, #579 review r6) and the close guard holds the at-risk ones
// (a persisted draft comes back on the next launch, so listing it under "these
// are lost" would be false, #600). `showWorkspace` goes with the guard's
// cross-workspace list.
//
// The copy button repeats the quiet swap-and-restore rhythm of
// FileInspector's CopySourceButton on purpose, WITHOUT importing it: this
// component mounts above the error boundary (the close guard), and pulling
// the whole document-view module into that chunk for one button is the
// wrong trade. `recoverySnapshot` is the exception it makes room for: it
// carries the snapshot contract alone, and keeps the Tiptap projection behind
// the same dynamic import the deletion path uses.
function CopyDraftButton(props: { text: string }) {
  // A draft the projection never refined carries the document inside an
  // encoded comment. Copy hands back the document, never the encoding.
  const text = useRecoveredDraftText(props.text);
  const [label, setLabel] = useState<"Copy" | "Copied" | "Couldn't copy">(
    "Copy",
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      data-testid="recovery-list-copy"
      onClick={() => {
        const write = navigator.clipboard?.writeText(text);
        if (!write) return;
        void write
          .then(() => setLabel("Copied"))
          .catch(() => setLabel("Couldn't copy"))
          .then(() => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setLabel("Copy"), 1200);
          });
      }}
      className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
    >
      {label}
    </button>
  );
}

// Dismissing deletes the ONLY copy of the text — the store is the last place
// it exists — so the destructive step requires an explicit confirmation
// (#579 review, r6). Shared by this list and the in-document notice: one
// contract for one destructive action.
export function DismissDraftControls(props: { onDismiss: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        data-testid="recovery-dismiss"
        onClick={() => setConfirming(true)}
        className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
      >
        Dismiss
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span className="text-[11px] text-danger">Deletes the only copy.</span>
      <button
        type="button"
        data-testid="recovery-dismiss-confirm"
        onClick={props.onDismiss}
        className="rounded-md border border-danger px-2 py-0.5 text-[11px] text-danger transition-colors hover:bg-danger/10"
      >
        Dismiss edit
      </button>
      <button
        type="button"
        data-testid="recovery-dismiss-cancel"
        onClick={() => setConfirming(false)}
        className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
      >
        Keep
      </button>
    </span>
  );
}

export function RecoveryList(props: {
  rows: readonly OrphanedDraftRow[];
  showWorkspace?: boolean;
}) {
  if (props.rows.length === 0) return null;
  return (
    <ul data-testid="recovery-list" className="m-0 list-none p-0">
      {props.rows.map((row) => (
        <li
          key={`${row.workspaceId}:${row.path}:${row.draft.id}`}
          data-testid="recovery-list-row"
          className="flex items-center justify-between gap-2 border-b border-line py-1.5 text-[11px] last:border-b-0"
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="font-mono text-muted">{row.path}</span>
            {/* The GLOBAL list (the close dialog) can hold two workspaces'
                identical paths — name the workspace or the rows are
                indistinguishable (#579 review, r7). The label is the name
                the UI shows elsewhere (the shell registers it); scoped lists
                need none. */}
            {props.showWorkspace === true ? (
              <span
                data-testid="recovery-list-workspace"
                className="ml-2 font-mono text-[10px] text-subtle"
              >
                {row.workspaceLabel}
              </span>
            ) : null}
            {/* Most rows survive a quit (#600), and one kind does not: a
                secret-classified path never enters plaintext storage (#446),
                and a refused write leaves the text in memory. The lifetime
                belongs to the ROW, so the row carries it — a list that mixes
                the two (the notice center) would otherwise show a lost edit
                and a durable one as the same thing. No caller opts out: the
                close dialog lists only these, and repeating the fact there
                costs less than a flag a caller can set wrong. */}
            {row.persisted ? null : (
              <span
                data-testid="recovery-list-window-only"
                className="ml-2 text-[10px] text-warning"
              >
                Only in this window
              </span>
            )}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <CopyDraftButton text={row.draft.text} />
            <DismissDraftControls
              onDismiss={() =>
                dismissOrphanedDraft(row.workspaceId, row.path, row.draft.id)
              }
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
