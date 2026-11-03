import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, CircleAlert, Code, Database, Minus, PenLine, Plus, Shield, type LucideIcon } from "lucide-react";
import {
  collectionApplyLabel, collectionChangeDeletes, describeCollectionChangeRow, historyCanUndoCollectionChange,
  type CollectionChangeIcon, type CollectionChangeRow,
} from "../../workspaces/collectionChange";
import { bridge } from "../bridge";
import {
  discardCollectionChangeReview, prepareCollectionChangeReview, type CollectionChange, type CollectionChangeReview,
} from "../collections/collectionChangeFlow";
import { ipcErrorMessage } from "../ipcError";
import { Overlay } from "../Overlay";
import { formatClock } from "../time";
import { CopyButton } from "../ui/CopyButton";
import { DangerButton, PrimaryButton, SecondaryButton } from "../ui/controls";
import { SkeletonRows } from "../ui/SkeletonRows";
import { UnifiedDiffLines, buildUnifiedDiffLines, computeTextDiff } from "./unifiedDiff";

export const CHANGE_ICONS: Record<CollectionChangeIcon, { icon: LucideIcon; tone: string }> = {
  add: { icon: Plus, tone: "text-success" }, remove: { icon: Minus, tone: "text-danger" }, rename: { icon: PenLine, tone: "text-muted" },
  code: { icon: Code, tone: "text-muted" }, rule: { icon: Shield, tone: "text-muted" }, data: { icon: Database, tone: "text-muted" },
};
export const CHANGE_LOSS = "History can't undo this change.";

type Load = { kind: "loading" } | { kind: "failed"; words: string } | { kind: "ready"; review: CollectionChangeReview };
type Phase = { kind: "idle" } | { kind: "applying" } | { kind: "failed"; words: string; retry: boolean };

/**
 * The change the Collection's files make now, row by row, with each row's
 * file changes one Enter away. It prepares that change when it opens and
 * applies exactly what it shows. Closing it discards the preparation.
 */
export function CollectionChangeReviewDialog(props: {
  workspaceId: string;
  asked: CollectionChange;
  /** Applies the review and posts its reply. Rejects with the failure to show. */
  onApply: (review: CollectionChangeReview) => Promise<void>;
  /** Words and Try again for a failed Apply. */
  failure: (error: unknown) => { words: string; retry: boolean };
  locked: boolean;
  onNotNow: () => void;
  onClose: () => void;
  testIdPrefix: string;
}) {
  const { workspaceId, asked } = props;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // The preparation this dialog holds and has not applied, discarded when it closes.
  const held = useRef<CollectionChangeReview | null>(null);
  const closed = useRef(false);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let current = true;
    setLoad({ kind: "loading" });
    prepareCollectionChangeReview(bridge(), workspaceId, asked.proposal).then(review => {
      if (!current) { void discardCollectionChangeReview(bridge(), workspaceId, review).catch(() => undefined); return; }
      held.current = review;
      setLoad({ kind: "ready", review });
    }, (error: unknown) => {
      if (current) setLoad({ kind: "failed", words: ipcErrorMessage(error, "dohc couldn't prepare this change.") });
    });
    closed.current = false;
    return () => {
      current = false;
      closed.current = true;
      const review = held.current;
      held.current = null;
      if (review) void discardCollectionChangeReview(bridge(), workspaceId, review).catch(() => undefined);
    };
  }, [workspaceId, asked.proposal, attempt]);

  const ready = load.kind === "ready" ? load.review : null;
  useEffect(() => { if (ready) rowRefs.current[0]?.focus(); }, [ready]);

  const busy = phase.kind === "applying";
  const apply = async (review: CollectionChangeReview) => {
    setPhase({ kind: "applying" });
    // Applying uses the preparation, so closing now must not discard it.
    held.current = null;
    try {
      await props.onApply(review);
      props.onClose();
    } catch (error) {
      if (closed.current) void discardCollectionChangeReview(bridge(), workspaceId, review).catch(() => undefined);
      else held.current = review;
      setPhase({ kind: "failed", ...props.failure(error) });
    }
  };

  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = rowRefs.current.filter((row): row is HTMLButtonElement => row !== null);
    const at = rows.findIndex(row => row === document.activeElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  const toggle = (key: string) => setOpen(shown => {
    const next = new Set(shown);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const testId = (part: string) => `${props.testIdPrefix}-change-review-${part}`;
  const change = ready?.change ?? null;
  const rows = change?.rows ?? asked.rows;
  const deletes = collectionChangeDeletes(rows);
  const ApplyButton = deletes.records || deletes.values ? DangerButton : PrimaryButton;
  const authors = [...new Set(rows.flatMap(row => row.source?.author ? [row.source.author.name] : []))];
  const sides = new Map(ready?.files.map(file => [file.path, file]) ?? []);
  const retry = phase.kind !== "failed" || phase.retry;

  return <Overlay onClose={() => { if (!busy) props.onClose(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby={testId("title")} data-testid={testId("dialog")}
      className="dohc-elevated flex max-h-[calc(100vh-120px)] w-[min(760px,calc(100vw-32px))] flex-col rounded-xl border border-line bg-panel p-[18px]">
      <div className="flex items-center gap-2.5">
        <h2 id={testId("title")} className="m-0 text-sm font-semibold text-ink">Review source change to {asked.proposal.name}</h2>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-subtle">
          <Kbd>↑</Kbd><Kbd>↓</Kbd> Move <Kbd>Enter</Kbd> Open the file's changes
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2.5 text-[12px] text-muted">
        <span>Change</span>
        {/* One message asks for one change, so there is nothing to pick yet. */}
        <span className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md border border-line bg-bg px-2.5 py-[5px] text-[13px] text-ink">
          <span className="min-w-0 truncate">Change to {asked.proposal.name} · {ready ? ready.files.length : asked.proposal.files.length} files</span>
          {authors.length ? <span className="shrink-0 text-[11px] text-subtle">{authors.join(", ")}</span> : null}
        </span>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-bg p-1">
        {load.kind === "loading" ? <SkeletonRows label="Preparing this change…" className="px-2.5 py-2" /> : null}
        {load.kind === "failed" ? <div role="alert" data-testid={testId("load-failed")} className="flex items-start gap-2 px-2.5 py-2 text-[12px] text-ink">
          <CircleAlert size={14} strokeWidth={1.9} aria-hidden className="mt-px shrink-0 text-danger" />
          <span className="min-w-0 flex-1">{load.words}</span>
          <SecondaryButton size="row" className="shrink-0" onClick={() => setAttempt(value => value + 1)}>Try again</SecondaryButton>
        </div> : null}
        {ready ? <ul className="m-0 list-none p-0" onKeyDown={move}>
          {ready.change.rows.map((row, index) => <ReviewRow key={row.key} row={row} open={open.has(row.key)} onToggle={() => toggle(row.key)}
            buttonRef={element => { rowRefs.current[index] = element; }} sides={sides.get(row.source?.path ?? "")} testId={testId} />)}
        </ul> : null}
      </div>
      {phase.kind === "failed" ? <div role="alert" data-testid={testId("failed")} className="mt-3 flex items-start gap-2 rounded-md border border-danger/45 bg-bg px-2.5 py-2 text-[12px] text-ink">
        <CircleAlert size={14} strokeWidth={1.9} aria-hidden className="mt-px shrink-0 text-danger" />
        <span className="min-w-0">{phase.words}</span>
        <CopyButton iconOnly label="Copy" pinName getText={() => phase.words} />
      </div> : null}
      <div className="mt-3.5 flex items-center gap-2.5">
        <span className="min-w-0 flex-1 text-[12px] text-muted">{historyCanUndoCollectionChange(rows) ? null : CHANGE_LOSS}</span>
        <SecondaryButton data-testid={testId("not-now")} disabled={busy} onClick={() => { props.onNotNow(); props.onClose(); }}>Not now</SecondaryButton>
        {retry ? <ApplyButton data-testid={testId("apply")} disabled={!ready || busy || props.locked} onClick={() => { if (ready) void apply(ready); }}>
          {busy ? "Applying…" : phase.kind === "failed" ? "Try again" : collectionApplyLabel(deletes)}
        </ApplyButton> : null}
      </div>
    </div>
  </Overlay>;
}

function Kbd(props: { children: string }) {
  return <kbd className="rounded border border-line bg-bg px-1 font-mono text-[10px] text-subtle">{props.children}</kbd>;
}

/** One row of the change, and its file's changes once opened. */
function ReviewRow(props: {
  row: CollectionChangeRow;
  open: boolean;
  onToggle: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
  sides: { path: string; before: string; after: string } | undefined;
  testId: (part: string) => string;
}) {
  const words = describeCollectionChangeRow(props.row, "present");
  const { icon: Icon, tone } = CHANGE_ICONS[words.icon];
  const source = props.row.source;
  return <li data-testid={props.testId("row")}>
    <button type="button" ref={props.buttonRef} aria-expanded={props.open} onClick={props.onToggle}
      className="grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 rounded-md px-2.5 py-[7px] text-left text-[13px] hover:bg-panel-2 focus-visible:bg-panel-2">
      <span className={`grid size-[18px] place-items-center ${tone}`}><Icon size={14} strokeWidth={1.9} aria-hidden /></span>
      <span className="font-medium text-ink">{words.text}{words.type ? <span className="font-normal text-muted"> {words.type}</span> : null}</span>
      <ChevronRight size={14} strokeWidth={1.9} aria-hidden className={`mt-0.5 text-subtle transition-transform duration-100 ${props.open ? "rotate-90" : ""}`} />
      {words.effect ? <span className={`col-start-2 flex items-center gap-1.5 text-[12px] ${words.danger ? "text-danger" : "text-muted"}`}>
        {words.danger ? <CircleAlert size={12} strokeWidth={1.9} aria-hidden className="shrink-0" /> : null}
        <span className={words.file ? "font-mono text-[11px]" : undefined}>{words.effect}</span>
      </span> : null}
      {source ? <span className="col-start-2 flex flex-wrap items-center gap-1.5 text-[11px] text-subtle">
        <span className="font-mono">{source.path}</span>
        {source.author ? <><span aria-hidden>·</span><span className={source.author.agent ? "text-agent" : undefined}>{source.author.name}</span></> : null}
        {source.atMs !== null ? <><span aria-hidden>·</span><span>{formatClock(source.atMs)}</span></> : null}
      </span> : null}
    </button>
    {props.open && props.sides ? <FileChanges sides={props.sides} testId={props.testId("diff")} /> : null}
  </li>;
}

function FileChanges(props: { sides: { before: string; after: string }; testId: string }) {
  const lines = useMemo(() => buildUnifiedDiffLines(computeTextDiff(props.sides.before, props.sides.after, 800)), [props.sides]);
  return <div className="mx-2.5 mb-1.5 overflow-hidden rounded-md border border-line bg-panel"><UnifiedDiffLines lines={lines} testId={props.testId} /></div>;
}
