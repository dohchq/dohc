import type { SaveState } from "@dohc/workspace-contracts/save-state";
import { Suspense } from "react";
import { LazySourceCodeEditor } from "./LazySourceCodeEditor";
import { ViewActions } from "./fileInspectorUi";
import type { PendingTextUndo } from "./fileEditorUndo";
import type { SharedLocalDocument } from "./sharedLocalDocument";
import { SkeletonRows } from "./ui/SkeletonRows";
import { StateMark } from "./ui/StateMark";
import {
  useAutosavedTextDraft,
  type DraftFlush,
} from "./useAutosavedTextDraft";

// A text, code or JSON file's actions in its tab row: the save state and
// Share. The tab's icon already says what the file is.
export function TextViewActions(props: {
  testId: string;
  onShare?: () => void;
  // The app this file is the entry of: Run opens its local preview.
  onRun?: () => void;
  saveState: SaveState;
  truncated?: boolean;
  readOnly?: boolean;
}) {
  return (
    <ViewActions
      onShare={props.onShare}
      onRun={props.onRun}
      status={
        <StateMark
          testId={`${props.testId}-save-state`}
          truncate
          quietWhenCalm
          state={props.saveState}
          shown={props.readOnly ? "read-only" : props.truncated ? "too-large" : props.saveState}
        />
      }
    />
  );
}

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
  onShare,
  onRun,
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
  onShare?: () => void;
  onRun?: () => void;
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
      <TextViewActions
        testId={testId}
        onShare={onShare}
        onRun={onRun}
        saveState={editor.saveState}
        truncated={truncated}
        readOnly={readOnly}
      />
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
