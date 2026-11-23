import { useMemo, useRef, useState } from "react";
import { Database, Info, Lock, RotateCcw, Trash2, TriangleAlert, X } from "lucide-react";
import {
  AGENT_RUN_SCAN_MAX_PAGES,
  type AgentRunUndoPlanItem,
  type AgentRunUndoSkippedItem,
  type UndoAgentRunResult,
} from "@dohc/workspace-contracts/agent-run-undo";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { basenameOf, dirnameOf } from "../path";
import {
  DangerButton,
  IconButton,
  PrimaryButton,
  SecondaryButton,
  SectionLabel,
} from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";

function unreadablePolicyMessage(paths: readonly string[]): string {
  const files = paths.filter((path) => path !== ".dohc");
  if (files.length === 0) {
    return "dohc cannot undo this agent run because it cannot read this workspace's .dohc folder. Fix the folder and try again.";
  }
  return `dohc cannot undo this agent run because it cannot read ${files.join(" and ")}. Fix ${files.length > 1 ? "the files" : "the file"} and try again.`;
}

export interface AgentRunUndoDialogProps {
  workspaceId: string;
  agentRunId: string;
  agentName: string | null;
  reviewPaths: readonly string[];
  onBeforeRestore: () => Promise<() => void>;
  onRestored: () => void;
  onSuccessNotice: (message: string) => void;
  onError: (
    fallback: string,
    error: unknown,
    retry: (() => void) | null,
    identity?: string,
  ) => void;
  onClose: () => void;
}

function fileCountLabel(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function PathLabel(props: { path: string }) {
  const name = basenameOf(props.path);
  const folder = dirnameOf(props.path);
  return (
    <span title={props.path} className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate text-[13px] font-medium text-ink">{name}</span>
      {folder ? <span className="min-w-0 truncate text-[12px] text-subtle">{folder}</span> : null}
    </span>
  );
}

function SkipIcon(props: { reason: AgentRunUndoSkippedItem["reason"] }) {
  if (props.reason === "protected") {
    return <Lock size={14} strokeWidth={1.9} aria-hidden className="mt-0.5 shrink-0 text-subtle" />;
  }
  if (props.reason === "collection") {
    return (
      <Database size={14} strokeWidth={1.9} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
    );
  }
  if (
    props.reason === "untracked" ||
    props.reason === "unchanged" ||
    props.reason === "batch-limit"
  ) {
    return <Info size={14} strokeWidth={1.9} aria-hidden className="mt-0.5 shrink-0 text-subtle" />;
  }
  return (
    <TriangleAlert
      size={14}
      strokeWidth={1.9}
      aria-hidden
      className="mt-0.5 shrink-0 text-warning"
    />
  );
}

export function AgentRunUndoDialog(props: AgentRunUndoDialogProps) {
  const {
    workspaceId,
    agentRunId,
    reviewPaths,
    onBeforeRestore,
    onRestored,
    onSuccessNotice,
    onError,
    onClose,
  } = props;
  const session = useWorkspaceSession();
  const planQuery = useWorkspaceQuery(session, {
    key: `agent-run-undo-plan:${workspaceId}:${agentRunId}`,
    load: () => bridge().planUndoAgentRun({ workspaceId, agentRunId }),
  });

  const [running, setRunning] = useState(false);
  const [staleMessage, setStaleMessage] = useState<string | null>(null);
  const [partialResult, setPartialResult] = useState<UndoAgentRunResult | null>(null);
  const runningRef = useRef(false);
  const request = useRequestSequence([workspaceId, agentRunId]);

  const plan = planQuery.value;
  const shownAgentName = plan?.agentName ?? props.agentName;
  const reviewPathSet = useMemo(() => new Set(reviewPaths), [reviewPaths]);

  const { effectiveRestorable, effectiveSkipped } = useMemo(() => {
    if (!plan) {
      return {
        effectiveRestorable: [] as AgentRunUndoPlanItem[],
        effectiveSkipped: [] as AgentRunUndoSkippedItem[],
      };
    }
    const restorable: AgentRunUndoPlanItem[] = [];
    const skipped = new Map<string, AgentRunUndoSkippedItem>(
      plan.skipped.map((item) => [item.path, item]),
    );
    for (const item of plan.restorable) {
      if (reviewPathSet.has(item.path)) {
        if (!skipped.has(item.path)) {
          skipped.set(item.path, {
            path: item.path,
            reason: "local-changes",
            detail: "Has unsaved edits in this window. Save or close it first.",
          });
        }
      } else {
        restorable.push(item);
      }
    }
    return {
      effectiveRestorable: restorable,
      effectiveSkipped: [...skipped.values()].sort((left, right) =>
        comparePaths(left.path, right.path),
      ),
    };
  }, [plan, reviewPathSet]);

  const removesFiles = effectiveRestorable.some((item) => item.action === "delete");
  const errorIdentity = `agent-run-undo:${JSON.stringify([workspaceId, agentRunId])}`;

  async function runUndo() {
    if (runningRef.current || effectiveRestorable.length === 0) return;
    runningRef.current = true;
    setRunning(true);
    setStaleMessage(null);
    const token = request.next();
    let release: (() => void) | null = null;
    const planRestorablePaths = new Set(plan?.restorable.map((item) => item.path) ?? []);
    const relevantReviewPaths = reviewPaths.filter((path) => planRestorablePaths.has(path));
    try {
      release = await onBeforeRestore();
      const result = await bridge().undoAgentRun({
        workspaceId,
        agentRunId,
        expectedTargets: effectiveRestorable.map(
          ({ objectId, path, earliestMomentId, latestMomentId, action }) => ({
            objectId,
            path,
            earliestMomentId,
            latestMomentId,
            action,
          }),
        ),
        ...(relevantReviewPaths.length > 0 ? { reviewPaths: relevantReviewPaths } : {}),
      });
      if (!request.isCurrent(token)) return;
      if (result.policyUnreadable?.length) {
        const message = unreadablePolicyMessage(result.policyUnreadable);
        onError(message, new Error(message), () => void planQuery.retry(), errorIdentity);
        void planQuery.retry();
        return;
      }
      if (result.restored.length > 0) {
        onRestored();
      }
      if (result.failed.length > 0) {
        setPartialResult(result);
        const failureSummary = result.failed
          .map((item) => `${item.path}: ${item.detail}`)
          .join("; ");
        const fallback =
          result.restored.length > 0
            ? `Undid ${fileCountLabel(result.restored.length)}, but ${fileCountLabel(result.failed.length)} could not be restored.`
            : `dohc could not undo ${fileCountLabel(result.failed.length)} from this agent run.`;
        onError(
          fallback,
          new Error(failureSummary),
          () => {
            setPartialResult(null);
            void planQuery.retry();
          },
          errorIdentity,
        );
        return;
      }
      if (result.restored.length === 0) {
        const changedSincePreview = result.skipped.some(
          (item) =>
            item.reason === "not-in-plan" ||
            item.reason === "later-edits" ||
            item.reason === "local-changes",
        );
        setStaleMessage(
          changedSincePreview
            ? "No files were undone because they changed since this preview loaded. Review the updated list below."
            : "No files were undone. Review the skipped files below.",
        );
        void planQuery.retry();
        return;
      }
      const notice =
        result.skipped.length > 0
          ? `Undid ${fileCountLabel(result.restored.length)} (${result.skipped.length} skipped).`
          : `Undid ${fileCountLabel(result.restored.length)}.`;
      onSuccessNotice(notice);
      onClose();
    } catch (error) {
      if (!request.isCurrent(token)) return;
      onError("dohc could not undo this agent run.", error, () => void runUndo(), errorIdentity);
    } finally {
      release?.();
      runningRef.current = false;
      if (request.isCurrent(token)) setRunning(false);
    }
  }

  const title = shownAgentName ? `Undo changes from ${shownAgentName}` : "Undo agent run";
  const subtitle = shownAgentName
    ? `Files saved while ${shownAgentName} was running on the active version.`
    : "Files saved while this agent run was active on the active version.";

  return (
    <Overlay
      onClose={running ? undefined : onClose}
      panelProps={{
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "agent-run-undo-title",
        "data-testid": "agent-run-undo-dialog",
        className:
          "dohc-pop-in flex max-h-[82vh] w-[min(560px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl",
      }}
    >
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 id="agent-run-undo-title" className="m-0 text-[15px] font-semibold text-ink">
            {title}
          </h2>
          <p className="m-0 mt-1 text-[12px] text-muted">{subtitle}</p>
        </div>
        <IconButton
          aria-label="Close undo agent run dialog"
          title="Close"
          disabled={running}
          onClick={onClose}
        >
          <X size={14} aria-hidden />
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {partialResult ? (
          <div className="flex flex-col gap-3" data-testid="agent-run-undo-partial">
            <div className="flex items-start gap-2 rounded-lg border border-danger-border bg-panel-2 px-3 py-2.5 text-[12px] text-ink">
              <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <p className="m-0 font-medium">
                  {partialResult.restored.length > 0
                    ? `Undid ${fileCountLabel(partialResult.restored.length)}, and ${fileCountLabel(partialResult.failed.length)} could not be restored.`
                    : `Could not undo ${fileCountLabel(partialResult.failed.length)}.`}
                </p>
                <p className="m-0 mt-0.5 text-muted">
                  The failure details are also in Notices with Try again and copy.
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <SectionLabel as="h3">Could not undo ({partialResult.failed.length})</SectionLabel>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {partialResult.failed.map((item) => (
                  <li
                    key={item.path}
                    className="rounded-lg border border-line bg-panel-2 px-3 py-2"
                  >
                    <PathLabel path={item.path} />
                    <p className="m-0 mt-0.5 text-[12px] text-danger">{item.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : planQuery.pending && !plan ? (
          <p
            role="status"
            data-testid="agent-run-undo-loading"
            className="m-0 py-6 text-center text-[13px] text-muted"
          >
            Checking files from this agent run…
          </p>
        ) : planQuery.error ? (
          <div
            role="alert"
            data-testid="agent-run-undo-error"
            className="flex flex-col items-start gap-3 rounded-lg border border-danger-border bg-panel-2 px-3.5 py-3"
          >
            <div className="flex items-start gap-2 text-[13px] text-danger">
              <TriangleAlert size={15} aria-hidden className="mt-0.5 shrink-0" />
              <span>
                {planQuery.error instanceof Error
                  ? planQuery.error.message
                  : "dohc could not check the files for this agent run."}
              </span>
            </div>
            <SecondaryButton size="compact" onClick={() => void planQuery.retry()}>
              Try again
            </SecondaryButton>
          </div>
        ) : plan?.policyUnreadable?.length ? (
          <div
            role="alert"
            data-testid="agent-run-undo-policy-error"
            className="flex items-start gap-2 rounded-lg border border-danger-border bg-panel-2 px-3.5 py-3 text-[13px] text-ink"
          >
            <TriangleAlert size={15} aria-hidden className="mt-0.5 shrink-0 text-danger" />
            <span>{unreadablePolicyMessage(plan.policyUnreadable)}</span>
          </div>
        ) : (
          <>
            {staleMessage ? (
              <div
                role="status"
                data-testid="agent-run-undo-stale"
                className="flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12px] text-ink"
              >
                <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
                <span>{staleMessage}</span>
              </div>
            ) : null}

            {plan?.truncated ? (
              <div
                data-testid="agent-run-undo-truncated"
                className="flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12px] text-muted"
              >
                <Info size={14} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
                <span>
                  Checked the latest {AGENT_RUN_SCAN_MAX_PAGES} History pages (
                  {plan.scannedChanges.toLocaleString()}{" "}
                  {plan.scannedChanges === 1 ? "change" : "changes"} on this version). Older history
                  was not checked, so earlier files from this run may not be listed.
                </span>
              </div>
            ) : null}

            {effectiveRestorable.length === 0 && effectiveSkipped.length === 0 ? (
              <p
                data-testid="agent-run-undo-empty"
                className="m-0 py-4 text-center text-[13px] text-muted"
              >
                No file changes from this agent run were found on the active version.
              </p>
            ) : null}

            {effectiveRestorable.length > 0 ? (
              <section
                aria-label="Files to undo"
                data-testid="agent-run-undo-restorable"
                className="flex flex-col gap-1.5"
              >
                <SectionLabel as="h3">Will undo ({effectiveRestorable.length})</SectionLabel>
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {effectiveRestorable.map((item) => (
                    <li
                      key={item.objectId}
                      data-testid="agent-run-undo-restorable-item"
                      data-undo-path={item.path}
                      data-undo-action={item.action}
                      className="flex items-start gap-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2"
                    >
                      {item.action === "delete" ? (
                        <Trash2
                          size={14}
                          strokeWidth={1.9}
                          aria-hidden
                          className="mt-0.5 shrink-0 text-danger"
                        />
                      ) : (
                        <RotateCcw
                          size={14}
                          strokeWidth={1.9}
                          aria-hidden
                          className="mt-0.5 shrink-0 text-muted"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <PathLabel path={item.path} />
                        <p className="m-0 mt-0.5 text-[12px] text-muted">
                          {item.action === "delete"
                            ? "Remove created file"
                            : "Restore earlier version"}
                          {item.momentCount > 1 ? ` (${item.momentCount} edits)` : ""}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {effectiveSkipped.length > 0 ? (
              <section
                aria-label="Files to skip"
                data-testid="agent-run-undo-skipped"
                className="flex flex-col gap-1.5"
              >
                <SectionLabel as="h3">Will skip ({effectiveSkipped.length})</SectionLabel>
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {effectiveSkipped.map((item) => (
                    <li
                      key={item.path}
                      data-testid="agent-run-undo-skipped-item"
                      data-skip-path={item.path}
                      data-skip-reason={item.reason}
                      className="flex items-start gap-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2"
                    >
                      <SkipIcon reason={item.reason} />
                      <div className="min-w-0 flex-1">
                        <PathLabel path={item.path} />
                        <p className="m-0 mt-0.5 text-[12px] text-muted">{item.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <p
              data-testid="agent-run-undo-scope"
              className="m-0 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[12px] text-muted"
            >
              Collection records keep their own History and are not changed here. Protected files
              are restored individually from History. Undoing records a new restore entry in History
              so you can reverse it later.
            </p>
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        {partialResult ? (
          <>
            <SecondaryButton
              onClick={() => {
                setPartialResult(null);
                void planQuery.retry();
              }}
            >
              Check again
            </SecondaryButton>
            <PrimaryButton onClick={onClose}>Close</PrimaryButton>
          </>
        ) : (
          <>
            <SecondaryButton disabled={running} onClick={onClose}>
              {effectiveRestorable.length > 0 ? "Cancel" : "Close"}
            </SecondaryButton>
            {effectiveRestorable.length > 0 &&
            !planQuery.error &&
            !plan?.policyUnreadable?.length ? (
              removesFiles ? (
                <DangerButton
                  data-testid="agent-run-undo-confirm"
                  disabled={running}
                  onClick={() => void runUndo()}
                >
                  {running ? "Undoing…" : `Undo ${fileCountLabel(effectiveRestorable.length)}`}
                </DangerButton>
              ) : (
                <PrimaryButton
                  data-testid="agent-run-undo-confirm"
                  disabled={running}
                  onClick={() => void runUndo()}
                >
                  {running ? "Undoing…" : `Undo ${fileCountLabel(effectiveRestorable.length)}`}
                </PrimaryButton>
              )
            ) : null}
          </>
        )}
      </div>
    </Overlay>
  );
}
