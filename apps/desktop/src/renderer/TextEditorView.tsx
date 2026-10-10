import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { Suspense } from "react";
import { LazySourceCodeEditor } from "./LazySourceCodeEditor";
import type { PendingTextUndo } from "./fileEditorUndo";
import type { SharedLocalDocument } from "./sharedLocalDocument";
import { SkeletonRows } from "./ui/SkeletonRows";
import { StateMark } from "./ui/StateMark";
import {
  useAutosavedTextDraft,
  type DraftFlush,
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
  readOnly,
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
  readOnly?: boolean;
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
    disabled: truncated || readOnly,
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
        <StateMark
          testId={`${testId}-save-state`}
          state={editor.saveState}
          shown={readOnly ? "read-only" : truncated ? "too-large" : editor.saveState}
          className="ml-auto"
        />
      </div>
      <Suspense fallback={<SkeletonRows layout="panel" label="Loading editor..." />}>
        <LazySourceCodeEditor
          testId={`${testId}-editor`}
          value={editor.draft}
          valueRevision={editor.valueRevision}
          language={language}
          path={path}
          readOnly={truncated || readOnly}
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
