import { AlertTriangle, CheckCircle2, CircleDashed, LoaderCircle, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ListCollectionAutomationRunsResult,
  UndoCollectionAutomationRunResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { relativeTime } from "../relativeTime";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";

// One automation's runs on this computer, newest first (claims are local,
// so run history is too), a page at a time. A failed run offers Try again
// unless it failed before it started, and a run that changed records offers
// Undo. The run a notice opens shows first, marked, when no page shown holds it.
// Undo of a run that added dataset records first says what it will delete and
// keep, and asks which delete to use where several qualify.

type Run = Extract<ListCollectionAutomationRunsResult, { status: "listed" }>["runs"][number];
type RunWrite = Run["writes"][number];
type Undone = Extract<UndoCollectionAutomationRunResult, { status: "undone" }>;
type Preview = Extract<UndoCollectionAutomationRunResult, { status: "confirm" }>["preview"];

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
  if (undone.actionsReversed > 0) parts.push(`Undid ${count(undone.actionsReversed, "action", "actions")}.`);
  if (undone.deleted > 0) parts.push(`Deleted ${count(undone.deleted, "added record", "added records")}.`);
  if (parts.length === 0) parts.push("Nothing was left to undo.");
  if (undone.kept > 0) parts.push(`${count(undone.kept, "added record stays", "added records stay")}.`);
  if (undone.keptChanged > 0) {
    parts.push(`${count(undone.keptChanged, "added record stays", "added records stay")} because someone changed ${undone.keptChanged === 1 ? "it" : "them"}.`);
  }
  if (undone.gone > 0) parts.push(`${count(undone.gone, "added record was", "added records were")} already gone.`);
  if (undone.changedSince > 0) parts.push(`${count(undone.changedSince, "field", "fields")} changed since then.`);
  if (undone.missing > 0) {
    parts.push(`${count(undone.missing, "field is", "fields are")} on records no longer in the Collection.`);
  }
  if (undone.irreversible > 0) {
    parts.push(`The Collection's rules do not let dohc undo ${count(undone.irreversible, "change", "changes")}.`);
  }
  if (undone.actions > 0) parts.push(`${count(undone.actions, "action", "actions")} can't be undone.`);
  return parts.join(" ");
}

/** What Undo will do, before the person confirms it. */
export function undoPreviewSentences(preview: Preview): string[] {
  const lines: string[] = [];
  const tried = preview.deletes + preview.unchecked;
  if (preview.reverses > 0) lines.push(`Undo will reverse ${count(preview.reverses, "action", "actions")}.`);
  if (preview.deletes > 0) lines.push(`Undo will delete ${count(preview.deletes, "added record", "added records")}.`);
  if (preview.unchecked > 0) {
    lines.push(`Undo will try to delete ${count(preview.unchecked, "added record", "added records")} that dohc could not check. Any that someone changed will stay.`);
  }
  if (preview.reverts > 0) lines.push(`Undo will put back ${count(preview.reverts, "change", "changes")}.`);
  if (tried + preview.reverts > 0) lines.push("A record or field someone else changed stays as they left it.");
  if (preview.kept > 0) {
    lines.push(`${count(preview.kept, "added record", "added records")} will stay. This Collection has no delete action available to the automation.`);
  }
  if (preview.keptChanged > 0) {
    lines.push(`${count(preview.keptChanged, "added record", "added records")} will stay because someone changed ${preview.keptChanged === 1 ? "it" : "them"}.`);
  }
  if (preview.gone > 0) lines.push(`${count(preview.gone, "added record is", "added records are")} already gone.`);
  if (preview.irreversible > 0) lines.push(`The Collection's rules do not let dohc undo ${count(preview.irreversible, "change", "changes")}.`);
  if (preview.actions > 0) lines.push(`${count(preview.actions, "action", "actions")} can't be undone.`);
  if (tried > 0) lines.push(`You cannot undo ${tried === 1 ? "this deletion" : "these deletions"} in dohc.`);
  return lines;
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
  if (write.kind === "notice") return `Notified ${write.name}`;
  if (write.kind === "message") return `Sent a message to ${write.name}`;
  if (write.kind === "dataset-action") return `Ran ${write.name}`;
  const record = "path" in write ? recordName(write.path) : String(write.recordId);
  switch (write.kind) {
    case "field":
      return `${record} · ${write.field}: ${valueText(write.before)} → ${valueText(write.after)}`;
    case "dataset-edit":
      return write.fields.map((field) => `${record} · ${field.field}: ${valueText(field.before)} → ${valueText(field.after)}`).join("; ");
    case "dataset-created":
    case "created":
      return `Added ${record}`;
    case "dataset-kept":
    case "kept":
      return `${record} · ${write.field}: kept ${valueText(write.current)}, which someone set after the run began`;
    case "dataset-skipped":
    case "skipped":
      return `${record} · ${sentence(write.reason)}`;
  }
}

function runSummary(run: Run): string {
  if (run.state === "pending" || run.state === "running") return "Running";
  if (run.state === "failed") return sentence(run.chainStopped ? "The automation chain stopped before this run" : run.error ?? "The run failed");
  const fields = run.writes.reduce((total, write) => total + (write.kind === "field" ? 1 : write.kind === "dataset-edit" ? write.fields.length : 0), 0);
  const added = run.writes.filter((write) => write.kind === "created" || write.kind === "dataset-created").length;
  const messages = run.writes.filter((write) => write.kind === "message").length;
  const notices = run.writes.filter((write) => write.kind === "notice").length;
  const actions = run.writes.filter((write) => write.kind === "dataset-action").length;
  const parts = [
    ...(actions > 0 ? [`ran ${count(actions, "action", "actions")}`] : []),
    ...(notices > 0 ? [`sent ${count(notices, "notice", "notices")}`] : []),
    ...(messages > 0 ? [`sent ${count(messages, "message", "messages")}`] : []),
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

const MISSING_RUN = "This run is no longer in run history. dohc keeps runs for 30 days after they end.";

// Newest first, as run history pages them: by when each run's claim was made, then by its id.
function newer(left: Run, right: Run): boolean {
  return left.createdAtMs > right.createdAtMs || (left.createdAtMs === right.createdAtMs && left.claimId > right.claimId);
}

/**
 * The newest page over the runs shown. Older pages stay while the newest
 * page reaches them; otherwise only the newest page shows. Runs read one
 * at a time replace their rows, and leave when run history no longer has them.
 */
function merged(
  shown: { runs: Run[]; next: string | null; opened: Run | null } | null,
  head: { runs: Run[]; next: string | null },
  read: ReadonlyMap<string, Run | null>,
  opened: string | null,
): { runs: Run[]; next: string | null; opened: Run | null } {
  const last = head.runs.at(-1);
  const older = shown !== null && head.next !== null && last !== undefined && shown.runs.length > 0 && !newer(last, shown.runs[0]!)
    ? { runs: shown.runs.filter((run) => newer(last, run)), next: shown.next }
    : null;
  const runs = older === null ? head.runs : [...head.runs, ...older.runs];
  const current = runs.flatMap((run) => (read.has(run.claimId) ? (read.get(run.claimId) === null ? [] : [read.get(run.claimId)!]) : [run]));
  const openedRun = opened === null ? null : read.has(opened) ? read.get(opened)! : shown?.opened ?? null;
  return { runs: current, next: older === null ? head.next : older.next, opened: openedRun };
}

function RunRow(props: {
  run: Run;
  onRetry: () => void;
  onUndo: () => void;
  undoing: boolean;
  /** The run a notice opened: marked, scrolled to, and its changes shown. */
  opened: boolean;
}) {
  const { run } = props;
  const [open, setOpen] = useState(props.opened);
  const row = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (props.opened) row.current?.scrollIntoView({ block: "nearest" });
  }, [props.opened]);
  const canRetry = run.state === "failed" && !run.neverStarted && !run.undone;
  const canUndo = (run.state === "done" || run.state === "failed") && !run.undone &&
    run.writes.some((write) => write.kind === "field" || write.kind === "created" || write.kind === "dataset-edit" ||
      (write.kind === "dataset-action" && write.undo !== undefined) ||
      (write.kind === "dataset-created" && write.deletes.length > 0));
  return (
    <li
      ref={row}
      data-testid={`automation-run-${run.claimId}`}
      aria-current={props.opened ? "true" : undefined}
      className={`border-b border-line px-3 py-2 last:border-b-0${props.opened ? " bg-selected" : ""}`}
    >
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
              className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
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
  /** The run to open, as a notice names it, or null. */
  run?: string | null;
  /** Rises when the Collection or its automations may have changed. */
  refreshKey: number;
  onRetry: (target: { automationId: string; claimId: string }) => void;
  onError: (fallback: string, error: unknown, retry?: (() => void) | null) => void;
  onNotice: (message: string) => void;
  /** An Undo changed records. */
  onUndone?: () => void;
}) {
  const { workspaceId, automationId, onError, onNotice } = props;
  const opened = props.run ?? null;
  // The runs shown, newest first, and the `before` of the page after them, or
  // null after the oldest. `opened` is the run a notice opened, shown first
  // while no page shown holds it. "unavailable" in a shared view: its
  // automations run on the owner's computer.
  const [list, setList] = useState<{ runs: Run[]; next: string | null; opened: Run | null } | "unavailable" | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);
  // Runs a person undid or tried again here. A refresh reads each again when
  // the newest page does not hold it, so a row further down stays current.
  const touched = useRef(new Set<string>());
  // Whether the opened run was looked for yet, and found gone: it is not read again.
  const openedChecked = useRef(false);
  const openedGone = useRef(false);
  // A caller may pass a new function each render; a read must not start again for that.
  const reportError = useRef(onError);
  reportError.current = onError;
  // An Undo waiting for the person to read what it will do, and their choice of delete per table.
  const [previewing, setPreviewing] = useState<{ claimId: string; epoch: number; preview: Preview; chosen: Record<string, string> } | null>(null);
  const request = useRequestSequence([workspaceId, automationId, opened]);
  // Rises only when the workspace or automation changes, or the view
  // closes, so an Undo that answers after that reports nothing here.
  const scope = useRequestSequence([workspaceId, automationId]);
  // Reads the newest page, and each touched, opened, or still going run it
  // does not hold, and keeps the older pages already shown.
  const load = useCallback(async () => {
    const token = request.next();
    try {
      const head = await bridge().listCollectionAutomationRuns({ workspaceId, automationId });
      if (!request.isCurrent(token)) return;
      if (head.status === "unavailable") return setList("unavailable");
      // Rows further down that are still going change without a person here touching them.
      const shown = listRef.current;
      const going = shown === null || shown === "unavailable" ? [] : shown.runs.filter((run) => run.state === "pending" || run.state === "running");
      const claims = new Set([...touched.current, ...going.map((run) => run.claimId)]);
      if (opened !== null && !openedGone.current) claims.add(opened);
      const read = new Map<string, Run | null>();
      for (const claimId of claims) {
        if (head.runs.some((run) => run.claimId === claimId)) continue;
        const result = await bridge().getCollectionAutomationRun({ workspaceId, automationId, claimId });
        if (!request.isCurrent(token)) return;
        read.set(claimId, result.status === "found" ? result.run : null);
      }
      if (opened !== null && !openedChecked.current) {
        openedChecked.current = true;
        openedGone.current = read.get(opened) === null;
        if (openedGone.current) reportError.current(MISSING_RUN, new Error(MISSING_RUN));
      }
      setList((current) => merged(current === "unavailable" ? null : current, head, read, opened));
    } catch (error) {
      if (request.isCurrent(token)) reportError.current("dohc could not read this automation's runs.", error, () => void load());
    }
  }, [workspaceId, automationId, opened]);
  useEffect(() => {
    void load();
  }, [load, props.refreshKey]);
  // Relative times stay honest while the view is open.
  const [, tick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => tick((value) => value + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Reads only the page after the runs shown.
  const loadOlder = () => {
    if (list === null || list === "unavailable" || list.next === null || loadingOlder) return;
    const before = list.next;
    const epoch = scope.current();
    setLoadingOlder(true);
    void bridge()
      .listCollectionAutomationRuns({ workspaceId, automationId, before })
      .then((result) => {
        if (!scope.isCurrent(epoch)) return;
        if (result.status === "unavailable") return setList("unavailable");
        // A refresh that dropped the pages this one follows drops it too.
        setList((current) => current === null || current === "unavailable" || current.next !== before ? current : {
          ...current,
          runs: [...current.runs, ...result.runs.filter((run) => !current.runs.some((shown) => shown.claimId === run.claimId))],
          next: result.next,
        });
      })
      .catch((error: unknown) => {
        if (scope.isCurrent(epoch)) onError("dohc could not read this automation's older runs.", error, loadOlder);
      })
      .finally(() => {
        if (scope.isCurrent(epoch)) setLoadingOlder(false);
      });
  };

  const undo = (claimId: string, deletes: { token: string; chosen: Array<{ key: string; operationId: string }> } | null) => {
    touched.current.add(claimId);
    const epoch = scope.current();
    setUndoing(claimId);
    void bridge()
      .undoCollectionAutomationRun({ workspaceId, automationId, claimId, deletes })
      .then((result) => {
        if (!scope.isCurrent(epoch)) return;
        if (result.status === "refused") {
          onError(result.reason, new Error(result.reason));
        } else if (result.status === "confirm") {
          setPreviewing({ claimId, epoch, preview: result.preview, chosen: {} });
        } else {
          onNotice(undoSentence(result));
          props.onUndone?.();
        }
      })
      .catch((error: unknown) => {
        if (scope.isCurrent(epoch)) onError("dohc could not undo this run.", error, () => undo(claimId, deletes));
      })
      .finally(() => {
        if (!scope.isCurrent(epoch)) return;
        setUndoing(null);
        void load();
      });
  };

  const shownPreview = previewing !== null && scope.isCurrent(previewing.epoch) ? previewing : null;
  const dialog = shownPreview === null ? null : (
    <ConfirmDialog
      title="Undo this run?"
      confirmLabel={shownPreview.preview.deletes + shownPreview.preview.unchecked > 0
        ? `Undo and delete ${count(shownPreview.preview.deletes + shownPreview.preview.unchecked, "record", "records")}`
        : "Undo"}
      testId="automation-undo-preview"
      cancelTestId="automation-undo-preview-cancel"
      confirmTestId="automation-undo-preview-confirm"
      confirmDisabled={shownPreview.preview.choices.some((choice) => shownPreview.chosen[choice.key] === undefined)}
      onCancel={() => setPreviewing(null)}
      onConfirm={() => {
        setPreviewing(null);
        undo(shownPreview.claimId, {
          token: shownPreview.preview.token,
          chosen: Object.entries(shownPreview.chosen).map(([key, operationId]) => ({ key, operationId })),
        });
      }}
    >
      {undoPreviewSentences(shownPreview.preview).map((line) => (
        <p key={line} className="m-0 mt-2 text-[13px] text-muted">{line}</p>
      ))}
      {shownPreview.preview.choices.map((choice, index) => (
        <fieldset key={choice.key} className="m-0 mt-3 flex flex-col gap-1 border-0 p-0">
          <legend className="mb-1 p-0 text-[12px] text-muted">
            Delete {count(choice.records, "added record", "added records")} in {choice.table} with
          </legend>
          {choice.operations.map((operation) => (
            <label key={operation.operationId} className="flex items-center gap-2 text-[13px] text-ink">
              <input
                type="radio"
                name={`automation-undo-delete-${index}`}
                checked={shownPreview.chosen[choice.key] === operation.operationId}
                onChange={() => setPreviewing({ ...shownPreview, chosen: { ...shownPreview.chosen, [choice.key]: operation.operationId } })}
              />
              {operation.label}
            </label>
          ))}
        </fieldset>
      ))}
    </ConfirmDialog>
  );

  if (list === null) return null;
  if (list === "unavailable") {
    return <p className="m-0 px-3 py-4 text-[12px] text-muted">This Collection's automations run on its owner's computer.</p>;
  }
  const openedRun = list.opened;
  const shown = openedRun === null || list.runs.some((run) => run.claimId === openedRun.claimId) ? list.runs : [openedRun, ...list.runs];
  if (shown.length === 0) {
    return <p className="m-0 px-3 py-4 text-[12px] text-muted">This automation has not run on this computer yet.</p>;
  }
  return (
    <>
      <ul data-testid="automation-runs" className="m-0 list-none p-0">
        {shown.map((run) => (
          <RunRow
            key={run.claimId}
            run={run}
            opened={run.claimId === opened}
            undoing={undoing === run.claimId}
            onRetry={() => {
              touched.current.add(run.claimId);
              props.onRetry({ automationId, claimId: run.claimId });
            }}
            onUndo={() => undo(run.claimId, null)}
          />
        ))}
      </ul>
      {list.next !== null ? (
        <div className="flex justify-center px-3 py-2">
          <SecondaryButton size="compact" className="inline-flex items-center gap-1.5" disabled={loadingOlder} aria-busy={loadingOlder} onClick={loadOlder}>
            {loadingOlder ? <LoaderCircle aria-hidden size={12} strokeWidth={1.9} className="shrink-0 animate-spin" /> : null}
            Older runs
          </SecondaryButton>
        </div>
      ) : null}
      {dialog}
    </>
  );
}
