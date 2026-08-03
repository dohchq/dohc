import { useEffect, useRef, useState } from "react";
import {
  dismissOrphanedDraft,
  useAllOrphanedDrafts,
} from "./orphanedDrafts";

// The path-independent recovery surface (#579 review, r5). The in-document
// notice needs a mounted inspector, and three states have none: a path whose
// read fails, a deleted file whose tab closed, and the crash screen. This
// list renders EVERY unresolved set-aside draft, across workspaces, with the
// same Copy/Dismiss the notice offers — so any surface that names the drafts
// (the close-warning dialog, the notice center) can also resolve them.
//
// The copy button repeats the quiet swap-and-restore rhythm of
// FileInspector's CopySourceButton on purpose, WITHOUT importing it: this
// component mounts above the error boundary (the close guard), and pulling
// the whole document-view module into that chunk for one button is the
// wrong trade.
function CopyDraftButton(props: { text: string }) {
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
        const write = navigator.clipboard?.writeText(props.text);
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

export function RecoveryList() {
  const rows = useAllOrphanedDrafts();
  if (rows.length === 0) return null;
  return (
    <ul data-testid="recovery-list" className="m-0 list-none p-0">
      {rows.map((row) => (
        <li
          key={`${row.workspaceId}:${row.path}:${row.draft.id}`}
          data-testid="recovery-list-row"
          className="flex items-center justify-between gap-2 border-b border-line py-1.5 text-[11px] last:border-b-0"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-muted">
            {row.path}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <CopyDraftButton text={row.draft.text} />
            <button
              type="button"
              data-testid="recovery-list-dismiss"
              onClick={() =>
                dismissOrphanedDraft(row.workspaceId, row.path, row.draft.id)
              }
              className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
            >
              Dismiss
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
