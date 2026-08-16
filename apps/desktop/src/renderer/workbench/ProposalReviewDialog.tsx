import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ReadShareProposalChangesResult,
  ShareProposalOperation,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { ipcErrorMessage } from "./WorkspaceVersions";
import {
  UnifiedDiffLines,
  buildUnifiedDiffLines,
  computeTextDiff,
} from "./unifiedDiff";

// The granter's review of one recipient's submitted changes (#646 PR3a).
// Modelled on ConflictReviewDialog: a notice opens it, it reads its own
// window under a liveness token, and it decides one thing.
//
// `proposal` is the code and storage word for what the user sees as
// "changes" — one name for one thing on screen, and the wire keeps its own.

// The name the granter reads. A submitter whose email the relay could not
// state reads the same way the share banner names an unknown account.
export function proposerName(
  sent: { proposedByEmail: string | null } | null,
): string {
  return sent?.proposedByEmail ?? "another dohc user";
}

// The words the version compare page already uses for the same two facts.
function operationLabel(operation: ShareProposalOperation): string {
  return operation === "delete" ? "Removed" : "Changed";
}

// One submitted file's diff, built once per pair of bodies instead of on
// every render of the dialog — the bound the compare page relies on.
function ProposalFileDiff(props: {
  currentText: string | null;
  incomingText: string | null;
}) {
  const lines = useMemo(
    () =>
      buildUnifiedDiffLines(
        computeTextDiff(
          props.currentText ?? undefined,
          props.incomingText ?? undefined,
          800,
        ),
      ),
    [props.currentText, props.incomingText],
  );
  return <UnifiedDiffLines lines={lines} testId="proposal-review-diff-lines" />;
}

// What one row says before anyone pays to open it.
function sizeLabel(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ContentState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; currentText: string | null; incomingText: string | null };

// ONE file of the review, closed until the granter opens it.
//
// Opening is what fetches the content. A review of a repository-sized folder
// lists thousands of these, and fetching every file's two sides to show that
// list is what made such a review impossible to open at all.
function ProposalFileSection(props: {
  workspaceId: string;
  proposalId: string;
  file: ReadShareProposalChangesResult["files"][number];
}) {
  const { workspaceId, proposalId, file } = props;
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<ContentState | null>(null);
  // The renderer async-state invariant, at row scope: an answer may only
  // repaint the row that asked for it.
  const liveToken = useRef(0);
  useEffect(
    () => () => {
      liveToken.current += 1;
    },
    [],
  );

  const toggle = useCallback(() => {
    const nowOpen = !open;
    setOpen(nowOpen);
    // Fetched once per row. Closing and reopening shows what was already read
    // rather than asking again.
    // Read once per row. A row that FAILED is read again, so a granter can
    // retry a file the relay could not serve without reopening the review.
    if (!nowOpen || (content !== null && content.status !== "error")) return;
    const token = ++liveToken.current;
    setContent({ status: "loading" });
    void (async () => {
      try {
        const read = await bridge().readShareProposalFileContent({
          workspaceId,
          proposalId,
          opIndex: file.opIndex,
        });
        if (token !== liveToken.current) return;
        setContent({ status: "ready", ...read });
      } catch (error) {
        if (token !== liveToken.current) return;
        setContent({
          status: "error",
          message: ipcErrorMessage(error, "Couldn't load this file."),
        });
      }
    })();
  }, [open, content, workspaceId, proposalId, file.opIndex]);

  const size = sizeLabel(file.afterByteLength);
  return (
    <section
      data-testid="proposal-review-file"
      data-proposal-path={file.path}
      data-drifted={file.drifted || undefined}
      data-open={open || undefined}
      // A review at the bound draws 2,500 of these. `content-visibility` is
      // the browser's own answer to that: it skips layout and paint for rows
      // outside the viewport, and it does so for rows whose height nobody can
      // predict — which an expandable row's is. A scroll-math virtualizer
      // would have to measure every open row to do the same job worse.
      // `contain-intrinsic-size` keeps the scrollbar honest before a row has
      // ever been drawn.
      className="overflow-hidden rounded-lg border border-line bg-bg [contain-intrinsic-size:auto_44px] [content-visibility:auto]"
    >
      <button
        type="button"
        data-testid="proposal-review-file-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2 border-b border-line bg-panel-2 px-3 py-2 text-left hover:bg-line/40"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          {file.path}
        </span>
        {size ? (
          <span className="shrink-0 text-[11px] text-subtle">{size}</span>
        ) : null}
        <span className="shrink-0 text-[11px] text-subtle">
          {operationLabel(file.operation)}
        </span>
      </button>
      {file.drifted ? (
        <p
          data-testid="proposal-review-drift"
          className="m-0 border-b border-line bg-warning/10 px-3 py-1.5 text-[11px] leading-4 text-warning"
        >
          This file changed since they sent it.
        </p>
      ) : null}
      {open && content?.status === "loading" ? (
        <p className="m-0 px-3 py-2 text-xs leading-5 text-muted" role="status">
          Loading this file…
        </p>
      ) : null}
      {open && content?.status === "error" ? (
        <p
          data-testid="proposal-review-file-error"
          className="m-0 px-3 py-2 text-xs leading-5 text-danger"
          role="alert"
        >
          {content.message}
        </p>
      ) : null}
      {open && content?.status === "ready" ? (
        <ProposalFileDiff
          currentText={content.currentText}
          incomingText={content.incomingText}
        />
      ) : null}
    </section>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; changes: ReadShareProposalChangesResult };

export function ProposalReviewDialog(props: {
  workspaceId: string;
  proposalId: string;
  // The granter's decision landed. The shell re-reads the open changes so the
  // notice that opened this dialog goes with it.
  onSettled: () => void;
  onClose: () => void;
}) {
  const { workspaceId, proposalId } = props;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  // The renderer async-state invariant: an answer may only repaint the window
  // that asked for it. Every unmount, and every change of workspace or
  // proposal, retires the window in flight.
  const liveToken = useRef(0);
  useEffect(
    () => () => {
      liveToken.current += 1;
    },
    [],
  );

  useEffect(() => {
    const token = ++liveToken.current;
    setLoad({ status: "loading" });
    setSettleError(null);
    void (async () => {
      try {
        // ONE read, and NO content: the files, their paths, sizes and drift.
        // A file's two sides are read when its row is opened.
        const changes = await bridge().readShareProposalChanges({
          workspaceId,
          proposalId,
        });
        if (token !== liveToken.current) return;
        setLoad({ status: "ready", changes });
      } catch (error) {
        if (token !== liveToken.current) return;
        setLoad({
          status: "error",
          message: ipcErrorMessage(error, "Couldn't load these changes."),
        });
      }
    })();
  }, [workspaceId, proposalId]);

  const settle = useCallback(
    async (decision: "accept" | "decline") => {
      const token = liveToken.current;
      setSettling(true);
      setSettleError(null);
      try {
        await bridge().settleShareProposal({ workspaceId, proposalId, decision });
        if (token !== liveToken.current) return;
        props.onSettled();
        props.onClose();
      } catch (error) {
        if (token !== liveToken.current) return;
        setSettleError(
          ipcErrorMessage(error, "dohc couldn't record your decision."),
        );
        setSettling(false);
      }
    },
    [props, workspaceId, proposalId],
  );

  const sender = proposerName(load.status === "ready" ? load.changes : null);
  const files = load.status === "ready" ? load.changes.files : [];

  return (
    <Overlay onClose={() => (settling ? undefined : props.onClose())}>
      <div
        data-testid="proposal-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="proposal-review-title"
        className="dohc-elevated flex max-h-[calc(100vh-120px)] w-[min(720px,calc(100vw-32px))] flex-col rounded-xl border border-line bg-panel"
      >
        <header className="border-b border-line px-4 py-3">
          <h3 id="proposal-review-title" className="m-0 text-sm font-semibold text-ink">
            Changes from {sender}
          </h3>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {load.status === "loading" ? (
            <p className="m-0 text-xs leading-5 text-muted" role="status">
              Loading these changes…
            </p>
          ) : null}
          {load.status === "error" ? (
            <p className="m-0 text-xs leading-5 text-danger" role="alert">
              {load.message}
            </p>
          ) : null}
          {load.status === "ready" ? (
            <div className="flex flex-col gap-4">
              {files.map((file) => (
                <ProposalFileSection
                  key={file.opIndex}
                  workspaceId={workspaceId}
                  proposalId={proposalId}
                  file={file}
                />
              ))}
            </div>
          ) : null}
          {settleError ? (
            <p
              data-testid="proposal-review-error"
              role="alert"
              className="m-0 mt-3 text-xs leading-5 text-danger"
            >
              {settleError}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          {/* Deciding is never forced, and a keyboard user needs a control
              rather than only Escape. Same words the conflict review uses for
              the same act. */}
          <button
            type="button"
            data-testid="proposal-review-later"
            disabled={settling}
            onClick={props.onClose}
            className="mr-auto h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Finish later
          </button>
          {/* Decline is the SAFE EXIT, so nothing about reading the changes
              can take it away. It moves nothing into this workspace, and a
              granter who cannot see a proposal must still be able to refuse
              it — otherwise the only way out is ending the share, which
              discards work without asking. Accept is the opposite: it writes,
              so it stays disabled until the review actually loaded. */}
          <button
            type="button"
            data-testid="proposal-review-decline"
            disabled={settling}
            onClick={() => void settle("decline")}
            className="h-8 cursor-pointer rounded-md border border-line px-3 text-xs text-muted hover:bg-line/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Decline
          </button>
          <button
            type="button"
            data-testid="proposal-review-accept"
            disabled={load.status !== "ready" || settling}
            onClick={() => void settle("accept")}
            className="h-8 cursor-pointer rounded-md bg-accent px-3 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Accept changes
          </button>
        </footer>
      </div>
    </Overlay>
  );
}
