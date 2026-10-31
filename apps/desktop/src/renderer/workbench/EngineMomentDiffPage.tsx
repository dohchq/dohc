import { ChevronDown, ChevronUp, FileArchive, FileText, Lock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isCaptureRecoveryOrigin } from "@dohc/workspace-contracts/engine";
import type { EngineMomentDetailRecord, HistoryPolicyUnreadableResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { HistoryHiddenState, HistoryUntrackedState } from "./HistoryPolicyStates";
import { momentDiffSides } from "./momentDiffSides";
import { Menu, type MenuItem } from "../ui/Menu";
import {OwnerRestoreDialog} from "../OwnerRestoreDialog";
import type { StopTarget } from "../StopAndRestoreDialog";
import { CopyButton } from "../ui/CopyButton";
import {
  DiffCounts,
  UnifiedDiffLines,
  buildUnifiedDiffLines,
  computeTextDiff,
  type UnifiedDiffLine,
} from "./unifiedDiff";
import { MomentAuthor, MomentName, OriginMark, fileMomentSummary, type MomentSteps } from "./EngineHistory";
import { formatChatTime } from "../time";
import { parseTab } from "./workbenchState";
import { SkeletonRows } from "../ui/SkeletonRows";
import { IconButton, PrimaryButton, SecondaryButton } from "../ui/controls";

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

// A step arrow. At the end of the file's History it reads as disabled but
// keeps focus, and its action does nothing.
const STEP_ARROW =
  "size-7 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-subtle";

// The change's file, its folder quieter than its name.
function MomentPath({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <>
      {slash >= 0 ? <span className="text-muted">{path.slice(0, slash + 1)}</span> : null}
      <span className="font-semibold">{path.slice(slash + 1)}</span>
    </>
  );
}

export type ActiveUndoHandler = {
  run: () => Promise<void>;
  acceptsEvent: (event: KeyboardEvent) => boolean;
};

// Who a change credits. Account names can arrive after the change is read,
// so the page refreshes these without building the change's diff again.
type MomentCredit = {
  namedAuthor: EngineMomentDetailRecord["namedAuthor"];
  authorLabels: EngineMomentDetailRecord["authorLabels"];
};

// Engine history diff page: one MOMENT's
// before/after through the shared unified-diff rendering, with engine-routed
// restore. Restore returns the file to its state before this moment and
// records a forward "Restored <file>" moment; undo restores to before that
// moment — history is never rewritten.
export function EngineMomentDiffPage({
  workspaceId,
  tabPath,
  readOnly = false,
  onBeforeRestore,
  onOpenFile,
  onPathResolved,
  registerActiveUndo,
  onRestored,
  onStopAndRestore,
  onError,
  onSettled,
  historyAnswer,
  onReopenRestore,
  restoreRequested,
  onRestoreRequestTaken,
  steps,
  onOpenMoment,
}: {
  workspaceId: string;
  tabPath: string;
  // A shared view shows the change its share imported and offers no restore.
  readOnly?: boolean;
  // Settles drafts and queued collection writes, and pauses new cell edits
  // until the returned release runs — held across the restore IPC so no cell
  // edit lands between the drain and the lineage change.
  onBeforeRestore: () => Promise<() => void>;
  onOpenFile: (path: string) => void;
  // The tab's title names the change's path, or nothing once History's rules
  // hide the change.
  onPathResolved: (momentId: string, path: string | null) => void;
  registerActiveUndo: (handler: ActiveUndoHandler | null) => void;
  onRestored: (momentId?: string) => void;
  // Opens the shell's Stop and restore for a person the owner shared with,
  // or for the Edit share link that wrote this change.
  onStopAndRestore: (target: StopTarget) => void;
  // A failed restore or undo goes to the shell's toast and Notices row. A
  // later success clears that row.
  onError: (fallback: string, error: unknown, retry: () => void, identity: string, path: string) => void;
  onSettled: (identity: string) => void;
  // The shell's latest History answer. Each new one reads this change again,
  // because the rules that decide whether History shows it may have changed.
  historyAnswer: object | null;
  // Try again on a failed restore runs it from this page: the shell opens
  // this tab and sets `restoreRequested`, and the page restores once a fresh
  // read shows the change can still be restored.
  onReopenRestore: (momentId: string, path: string) => void;
  restoreRequested: boolean;
  onRestoreRequestTaken: () => void;
  // The older and newer change to this file in the loaded History, which
  // the page opens in its place with its arrows or [ and ].
  steps?: MomentSteps | undefined;
  onOpenMoment?: (momentId: string, filePath: string) => void;
}) {
  const momentId = useMemo(() => {
    const tab = parseTab(tabPath);
    return tab.kind === "momentDiff" ? tab.momentId : null;
  }, [tabPath]);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; moment: EngineMomentDetailRecord | null; credit: MomentCredit }
    | { status: "hidden"; result: HistoryPolicyUnreadableResult }
    | { status: "untracked" }
    | { status: "error" }
  >({ status: "loading" });
  // Bumped by Try again on a hidden or untracked page, to read the change again.
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => bridge().onHistoryNamesChanged?.(event => {
    if (event.workspaceId === workspaceId) setReadAttempt(attempt => attempt + 1);
  }), [workspaceId]);
  const [restoreState, setRestoreState] = useState<
    | { status: "idle" }
    | { status: "restoring" }
    | { status: "undoing" }
    | { status: "restored"; restored: "text" | "deleted"; message: string; undoOffered: boolean }
  >({ status: "idle" });
  const [moreOpen, setMoreOpen] = useState(false);
  const [sharedRestoreOpen, setSharedRestoreOpen] = useState(false);
  // The forward restore moment to undo against; null = nothing to undo.
  const [undoMomentId, setUndoMomentId] = useState<string | null>(null);
  // Restore and Undo restore take each other's place when one finishes, so
  // a press on one hands the focus to the other, unless focus has moved on.
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const actionPressed = useRef(false);
  useEffect(() => {
    if (!actionPressed.current) return;
    actionPressed.current = false;
    if (document.activeElement === null || document.activeElement === document.body) actionRef.current?.focus();
  }, [undoMomentId]);
  const pageRef = useRef<HTMLElement | null>(null);
  const restoreInFlight = useRef(false);
  // Liveness of the change this page shows: bumped when the tab changes or
  // the page unmounts, so a slow restore can never repaint another change.
  const liveToken = useRef(0);
  // Only the newest read may set what the page shows; a newer History answer
  // or Try again makes every earlier read stale.
  const readToken = useRef(0);
  // The change the page has an answer for. Reading it again keeps that
  // answer on screen until the new one arrives.
  const answeredFor = useRef<string | null>(null);
  // A restore request from the shell is settled only by a read issued after
  // it arrived: History's rules may hide the change since the page last read.
  // "taken" waits for the shell to clear the request.
  const restoreRequest = useRef<{ after: number } | "taken" | null>(null);
  const [requestAnswered, setRequestAnswered] = useState(0);

  useEffect(() => () => {
    liveToken.current += 1;
  }, [momentId, workspaceId]);
  useEffect(() => {
    const read = ++readToken.current;
    if (!momentId) {
      setState({ status: "error" });
      return;
    }
    const key = `${workspaceId}\0${momentId}`;
    if (answeredFor.current !== key) setState({ status: "loading" });
    void bridge()
      .readEngineMoment({ workspaceId, momentId })
      .then((result) => {
        if (read !== readToken.current) return;
        answeredFor.current = key;
        const request = restoreRequest.current;
        if (request !== null && request !== "taken") setRequestAnswered(read);
        if ("status" in result) {
          // The tab no longer names the file, so it shows only that a change exists.
          onPathResolved(momentId, null);
          setMoreOpen(false);
          setSharedRestoreOpen(false);
          setState(result.status === "untracked" ? { status: "untracked" } : { status: "hidden", result });
          return;
        }
        if (result.moment) onPathResolved(momentId, result.moment.path);
        const next = result.moment;
        // A change never changes, so reading the same one again keeps the
        // diff already built for it. Only its authors' names can change.
        const credit: MomentCredit = { namedAuthor: next?.namedAuthor, authorLabels: next?.authorLabels };
        setState((current) => {
          if (current.status === "ready" && next !== null && current.moment?.id === next.id) {
            if (JSON.stringify(current.credit) === JSON.stringify(credit)) return current;
            return { ...current, credit };
          }
          return { status: "ready", moment: next, credit };
        });
      })
      .catch(() => {
        if (read !== readToken.current) return;
        // A failed re-read leaves the last answer on screen, which cannot
        // settle a restore request. Only a read issued after the request may
        // drop it, as only such a read may answer it.
        const request = restoreRequest.current;
        if (request !== null && request !== "taken" && read > request.after) {
          restoreRequest.current = "taken";
          onRestoreRequestTaken();
        }
        setState((current) => (current.status === "loading" ? { status: "error" } : current));
      });
    return () => {
      readToken.current += 1;
    };
  }, [historyAnswer, momentId, onPathResolved, onRestoreRequestTaken, readAttempt, workspaceId]);
  useEffect(() => {
    setRestoreState({ status: "idle" });
    setMoreOpen(false);
    setSharedRestoreOpen(false);
    setUndoMomentId(null);
  }, [tabPath]);
  // A step reads the next change in this page's place, which drops focus
  // while it loads. Focus goes back to the step's arrow, so the next step
  // needs no click. At either end that arrow stays focusable, so the page
  // keeps focus and the other bracket still steps back. Only the answer for
  // the change it steps to returns focus: a late or repeated answer for the
  // change it left must not spend it. If the tab opens any other change
  // first, the step gives up its focus.
  const stepFocus = useRef<{ direction: "newer" | "older"; key: string } | null>(null);
  useEffect(() => {
    if (stepFocus.current?.key !== `${workspaceId}\0${momentId}`) stepFocus.current = null;
  }, [momentId, workspaceId]);
  useEffect(() => {
    const step = stepFocus.current;
    if (state.status === "loading" || step === null || answeredFor.current !== step.key) return;
    stepFocus.current = null;
    pageRef.current?.querySelector<HTMLButtonElement>(`[data-testid="engine-diff-${step.direction}"]`)?.focus();
  }, [state]);

  const diffMoment = state.status === "ready" ? state.moment : null;
  const moment = useMemo(() => state.status === "ready" && state.moment
    ? { ...state.moment, ...state.credit }
    : null, [state]);
  // The diff is the expensive part of this page, and a moment's bodies never
  // change while its tab is open. Build it once per moment: it used to run
  // twice per render — once for the counts, once for the lines — and a
  // hydrated 10 MiB body cost seconds each time.
  const prepared = useMemo(() => {
    if (!diffMoment) return null;
    const sides = momentDiffSides(diffMoment);
    const diff = computeTextDiff(sides.before, sides.after, 800);
    return { sides, diff, lines: buildUnifiedDiffLines(diff) };
  }, [diffMoment]);
  const restoreBusy =
    restoreState.status === "restoring" || restoreState.status === "undoing";
  const canRestore = moment !== null && moment.operation !== "rename" && !undoMomentId;

  // One restore through the engine. Restore returns the file to before this
  // change, and Undo to before the restore it recorded; each records a new
  // change. `token` is the page the person asked from. A Try again from
  // Notices keeps it, so it repaints this page only while the page still
  // shows this change.
  const runRestore = useCallback(async (
    kind: "restore" | "undo",
    target: string,
    path: string,
    token: number,
  ): Promise<void> => {
    if (restoreInFlight.current) return;
    restoreInFlight.current = true;
    const live = () => token === liveToken.current;
    const identity = `history-restore:${path}`;
    if (live()) setRestoreState({ status: kind === "undo" ? "undoing" : "restoring" });
    let releaseOperation: (() => void) | null = null;
    try {
      releaseOperation = await onBeforeRestore();
      const result = await bridge().restoreEngineMomentFile({ workspaceId, momentId: target });
      onRestored(target);
      onSettled(identity);
      if (!live()) return;
      setRestoreState({
        status: "restored",
        restored: result.restored,
        message: kind === "undo"
          ? result.restored === "deleted"
            ? "Undid the restore by removing the file again. This was recorded in history."
            : "Undid the restore. This was recorded in history."
          : result.restored === "deleted"
            ? "Removed the file this change created."
            : "Restored the earlier state.",
        undoOffered: kind !== "undo",
      });
      setUndoMomentId(kind === "undo" ? null : result.restoredMomentId);
    } catch (error) {
      onError(
        kind === "undo" ? `dohc could not undo the restore of ${path}.` : `dohc could not restore ${path}.`,
        error,
        // History's rules may hide the change by the time the person tries
        // again, so a restore runs again from its page, after a fresh read.
        // Undo puts back the file's state just before the restore, so it runs
        // again as it is.
        kind === "undo" ? () => void runRestore(kind, target, path, token) : () => onReopenRestore(target, path),
        identity,
        path,
      );
      if (live()) setRestoreState({ status: "idle" });
    } finally {
      releaseOperation?.();
      restoreInFlight.current = false;
    }
  }, [onBeforeRestore, onError, onReopenRestore, onRestored, onSettled, workspaceId]);

  const undoRestore = useCallback(async () => {
    if (!undoMomentId || !moment || restoreBusy) return;
    await runRestore("undo", undoMomentId, moment.path, liveToken.current);
  }, [moment, restoreBusy, runRestore, undoMomentId]);

  // The shell asked to restore this change again, from a failed restore's
  // Try again. The page reads the change again first, and the request is
  // taken on that answer: the restore runs only if History still shows the
  // change and it can be restored.
  useEffect(() => {
    if (!restoreRequested) {
      restoreRequest.current = null;
      return;
    }
    const request = restoreRequest.current;
    if (request === "taken") return;
    if (request === null) {
      restoreRequest.current = { after: readToken.current };
      setReadAttempt((attempt) => attempt + 1);
      return;
    }
    if (requestAnswered <= request.after) return;
    restoreRequest.current = "taken";
    if (state.status === "ready" && state.moment && canRestore && !restoreBusy) {
      void runRestore("restore", state.moment.id, state.moment.path, liveToken.current);
    }
    onRestoreRequestTaken();
  }, [canRestore, onRestoreRequestTaken, requestAnswered, restoreBusy, restoreRequested, runRestore, state]);

  useEffect(() => {
    if (!undoMomentId || restoreBusy || !moment) {
      registerActiveUndo(null);
      return;
    }
    registerActiveUndo({
      // The Undo shortcut on Undo restore hands the focus back as a press does.
      run: () => {
        if (document.activeElement === actionRef.current) actionPressed.current = true;
        return undoRestore();
      },
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
        return true;
      },
    });
    return () => registerActiveUndo(null);
  }, [moment, registerActiveUndo, restoreBusy, undoMomentId, undoRestore]);

  // Try again shows that it is reading, as the History panel's does.
  const readAgain = () => {
    setState({ status: "loading" });
    setReadAttempt((attempt) => attempt + 1);
  };

  if (!momentId || state.status === "error") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-danger">
        Could not load this history diff.
      </div>
    );
  }
  if (state.status === "loading") {
    return <SkeletonRows layout="panel" label="Loading history diff..." />;
  }
  if (state.status === "hidden") {
    return (
      <HistoryHiddenState
        testId="engine-diff-hidden"
        result={state.result}
        onRetry={readAgain}
      />
    );
  }
  if (state.status === "untracked") {
    return (
      <HistoryUntrackedState
        testId="engine-diff-untracked"
        onRetry={readAgain}
      />
    );
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
  // what they wrote: a person they shared with, or an Edit share link. Only
  // the relay's direct-write lane carries such a change in, as "sync"; that
  // lane's ledger is what Stop and restore reverts. A live document's change
  // names its collaborator too, and restores through Restore shared file.
  const directWrite = moment.origin === "sync";
  const stopTarget: StopTarget | null = directWrite && moment.namedAuthor
    ? { target: { kind: "person", userId: moment.namedAuthor.userId }, label: moment.namedAuthor.label }
    : directWrite && moment.linkAuthor
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
  // A recovery change's before side is the typing capture kept.
  const keptTyping = isCaptureRecoveryOrigin(moment.origin) ? prepared.sides.before : undefined;

  const restoreFile = async () => {
    if (!canRestore || restoreBusy) return;
    await runRestore("restore", moment.id, moment.path, liveToken.current);
  };
  const recordedAt = formatChatTime(moment.recordedAtMs);
  // What the change did; the title already names the file.
  const summary = createdFile && !moment.summary ? "Created" : fileMomentSummary(moment);
  // The rarer ways back, and the file itself, wait behind More.
  const moreItems: MenuItem[] = [
    ...(!readOnly && !isProtected && moment.contentKind !== "binary" && moment.path.toLowerCase().endsWith(".md")
      ? [{ id: "shared-restore", label: "Restore shared file…", testId: "engine-diff-shared-restore", disabled: restoreBusy, onSelect: () => setSharedRestoreOpen(true) }]
      : []),
    ...(!readOnly && stopTarget
      ? [{ id: "stop-and-restore", label: "Stop and restore…", testId: "engine-diff-stop-and-restore", disabled: restoreBusy, onSelect: () => onStopAndRestore(stopTarget) }]
      : []),
    ...(canOpenFile ? [{ id: "open-file", label: "Open file", testId: "engine-diff-open-file", onSelect: () => onOpenFile(moment.path) }] : []),
  ];
  const stepTo = (direction: "newer" | "older") => {
    const step = steps?.[direction];
    if (!step || !onOpenMoment) return;
    stepFocus.current = { direction, key: `${workspaceId}\0${step.momentId}` };
    onOpenMoment(step.momentId, step.path);
  };

  return (
    <section
      ref={pageRef}
      data-testid="engine-moment-diff-page"
      data-moment-id={moment.id}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg"
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || isEditableShortcutTarget(event.target)) return;
        const direction = event.key === "[" ? "older" : event.key === "]" ? "newer" : null;
        if (direction === null || !steps?.[direction]) return;
        event.preventDefault();
        stepTo(direction);
      }}
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
        <div className="grid min-w-0 flex-1 grid-cols-[18px_minmax(0,1fr)] items-center gap-x-2">
          <span aria-hidden className="grid place-items-center text-subtle">
            {isProtected ? <Lock size={14} /> : afterIsBinary ? <FileArchive size={14} /> : <FileText size={14} />}
          </span>
          <h2 className="m-0 min-w-0 truncate text-[14px] font-normal leading-7 text-ink">
            {canOpenFile ? (
              <button
                type="button"
                data-testid="engine-diff-title-open-file"
                onClick={() => onOpenFile(moment.path)}
                className="max-w-full cursor-pointer truncate rounded text-left hover:text-accent"
                title={`Open ${moment.path}`}
              >
                <MomentPath path={moment.path} />
              </button>
            ) : (
              <MomentPath path={moment.path} />
            )}
          </h2>
          <MomentAuthor moment={moment} fallback={<OriginMark moment={moment} />} />
          <div className="flex min-w-0 items-center gap-2 text-[12px] text-subtle">
            <MomentName moment={moment} testId="engine-diff-source" className="text-[13px] font-medium leading-5 text-ink" />
            <time dateTime={recordedAt.iso} className="shrink-0 tabular-nums">{recordedAt.label}</time>
            {counts ? <DiffCounts counts={counts} testId="engine-diff-counts" /> : null}
          </div>
          <p data-testid="engine-diff-summary" className="col-start-2 m-0 mt-1 truncate text-[12px] text-muted">
            {summary}
          </p>
          <div role="status" aria-live="polite" className="col-start-2">
            {restoreState.status === "restored" ? (
              <p data-testid="engine-diff-restore-status" className="m-0 mt-1 text-[12px] text-success">
                {restoreState.message}
                {/* Undo restore sits beside the line, so only a screen
                    reader is told it is there. */}
                {restoreState.undoOffered ? <span className="sr-only"> Undo restore is available here.</span> : null}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Kept typing's way back into a file History Restore refuses:
              the whole file as it was with the typing, to replace the
              file's text with. */}
          {keptTyping !== undefined ? (
            <CopyButton size="header" label="Copy your version" testId="engine-diff-copy-typing" getText={() => keptTyping} />
          ) : null}
          {readOnly ? null : undoMomentId ? (
            <SecondaryButton
              ref={actionRef}
              size="compact"
              data-testid="engine-diff-undo-restore"
              onClick={() => { actionPressed.current = true; void undoRestore(); }}
              disabled={restoreBusy}
            >
              {restoreState.status === "undoing" ? "Undoing…" : "Undo restore"}
            </SecondaryButton>
          ) : (
            // Restore records a new change and offers Undo, so it asks
            // nothing first. It returns the file to before this change, and
            // its name says so, as its status line does; its title says what
            // that does to the file.
            <PrimaryButton
              ref={actionRef}
              size="compact"
              data-testid="engine-diff-restore-file"
              onClick={() => { actionPressed.current = true; void restoreFile(); }}
              disabled={!canRestore || restoreBusy}
              title={canRestore ? restoreDetail : "This change can't be restored directly"}
            >
              {restoreState.status === "restoring" ? "Restoring…" : "Restore earlier state"}
            </PrimaryButton>
          )}
          {moreItems.length > 0 ? (
            <Menu
              label="More actions"
              testId="engine-diff-more"
              items={moreItems}
              open={moreOpen}
              onOpenChange={setMoreOpen}
              width={176}
            />
          ) : null}
          {steps && onOpenMoment ? (
            <span className="flex items-center">
              <IconButton
                data-testid="engine-diff-newer"
                aria-label="Newer change"
                aria-keyshortcuts="]"
                title="Newer change  ]"
                aria-disabled={!steps.newer || undefined}
                onClick={() => stepTo("newer")}
                className={STEP_ARROW}
              >
                <ChevronUp size={14} aria-hidden />
              </IconButton>
              <IconButton
                data-testid="engine-diff-older"
                aria-label="Older change"
                aria-keyshortcuts="["
                title="Older change  ["
                aria-disabled={!steps.older || undefined}
                onClick={() => stepTo("older")}
                className={STEP_ARROW}
              >
                <ChevronDown size={14} aria-hidden />
              </IconButton>
            </span>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 overflow-auto overflow-x-hidden">
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
                className="m-0 border-b border-line bg-panel-2 px-4 py-2 text-[11px] leading-4 text-subtle"
              >
                {afterIsBinary
                  ? `This file became a binary file. Its ${moment.afterBinary?.byteLength ?? 0} bytes are not shown in text diffs.`
                  : `This file was a binary file before this change. Its ${moment.beforeBinary?.byteLength ?? 0} bytes are not shown in text diffs.`}
              </p>
            ) : null}
            <UnifiedDiffLines lines={diffLines} testId="engine-diff-lines" />
          </>
        )}
      </div>
      {sharedRestoreOpen && <OwnerRestoreDialog key={`${workspaceId}:${moment.path}`} workspaceId={workspaceId} path={moment.path}
        onClose={() => setSharedRestoreOpen(false)} onBeforeRestore={onBeforeRestore} onRestored={onRestored} />}
    </section>
  );
}
