import { ExternalLink, FileArchive, FileText, Lock, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineMomentDetailRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { momentDiffSides } from "./momentDiffSides";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import {OwnerRestoreDialog} from "../OwnerRestoreDialog";
import type { StopTarget } from "../StopAndRestoreDialog";
import { SectionLabel } from "../ui/controls";
import {
  UnifiedDiffLines,
  buildUnifiedDiffLines,
  computeTextDiff,
  type UnifiedDiffLine,
} from "./unifiedDiff";
import { EngineMomentSource, engineMomentSummary } from "./EngineHistory";
import { parseMomentDiffTabPath } from "./workbenchState";
import { hasBlockingModal } from "../modalFocus";
import { PanelLoading } from "./PanelLoading";
import { ipcErrorMessage } from "../ipcError";

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest(
      "[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']",
    ) !== null
  );
}

export type ActiveUndoHandler = {
  run: () => Promise<void>;
  acceptsEvent: (event: KeyboardEvent) => boolean;
};

// Engine history diff page: one MOMENT's
// before/after through the shared unified-diff rendering, with engine-routed
// restore. Restore returns the file to its state before this moment and
// records a forward "Restored <file>" moment; undo restores to before that
// moment — history is never rewritten.
export function EngineMomentDiffPage({
  workspaceId,
  tabPath,
  onBeforeRestore,
  onOpenFile,
  onPathResolved,
  registerActiveUndo,
  onRestored,
  onStopAndRestore,
}: {
  workspaceId: string;
  tabPath: string;
  // Settles drafts and queued collection writes, and pauses new cell edits
  // until the returned release runs — held across the restore IPC so no cell
  // edit lands between the drain and the lineage change.
  onBeforeRestore: () => Promise<() => void>;
  onOpenFile: (path: string) => void;
  onPathResolved: (momentId: string, path: string) => void;
  registerActiveUndo: (handler: ActiveUndoHandler | null) => void;
  onRestored: () => void;
  // Opens the shell's Stop and restore for a person the owner shared with,
  // or for the Edit share link that wrote this change.
  onStopAndRestore: (target: StopTarget) => void;
}) {
  const momentId = useMemo(() => parseMomentDiffTabPath(tabPath), [tabPath]);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; moment: EngineMomentDetailRecord | null }
    | { status: "error" }
  >({ status: "loading" });
  const [restoreState, setRestoreState] = useState<
    | { status: "idle" }
    | { status: "restoring" }
    | { status: "undoing" }
    | { status: "restored"; restored: "text" | "deleted"; message: string }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [sharedRestoreOpen, setSharedRestoreOpen] = useState(false);
  // The forward restore moment to undo against; null = nothing to undo.
  const [undoMomentId, setUndoMomentId] = useState<string | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const restoreInFlight = useRef(false);
  // Liveness: bumped when the tab changes/unmounts so a slow response can
  // never repaint another moment's page.
  const liveToken = useRef(0);

  useEffect(() => {
    const token = ++liveToken.current;
    if (!momentId) {
      setState({ status: "error" });
      return;
    }
    setState({ status: "loading" });
    void bridge()
      .readEngineMoment({ workspaceId, momentId })
      .then((result) => {
        if (token !== liveToken.current) return;
        if (result.moment) onPathResolved(momentId, result.moment.path);
        setState({ status: "ready", moment: result.moment });
      })
      .catch(() => {
        if (token !== liveToken.current) return;
        setState({ status: "error" });
      });
    return () => {
      liveToken.current += 1;
    };
  }, [momentId, onPathResolved, workspaceId]);
  useEffect(() => {
    setRestoreState({ status: "idle" });
    setConfirmRestoreOpen(false);
    setSharedRestoreOpen(false);
    setUndoMomentId(null);
  }, [tabPath]);

  const moment = state.status === "ready" ? state.moment : null;
  // The diff is the expensive part of this page, and a moment's bodies never
  // change while its tab is open. Build it once per moment: it used to run
  // twice per render — once for the counts, once for the lines — and a
  // hydrated 10 MiB body cost seconds each time.
  const prepared = useMemo(() => {
    if (!moment) return null;
    const sides = momentDiffSides(moment);
    const diff = computeTextDiff(sides.before, sides.after, 800);
    return { sides, diff, lines: buildUnifiedDiffLines(diff) };
  }, [moment]);
  const restoreBusy =
    restoreState.status === "restoring" || restoreState.status === "undoing";
  const canRestore = moment !== null && moment.operation !== "rename" && !undoMomentId;

  const undoRestore = useCallback(async () => {
    const target = undoMomentId;
    if (!target || restoreBusy || restoreInFlight.current) return;
    restoreInFlight.current = true;
    const token = liveToken.current;
    setRestoreState({ status: "undoing" });
    let releaseOperation: (() => void) | null = null;
    try {
      releaseOperation = await onBeforeRestore();
      const result = await bridge().restoreEngineMomentFile({
        workspaceId,
        momentId: target,
      });
      onRestored();
      if (token !== liveToken.current) return;
      setRestoreState({
        status: "restored",
        restored: result.restored,
        message:
          result.restored === "deleted"
            ? "Undid the restore by removing the file again. This was recorded in history."
            : "Undid the restore. This was recorded in history.",
      });
      setUndoMomentId(null);
    } catch (error) {
      if (token !== liveToken.current) return;
      setRestoreState({
        status: "error",
        message:
          ipcErrorMessage(error, "Could not undo this restore."),
      });
    } finally {
      releaseOperation?.();
      restoreInFlight.current = false;
    }
  }, [onBeforeRestore, onRestored, restoreBusy, undoMomentId, workspaceId]);

  useEffect(() => {
    if (!undoMomentId || restoreBusy) {
      registerActiveUndo(null);
      return;
    }
    registerActiveUndo({
      run: undoRestore,
      acceptsEvent: (event) => {
        if (isEditableShortcutTarget(event.target)) return false;
        const page = pageRef.current;
        const target = event.target instanceof Element ? event.target : null;
        const active =
          document.activeElement instanceof Element ? document.activeElement : null;
        const focusOwner = target ?? active;
        if (
          page &&
          focusOwner &&
          focusOwner !== document.body &&
          focusOwner !== document.documentElement &&
          !page.contains(focusOwner)
        ) {
          return false;
        }
        return !hasBlockingModal();
      },
    });
    return () => registerActiveUndo(null);
  }, [registerActiveUndo, restoreBusy, undoMomentId, undoRestore]);

  if (!momentId || state.status === "error") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-danger">
        Could not load this history diff.
      </div>
    );
  }
  if (state.status === "loading") {
    return <PanelLoading label="history diff" />;
  }
  if (!moment || !prepared) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-subtle">
        This change is no longer in the history record.
      </div>
    );
  }

  // Secret-backed file moment: metadata-only — no diff exists, the
  // body shows "Contents are protected" instead. Restore still works (it
  // rides the encrypted path end to end).
  const isProtected = moment.protected === true;
  // Who wrote this change directly, when the owner can stop them and restore
  // what they wrote: a person they shared with, or an Edit share link.
  const stopTarget: StopTarget | null = moment.namedAuthor
    ? { target: { kind: "person", userId: moment.namedAuthor.userId }, label: moment.namedAuthor.label }
    : moment.linkAuthor
      ? { target: { kind: "link", grantId: moment.linkAuthor.grantId }, label: "Edit link" }
      : null;
  // Each side presents by its own kind (see momentDiffSides).
  const {
    beforeIsBinary,
    afterIsBinary,
    bytesOnly,
    createdFile,
    byteLength: binaryByteLength,
  } = prepared.sides;
  const counts = isProtected || bytesOnly ? null : prepared.diff.counts;
  // Restore returns the before state, so its wording follows that side.
  const restoreDetail = createdFile
    ? "This change created the file, so restoring removes it from the folder. It stays in history and you can undo."
    : isProtected
      ? "The protected file will be returned to how it was before this change. Its contents stay encrypted and are never shown."
      : beforeIsBinary
        ? "The binary file will be returned byte-for-byte to how it was before this change."
      : "The file will be returned to how it was before this change.";
  // Restoring a create moment removes the file ("deleted"): no open-file
  // affordances for a file that is no longer in the folder (mirrors the
  // legacy HistoryDiffPage guard).
  const canOpenFile =
    restoreState.status === "restored" && restoreState.restored === "deleted"
      ? false
      : moment.operation !== "delete" ||
        (restoreState.status === "restored" && restoreState.restored === "text");
  const diffLines: UnifiedDiffLine[] = prepared.lines;

  const restoreFile = async () => {
    if (!canRestore || restoreBusy || restoreInFlight.current) return;
    restoreInFlight.current = true;
    const token = liveToken.current;
    setConfirmRestoreOpen(false);
    setRestoreState({ status: "restoring" });
    let releaseOperation: (() => void) | null = null;
    try {
      releaseOperation = await onBeforeRestore();
      const result = await bridge().restoreEngineMomentFile({
        workspaceId,
        momentId: moment.id,
      });
      onRestored();
      if (token !== liveToken.current) return;
      setRestoreState({
        status: "restored",
        restored: result.restored,
        message:
          result.restored === "deleted"
            ? "Removed the file this change created. Undo restore is available here."
            : "Restored the earlier state. Undo restore is available here.",
      });
      setUndoMomentId(result.restoredMomentId);
    } catch (error) {
      if (token !== liveToken.current) return;
      setRestoreState({
        status: "error",
        message:
          ipcErrorMessage(error, "Could not restore this file."),
      });
    } finally {
      releaseOperation?.();
      restoreInFlight.current = false;
    }
  };

  return (
    <section
      ref={pageRef}
      data-testid="engine-moment-diff-page"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg"
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-line bg-panel px-4 py-3">
        <div className="min-w-0 flex-1">
          <SectionLabel>History diff</SectionLabel>
          <h2 className="mb-0 mt-0.5 truncate text-[15px] font-semibold text-ink">
            {canOpenFile ? (
              <button
                type="button"
                data-testid="engine-diff-title-open-file"
                onClick={() => onOpenFile(moment.path)}
                className="max-w-full cursor-pointer truncate rounded text-left hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                title={`Open ${moment.path}`}
              >
                {moment.path}
              </button>
            ) : (
              moment.path
            )}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <span>
              {moment.operation === "delete"
                ? "Deleted"
                : createdFile
                  ? "Created"
                  : "Changed"}
            </span>
            <EngineMomentSource moment={moment} testId="engine-diff-source" />
            {counts ? (
              <span className="font-mono" data-testid="engine-diff-counts">
                +{counts.added} -{counts.removed}
              </span>
            ) : null}
          </div>
          <p
            data-testid="engine-diff-summary"
            className="mb-0 mt-1 truncate text-[11px] text-subtle"
          >
            {engineMomentSummary(moment)}
          </p>
          <div role="status" aria-live="polite">
            {restoreState.status === "restored" || restoreState.status === "error" ? (
              <p
                data-testid="engine-diff-restore-status"
                className={`mb-0 mt-1 text-[11px] ${
                  restoreState.status === "error" ? "text-danger" : "text-success"
                }`}
              >
                {restoreState.message}
              </p>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          data-testid="engine-diff-restore-file"
          onClick={() => setConfirmRestoreOpen(true)}
          disabled={!canRestore || restoreBusy}
          title={
            undoMomentId
              ? "This restore has already been applied"
              : canRestore
                ? "Restore this file to how it was before this change"
                : "This change can't be restored directly"
          }
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Undo2 size={12} aria-hidden />
          {restoreState.status === "restoring" ? "Restoring..." : "Restore..."}
        </button>
        {!isProtected && moment.contentKind !== "binary" && moment.path.toLowerCase().endsWith(".md") && <button
          type="button" data-testid="engine-diff-shared-restore" disabled={restoreBusy}
          onClick={() => setSharedRestoreOpen(true)}
          className="h-7 rounded-md border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
        >Restore shared file…</button>}
        {stopTarget ? <button
          type="button" data-testid="engine-diff-stop-and-restore" disabled={restoreBusy}
          onClick={() => onStopAndRestore(stopTarget)}
          className="h-7 rounded-md border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink disabled:opacity-50"
        >Stop and restore…</button> : null}
        {undoMomentId ? (
          <button
            type="button"
            data-testid="engine-diff-undo-restore"
            onClick={() => void undoRestore()}
            disabled={restoreBusy}
            className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Undo2 size={12} aria-hidden />
            {restoreState.status === "undoing" ? "Undoing..." : "Undo restore"}
          </button>
        ) : null}
        {canOpenFile ? (
          <button
            type="button"
            data-testid="engine-diff-open-file"
            onClick={() => onOpenFile(moment.path)}
            className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink"
          >
            <ExternalLink size={12} aria-hidden />
            Open file
          </button>
        ) : null}
      </header>
      <div className="min-h-0 overflow-auto overflow-x-hidden p-4">
        <section className="overflow-hidden rounded border border-line bg-bg shadow-sm">
          <div className="flex min-h-9 items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
            {isProtected ? (
              <Lock size={13} aria-hidden className="shrink-0 text-subtle" />
            ) : afterIsBinary ? (
              <FileArchive size={13} aria-hidden className="shrink-0 text-subtle" />
            ) : (
              <FileText size={13} aria-hidden className="shrink-0 text-subtle" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
              {moment.path}
            </span>
            {counts ? (
              <span className="shrink-0 font-mono text-[11px] text-subtle">
                +{counts.added} -{counts.removed}
              </span>
            ) : null}
          </div>
          {isProtected ? (
            <div
              data-testid="engine-diff-protected"
              className="flex flex-col items-center gap-1 px-4 py-10 text-center"
            >
              <Lock size={16} aria-hidden className="text-subtle" />
              <span className="text-sm text-muted">Contents are protected</span>
              <span className="text-xs text-subtle">
                dohc versions this file encrypted and never shows its contents
                in history, search, or comparisons.
              </span>
            </div>
          ) : bytesOnly ? (
            <div
              data-testid="engine-diff-binary"
              className="flex flex-col items-center gap-1 px-4 py-10 text-center"
            >
              <FileArchive size={16} aria-hidden className="text-subtle" />
              <span className="text-sm text-muted">Binary contents</span>
              <span className="text-xs text-subtle">
                {binaryByteLength} bytes are versioned byte-for-byte and are
                not shown in text diffs.
              </span>
            </div>
          ) : (
            <>
              {beforeIsBinary || afterIsBinary ? (
                <p
                  data-testid="engine-diff-binary-side"
                  className="m-0 border-b border-line bg-panel-2 px-3 py-2 text-[11px] leading-4 text-subtle"
                >
                  {afterIsBinary
                    ? `This file became a binary file. Its ${moment.afterBinary?.byteLength ?? 0} bytes are not shown in text diffs.`
                    : `This file was a binary file before this change. Its ${moment.beforeBinary?.byteLength ?? 0} bytes are not shown in text diffs.`}
                </p>
              ) : null}
              <UnifiedDiffLines lines={diffLines} testId="engine-diff-lines" />
            </>
          )}
        </section>
      </div>
      {sharedRestoreOpen && <OwnerRestoreDialog key={`${workspaceId}:${moment.path}`} workspaceId={workspaceId} path={moment.path}
        onClose={() => setSharedRestoreOpen(false)} onBeforeRestore={onBeforeRestore} onRestored={onRestored} />}
      {confirmRestoreOpen ? (
        <ConfirmDialog
          title="Restore this file?"
          confirmLabel="Restore"
          onCancel={() => setConfirmRestoreOpen(false)}
          onConfirm={() => void restoreFile()}
          testId="engine-diff-restore-confirm"
          cancelTestId="engine-diff-cancel-restore"
          confirmTestId="engine-diff-confirm-restore"
        >
            <p className="mb-0 mt-2 text-xs leading-5 text-muted">
              This only changes this one file and records a new history entry.
              Any edits you made since are saved into history first.
            </p>
            <p className="mb-0 mt-2 text-xs leading-5 text-muted">
              <span className="font-mono text-ink">{moment.path}</span>
              <br />
              {restoreDetail}
            </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
