import { Suspense } from "react";
import { LazySourceCodeEditor } from "./LazySourceCodeEditor";
import type { PendingTextUndo } from "./fileEditorUndo";
import type { SharedLocalDocument } from "./sharedLocalDocument";
import {
  useAutosavedTextDraft,
  type DraftFlush,
  type SaveState,
} from "./useAutosavedTextDraft";

export function TextEditorView({
  body,
  contentHash,
  contentRequestId,
  contentReadTicket,
  latestContentRequestId,
  refreshAfterConflict,
  testId,
  language,
  scrollLine,
  workspaceId,
  path,
  truncated,
  reopenKey,
  switchReadPending,
  switchUnresyncedRef,
  onSaveStateChange,
  registerDraftFlush,
  pendingUndo,
  onPendingUndoConsumed,
  localBuffer,
}: {
  reopenKey?: number;
  switchReadPending: boolean;
  switchUnresyncedRef: { current: boolean };
  body: string;
  contentHash: string | null;
  contentRequestId: number;
  contentReadTicket: number;
  latestContentRequestId: number;
  refreshAfterConflict: () => void;
  testId: string;
  language: string;
  workspaceId: string;
  path: string;
  truncated?: boolean;
  onSaveStateChange?: (state: SaveState) => void;
  registerDraftFlush?: (flush: DraftFlush | null) => void;
  pendingUndo?: PendingTextUndo;
  onPendingUndoConsumed?: (token: number) => void;
  localBuffer: SharedLocalDocument;
  // Search-result landing for read-only text views: scroll the
  // pre so the matched line sits in the upper third.
  scrollLine?: number;
}) {
  const editor = useAutosavedTextDraft({
    body,
    contentHash,
    contentRequestId,
    contentReadTicket,
    latestContentRequestId,
    refreshAfterConflict,
    workspaceId,
    path,
    disabled: truncated,
    reopenKey,
    switchReadPending,
    switchUnresyncedRef,
    onSaveStateChange,
    registerDraftFlush,
    localBuffer,
  });
  return (
    <div
      data-testid={testId}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="font-mono text-[11px] uppercase tracking-wide text-subtle">
          {language}
        </span>
        <span
          data-testid={`${testId}-save-state`}
          data-state={editor.saveState}
          className={`ml-auto text-[11px] ${editor.saveState === "error" ? "text-danger" : "text-subtle"}`}
        >
          {truncated
            ? "Read-only"
            : editor.saveState === "saved"
              ? "Saved"
              : editor.saveState === "saving"
                ? "Saving..."
                : "Couldn't save"}
        </span>
      </div>
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-subtle">
            Loading editor...
          </div>
        }
      >
        <LazySourceCodeEditor
          testId={`${testId}-editor`}
          value={editor.draft}
          valueRevision={editor.valueRevision}
          language={language}
          path={path}
          readOnly={truncated}
          scrollLine={scrollLine}
          pendingUndo={pendingUndo}
          onPendingUndoConsumed={onPendingUndoConsumed}
          onChange={editor.setDraft}
          onSave={() => void editor.saveNow()}
        />
      </Suspense>
    </div>
  );
}
