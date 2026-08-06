import { useEffect, useRef, useState } from "react";
import {
  dismissOrphanedDraft,
  useAllOrphanedDrafts,
} from "./orphanedDrafts";

// The path-independent recovery surface (#579 review, r5). The in-document
// notice needs a mounted inspector, and three states have none: a path whose
// read fails, a deleted file whose tab closed, and the crash screen. This
// list renders unresolved set-aside drafts with the same Copy/Dismiss the
// notice offers — so any surface that names the drafts (the close-warning
// dialog, the notice center) can also resolve them.
//
// `workspaceId` filters to one workspace (the notice center — another
// workspace's paths must not leak across a switch, #579 review r6). The
// close guard passes none: the whole renderer dies at once, so every
// workspace's drafts are at stake there. It passes `atRiskOnly` instead,
// because a persisted draft is not at stake at all (#600) — it comes back on
// the next launch, and listing it under "these are lost" would be false.
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
  workspaceId?: string;
  atRiskOnly?: boolean;
}) {
  const rows = useAllOrphanedDrafts();
  const visible = rows.filter(
    (row) =>
      (props.workspaceId === undefined ||
        row.workspaceId === props.workspaceId) &&
      (props.atRiskOnly !== true || !row.persisted),
  );
  if (visible.length === 0) return null;
  return (
    <ul data-testid="recovery-list" className="m-0 list-none p-0">
      {visible.map((row) => (
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
            {props.workspaceId === undefined ? (
              <span
                data-testid="recovery-list-workspace"
                className="ml-2 font-mono text-[10px] text-subtle"
              >
                {row.workspaceLabel}
              </span>
            ) : null}
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
