import { AlertTriangle, CheckCircle2, CircleDashed, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  ListCollectionAutomationRunsResult,
  UndoCollectionAutomationRunResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { relativeTime } from "../relativeTime";
import { SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";

// One automation's runs on this computer, newest first (claims are local,
// so run history is too). A failed run offers Try again unless the chain
// cap stopped it, and a run that changed records offers Undo.

type Run = ListCollectionAutomationRunsResult["runs"][number];
type RunWrite = Run["writes"][number];
type Undone = Extract<UndoCollectionAutomationRunResult, { status: "undone" }>;

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** What an Undo did, for its notice: "Undid 3 changes. 1 field changed since then." */
export function undoSentence(undone: Undone): string {
  const parts: string[] = [];
  if (undone.reverted > 0) parts.push(`Undid ${count(undone.reverted, "change", "changes")}.`);
  if (undone.removed > 0) parts.push(`Moved ${count(undone.removed, "added record", "added records")} to the trash.`);
  if (parts.length === 0) parts.push("Nothing was left to undo.");
  if (undone.changedSince > 0) parts.push(`${count(undone.changedSince, "field", "fields")} changed since then.`);
  if (undone.missing > 0) {
    parts.push(`${count(undone.missing, "field is", "fields are")} on records no longer in the Collection.`);
  }
  return parts.join(" ");
}

function recordName(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/i, "");
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty";
  if (Array.isArray(value)) return value.length === 0 ? "empty" : value.map(valueText).join(", ");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function writeText(write: RunWrite): string {
  const record = recordName(write.path);
  switch (write.kind) {
    case "field":
      return `${record} · ${write.field}: ${valueText(write.before)} → ${valueText(write.after)}`;
    case "created":
      return `Added ${record}`;
    case "kept":
      return `${record} · ${write.field}: kept ${valueText(write.current)}, which someone set after the run began`;
    case "skipped":
      return `${record} · ${sentence(write.reason)}`;
  }
}

function runSummary(run: Run): string {
  if (run.state === "pending" || run.state === "running") return "Running";
  if (run.state === "failed") return sentence(run.chainStopped ? "The automation chain stopped before this run" : run.error ?? "The run failed");
  const fields = run.writes.filter((write) => write.kind === "field").length;
  const added = run.writes.filter((write) => write.kind === "created").length;
  const parts = [
    ...(fields > 0 ? [`changed ${count(fields, "field", "fields")}`] : []),
    ...(added > 0 ? [`added ${count(added, "record", "records")}`] : []),
  ];
  const text = parts.length === 0 ? "Nothing changed" : parts.join(" and ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function RunMark({ run }: { run: Run }) {
  if (run.undone) return <Undo2 size={13} aria-label="Undone" className="mt-0.5 shrink-0 text-subtle" />;
  if (run.state === "failed") return <AlertTriangle size={13} aria-label="Failed" className="mt-0.5 shrink-0 text-warning" />;
  if (run.state === "done") return <CheckCircle2 size={13} aria-label="Done" className="mt-0.5 shrink-0 text-success" />;
  return <CircleDashed size={13} aria-label="Running" className="mt-0.5 shrink-0 text-subtle" />;
}

function RunRow(props: {
  run: Run;
  onRetry: () => void;
  onUndo: () => void;
  undoing: boolean;
}) {
  const { run } = props;
  const [open, setOpen] = useState(false);
  const canRetry = run.state === "failed" && !run.chainStopped && !run.undone;
  const canUndo = (run.state === "done" || run.state === "failed") && !run.undone &&
    run.writes.some((write) => write.kind === "field" || write.kind === "created");
  return (
    <li data-testid={`automation-run-${run.claimId}`} className="border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <RunMark run={run} />
        <div className="min-w-0 flex-1">
          <p className="m-0 break-words text-[12px] leading-snug text-ink">{runSummary(run)}</p>
          <time dateTime={new Date(run.updatedAtMs).toISOString()} className="font-mono text-[11px] text-subtle">
            {relativeTime(run.updatedAtMs)}
          </time>
        </div>
      </div>
      {canRetry || canUndo || run.writes.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-5">
          {canRetry ? <SecondaryButton size="compact" onClick={props.onRetry}>Try again</SecondaryButton> : null}
          {canUndo ? (
            <SecondaryButton size="compact" disabled={props.undoing} onClick={props.onUndo}>Undo</SecondaryButton>
          ) : null}
          {run.writes.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-line/50 hover:text-ink"
            >
              {open ? "Hide changes" : `Show ${count(run.writes.length, "change", "changes")}`}
            </button>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <ul className="m-0 mt-1.5 list-none space-y-0.5 pl-5">
          {run.writes.map((write, index) => (
            <li key={index} className="break-words font-mono text-[11px] leading-snug text-muted">
              {writeText(write)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function AutomationRuns(props: {
  workspaceId: string;
  automationId: string;
  /** Rises when the Collection or its automations may have changed. */
  refreshKey: number;
  onRetry: (target: { automationId: string; claimId: string }) => void;
  onError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onNotice: (message: string) => void;
}) {
  const { workspaceId, automationId, onError, onNotice } = props;
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const request = useRequestSequence([workspaceId, automationId]);
  const load = useCallback(async () => {
    const token = request.next();
    try {
      const result = await bridge().listCollectionAutomationRuns({ workspaceId, automationId });
      if (request.isCurrent(token)) setRuns(result.runs);
    } catch (error) {
      if (request.isCurrent(token)) onError("dohc could not read this automation's runs.", error, () => void load());
    }
  }, [workspaceId, automationId, onError]);
  useEffect(() => {
    void load();
  }, [load, props.refreshKey]);
  // Relative times stay honest while the view is open.
  const [, tick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => tick((value) => value + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const undo = (claimId: string) => {
    setUndoing(claimId);
    void bridge()
      .undoCollectionAutomationRun({ workspaceId, automationId, claimId })
      .then((result) => {
        if (result.status === "refused") onError(result.reason, new Error(result.reason));
        else onNotice(undoSentence(result));
      })
      .catch((error: unknown) => onError("dohc could not undo this run.", error, () => undo(claimId)))
      .finally(() => {
        setUndoing(null);
        void load();
      });
  };

  if (runs === null) return null;
  if (runs.length === 0) {
    return <p className="m-0 px-3 py-4 text-[12px] text-muted">This automation has not run on this computer yet.</p>;
  }
  return (
    <ul data-testid="automation-runs" className="m-0 list-none p-0">
      {runs.map((run) => (
        <RunRow
          key={run.claimId}
          run={run}
          undoing={undoing === run.claimId}
          onRetry={() => props.onRetry({ automationId, claimId: run.claimId })}
          onUndo={() => undo(run.claimId)}
        />
      ))}
    </ul>
  );
}
