import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { HeldChange } from "@dohc/workspace-contracts/held-changes";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { DiffCounts, UnifiedDiffLines, buildUnifiedDiffLines, computeTextDiff } from "./workbench/unifiedDiff";

export type HeldChangeRead =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; change: HeldChange | null };

const TITLE_ID = "held-change-title";

/**
 * What saving a held change would write, against the file on disk, as a
 * diff. The engine answers from the same selection and projection the save
 * uses, so the review shows what Edit anyway would save, not a guess.
 */
export function HeldChangeDialog(props: { workspaceId: string; path: string; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<HeldChangeRead>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setRead({ kind: "loading" });
    bridge().readHeldChange({ workspaceId: props.workspaceId, path: props.path }).then(
      ({ change }) => { if (live) setRead({ kind: "ready", change }); },
      () => { if (live) setRead({ kind: "failed" }); },
    );
    return () => { live = false; };
  }, [props.workspaceId, props.path, attempt]);
  return (
    <Overlay
      onClose={props.onClose}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-labelledby": TITLE_ID,
        "data-testid": "held-change-dialog",
        className: "dohc-elevated dohc-pop-in flex max-h-[85vh] w-[min(760px,calc(100vw-32px))] flex-col rounded-xl border border-line bg-panel text-ink",
      }}
    >
      <HeldChangeCard path={props.path} read={read} onRetry={() => setAttempt(count => count + 1)} onClose={props.onClose} />
    </Overlay>
  );
}

/** The review's contents without its overlay, which the states page draws in place. */
export function HeldChangeCard(props: { path: string; read: HeldChangeRead; onRetry: () => void; onClose: () => void }) {
  const change = props.read.kind === "ready" ? props.read.change : null;
  const sides = change && "held" in change ? change : null;
  // dohc refuses a preview it can't make equal to what saving writes.
  const unavailable = change && "unavailable" in change ? change.unavailable : null;
  // The file's text is the base; what saving writes is the candidate.
  const diff = useMemo(() => sides ? computeTextDiff(sides.file ?? undefined, sides.held, 800) : null, [sides]);
  const lines = useMemo(() => diff ? buildUnifiedDiffLines(diff) : null, [diff]);
  const name = props.path.split("/").at(-1) ?? props.path;
  return (
    <>
      <div className="flex flex-col gap-2 border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <h2 id={TITLE_ID} className="m-0 min-w-0 flex-1 truncate text-base font-semibold text-ink">Held change to {name}</h2>
          {diff?.counts ? <DiffCounts counts={diff.counts} testId="held-change-counts" /> : null}
        </div>
        {unavailable ? null : (
          <div className="flex items-center gap-4 font-mono text-[11px]" data-testid="held-change-legend">
            <span className="text-danger">− <span className="font-sans text-muted">{sides?.file === null ? "No file yet" : "In the file"}</span></span>
            <span className="text-success">+ <span className="font-sans text-muted">Held change, if saved</span></span>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {props.read.kind === "loading" ? <SkeletonRows label="Reading the held change…" /> : null}
        {props.read.kind === "failed" ? (
          <ReadFailed testId="held-change-failed" onRetry={props.onRetry}>dohc could not read the held change.</ReadFailed>
        ) : null}
        {unavailable === "fileUnreadable" ? (
          <ReadFailed testId="held-change-file-unreadable" onRetry={props.onRetry}>dohc could not read this file to compare it.</ReadFailed>
        ) : null}
        {/* Sync can finish while the review is open, so this one retries. */}
        {unavailable === "waitingForSync" ? (
          <ReadFailed testId="held-change-waiting" onRetry={props.onRetry}>dohc could not preview this change while edits wait to sync.</ReadFailed>
        ) : null}
        {unavailable === "unsupported" ? (
          <p data-testid="held-change-unavailable" className="m-0 text-[13px] text-muted">dohc can't preview this change.</p>
        ) : null}
        {props.read.kind === "ready" && change === null ? (
          <p data-testid="held-change-gone" className="m-0 text-[13px] text-muted">dohc no longer holds a change to this note.</p>
        ) : null}
        {change && "tooLarge" in change ? (
          <p data-testid="held-change-too-large" className="m-0 text-[13px] text-muted">This change is too large to show here.</p>
        ) : null}
        {lines ? (
          <div className="overflow-hidden rounded-md border border-line bg-bg">
            <UnifiedDiffLines lines={lines} testId="held-change-diff" />
          </div>
        ) : null}
      </div>
      <div className="flex justify-end border-t border-line px-6 py-4">
        <SecondaryButton onClick={props.onClose}>Close</SecondaryButton>
      </div>
    </>
  );
}

function ReadFailed(props: { testId: string; onRetry: () => void; children: string }) {
  return (
    <div role="alert" data-testid={props.testId} className="flex items-start gap-2 text-[12px] text-ink">
      <CircleAlert size={14} strokeWidth={1.9} aria-hidden className="mt-px shrink-0 text-danger" />
      <span className="min-w-0">{props.children}</span>
      <SecondaryButton size="row" className="ml-auto shrink-0" onClick={props.onRetry}>Try again</SecondaryButton>
    </div>
  );
}
