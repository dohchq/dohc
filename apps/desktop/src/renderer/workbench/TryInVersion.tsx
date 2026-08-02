import { Bot, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TryInVersionRunState,
  WorkspaceVersionRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { VersionMergeDialog, ipcErrorMessage } from "./WorkspaceVersions";

// "Try it in a version" surfaces (PR 0N-2): the honest during-run banner and
// the review card that appears when the run ends. Product vocabulary only.
// Both mount only for flagged workspaces (the shell gates on versionsEnabled)
// and every async response is liveness-token gated before it touches state.

// While the agent works: one calm line, no new streaming surface — the
// History rail already shows the agent's edits as they land, and a run
// blocked on a permission raises its own card (AgentPermissionRequests).
export function TryInVersionBanner(props: {
  task: string;
  versionName: string;
}) {
  return (
    <div
      data-testid="try-run-banner"
      role="status"
      className="flex min-h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-1 text-[12px] text-muted"
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
      />
      <Bot size={13} aria-hidden className="shrink-0 text-agent" />
      <span className="shrink-0">An agent is trying:</span>
      <span
        data-testid="try-run-banner-task"
        className="min-w-0 truncate font-medium text-ink"
        title={props.task}
      >
        {props.task}
      </span>
      <span className="min-w-0 shrink-0 truncate text-subtle">
        — in {props.versionName}
      </span>
    </div>
  );
}

const CARD_ACTION_CLASS =
  "h-7 cursor-pointer rounded-md border border-line px-2.5 text-[11px] text-muted hover:bg-line/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-50";
const CARD_PRIMARY_ACTION_CLASS =
  "h-7 cursor-pointer rounded-md bg-accent px-2.5 text-[11px] font-semibold text-bg hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-50";

function reviewHeading(state: TryInVersionRunState): string {
  if (state.runOutcome === "failed") return "The agent stopped before finishing";
  if (state.changedFileCount === 0) return "The agent didn't change any files";
  return "The agent finished trying";
}

function reviewSummary(state: TryInVersionRunState): string {
  const where = `in ${state.versionName}`;
  if (state.changedFileCount === null || state.changedFileCount === undefined) {
    return `"${state.task}" — open the comparison to see what changed ${where}.`;
  }
  if (state.changedFileCount === 0) {
    return `"${state.task}" — everything ${where} still matches Main. You can go back to Main; the version stays in your list.`;
  }
  const files =
    state.changedFileCount === 1 ? "1 file" : `${state.changedFileCount} files`;
  return `"${state.task}" — ${files} changed ${where} compared with Main.`;
}

// The review card. Appears when the run ends; focus moves into it so the
// outcome is announced and the actions are one Tab away.
//   Review changes  -> opens the existing compare tab (card stays).
//   Merge into Main -> the existing merge dialog (conflicts included); after
//                      a completed merge, dohc returns to Main so the folder
//                      shows the merged result.
//   Keep working in it -> dismisses the card, stays in the version.
//   Set aside       -> back to Main; the version remains in the list.
export function TryInVersionReviewCard(props: {
  workspaceId: string;
  state: TryInVersionRunState;
  activeTabDirty: boolean;
  flushActiveDraft: () => Promise<void>;
  onOpenCompare: (versionId: string) => void;
  // Pass the version that is active NOW when this operation set it. The
  // shell needs the boundary before it can judge answers still in flight,
  // and a lookup it has to await is a window those answers slip through.
  // Omit it only when the operation did not change the active version, or
  // when it failed and nobody knows what stuck.
  onWorkspaceStateChanged: (activeVersionId?: string) => void;
  onDismissed: () => void;
}) {
  const { workspaceId, state } = props;
  const [busy, setBusy] = useState<"merge" | "back-to-main" | "dismiss" | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [mergeSource, setMergeSource] = useState<WorkspaceVersionRecord | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const liveToken = useRef(0);
  useEffect(
    () => () => {
      liveToken.current += 1;
    },
    [],
  );
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const dismiss = useCallback(async () => {
    const token = ++liveToken.current;
    setBusy("dismiss");
    setInlineError(null);
    try {
      await bridge().dismissTryInVersionReview({ workspaceId });
      if (token !== liveToken.current) return;
      props.onDismissed();
    } catch (error) {
      if (token !== liveToken.current) return;
      setInlineError(ipcErrorMessage(error, "Could not dismiss this."));
    } finally {
      if (token === liveToken.current) setBusy(null);
    }
  }, [props, workspaceId]);

  // Back to Main: save any open draft (it lands in the try version — nothing
  // is lost), switch, then clear the review. Used by Set aside and by the
  // post-merge return.
  const backToMain = useCallback(async () => {
    const token = ++liveToken.current;
    setBusy("back-to-main");
    setInlineError(null);
    try {
      await props.flushActiveDraft();
      if (token !== liveToken.current) return;
      const versions = await bridge().listWorkspaceVersions({ workspaceId });
      if (token !== liveToken.current) return;
      const main = versions.versions.find((version) => version.kind === "main");
      if (!main) throw new Error("Main is not available right now.");
      if (versions.activeVersionId !== main.id) {
        await bridge().switchWorkspaceVersion({ workspaceId, versionId: main.id });
        if (token !== liveToken.current) return;
      }
      await bridge().dismissTryInVersionReview({ workspaceId });
      if (token !== liveToken.current) return;
      // Main is where we are now — whether this call switched, or it was
      // already the active version.
      props.onWorkspaceStateChanged(main.id);
      props.onDismissed();
    } catch (error) {
      if (token !== liveToken.current) return;
      setInlineError(ipcErrorMessage(error, "Could not switch back to Main."));
      // A switch may have partially applied; make the shell reflect reality.
      // Nobody knows which version stuck, so the shell has to ask.
      props.onWorkspaceStateChanged();
    } finally {
      if (token === liveToken.current) setBusy(null);
    }
  }, [props, workspaceId]);

  const beginMerge = useCallback(async () => {
    const token = ++liveToken.current;
    setBusy("merge");
    setInlineError(null);
    try {
      const versions = await bridge().listWorkspaceVersions({ workspaceId });
      if (token !== liveToken.current) return;
      const source = versions.versions.find(
        (version) => version.id === state.versionId,
      );
      if (!source) throw new Error("This version is no longer available.");
      setMergeSource(source);
    } catch (error) {
      if (token !== liveToken.current) return;
      setInlineError(ipcErrorMessage(error, "Could not start the merge."));
    } finally {
      if (token === liveToken.current) setBusy(null);
    }
  }, [state.versionId, workspaceId]);

  const noChanges = state.changedFileCount === 0;

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="region"
      aria-label="Agent result, ready to review"
      data-testid="try-review-card"
      className="shrink-0 border-b border-line bg-panel px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      <div className="flex items-start gap-2">
        <Bot size={14} aria-hidden className="mt-0.5 shrink-0 text-agent" />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[13px] font-semibold text-ink">
            {reviewHeading(state)}
          </h3>
          <p
            data-testid="try-review-summary"
            className="mb-0 mt-0.5 text-[12px] leading-5 text-muted"
          >
            {reviewSummary(state)}
          </p>
        </div>
        <button
          type="button"
          data-testid="try-review-keep"
          aria-label="Keep working in it"
          title="Keep working in this version"
          disabled={busy !== null}
          onClick={() => void dismiss()}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-line/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-50"
        >
          <X size={13} aria-hidden />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        {noChanges ? (
          <>
            <button
              type="button"
              data-testid="try-review-back-to-main"
              disabled={busy !== null}
              onClick={() => void backToMain()}
              className={CARD_PRIMARY_ACTION_CLASS}
            >
              {busy === "back-to-main" ? "Going back…" : "Back to Main"}
            </button>
            <button
              type="button"
              data-testid="try-review-keep-working"
              disabled={busy !== null}
              onClick={() => void dismiss()}
              className={CARD_ACTION_CLASS}
            >
              Keep working in it
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-testid="try-review-open-compare"
              disabled={busy !== null}
              onClick={() => props.onOpenCompare(state.versionId)}
              className={CARD_PRIMARY_ACTION_CLASS}
            >
              Review changes
            </button>
            {state.mergeAvailable ? (
              <button
                type="button"
                data-testid="try-review-merge"
                disabled={busy !== null}
                onClick={() => void beginMerge()}
                className={CARD_ACTION_CLASS}
              >
                {busy === "merge" ? "Preparing…" : "Merge into Main"}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="try-review-keep-working"
              disabled={busy !== null}
              onClick={() => void dismiss()}
              className={CARD_ACTION_CLASS}
            >
              Keep working in it
            </button>
            <button
              type="button"
              data-testid="try-review-set-aside"
              disabled={busy !== null}
              title="Go back to Main. The version stays in your versions list."
              onClick={() => void backToMain()}
              className={CARD_ACTION_CLASS}
            >
              {busy === "back-to-main" ? "Setting aside…" : "Set aside"}
            </button>
          </>
        )}
      </div>
      {inlineError ? (
        <p
          data-testid="try-review-error"
          role="alert"
          className="mb-0 mt-2 pl-6 text-[11px] leading-4 text-danger"
        >
          {inlineError}
        </p>
      ) : null}
      {mergeSource ? (
        <VersionMergeDialog
          workspaceId={workspaceId}
          source={mergeSource}
          activeTabDirty={props.activeTabDirty}
          flushActiveDraft={props.flushActiveDraft}
          onWorkspaceStateChanged={props.onWorkspaceStateChanged}
          onOutcome={(outcome) => {
            // After a completed merge, return to Main so the folder shows the
            // merged result (a merge into an inactive Main changes no disk
            // until Main is active again). Open conflicts keep the card so
            // the merge can be finished later.
            if (outcome === "merged") void backToMain();
          }}
          onClose={() => setMergeSource(null)}
        />
      ) : null}
    </div>
  );
}
