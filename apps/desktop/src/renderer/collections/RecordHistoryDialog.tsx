import { History as HistoryIcon, LoaderCircle, Zap } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RecordHistoryEntry } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { relativeTime } from "../relativeTime";
import { SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { HISTORY_READ_FAILED } from "./useRecordHistory";

// A record's History: its field changes, newest first, a page at a time,
// read only while the dialog is open. An automation's changes name it as it
// was called when it ran, and open that run in the ⚡ panel when this
// computer or the owner's server keeps it and shows it to this person. The
// page shows at once; a run this computer does not keep says nothing until
// main has asked the server. The author stays when the run does not.

type Author = NonNullable<RecordHistoryEntry["author"]>;
type AutomationAuthor = Extract<Author, { kind: "automation" }>;
/** Where this person can open a run; "pending" while main asks, "unknown" when it could not. */
type RunState = "available" | "unavailable" | "unknown" | "pending";

// Asked at once, so a page of runs does not flood the relay.
const LOOKUPS_AT_ONCE = 4;

/** Changes one author made together: an automation run's, or one change. */
interface Group {
  key: string;
  author: RecordHistoryEntry["author"];
  recordedAtMs: number;
  changes: RecordHistoryEntry[];
}

export const RUN_NOT_HERE = "Run not on this computer";
export const RUN_NOT_HERE_WHY = "dohc keeps runs for 30 days after they end, on the computer that ran them.";

function valueText(side: RecordHistoryEntry["previous"]): string {
  const value = side.value;
  if (!side.present || value === null || value === "") return "empty";
  if (Array.isArray(value)) return value.length === 0 ? "empty" : value.map((item) => valueText({ present: true, value: item })).join(", ");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function runOf(author: RecordHistoryEntry["author"]): string | null {
  return author?.kind === "automation" && author.run !== null ? `${author.automationId}\n${author.run.claimId}` : null;
}

function runState(author: AutomationAuthor, located: ReadonlyMap<string, RunState>): RunState | null {
  if (author.run === null) return null;
  return author.run.location === "available" ? "available" : located.get(runOf(author)!) ?? "pending";
}

/** Newest first, with an automation run's changes side by side. */
export function recordHistoryGroups(entries: readonly RecordHistoryEntry[]): Group[] {
  const groups: Group[] = [];
  for (const entry of entries) {
    const run = runOf(entry.author);
    const last = groups.at(-1);
    if (run !== null && last !== undefined && runOf(last.author) === run) {
      last.changes.push(entry);
      continue;
    }
    groups.push({ key: String(entry.historyId), author: entry.author, recordedAtMs: entry.recordedAtMs, changes: [entry] });
  }
  return groups;
}

function AuthorName(props: { author: Author; id: string }) {
  const { author } = props;
  if (author.kind === "agent") {
    return <span id={props.id} className="min-w-0 truncate text-[12px] text-agent">{author.name}</span>;
  }
  return (
    <span id={props.id} data-testid="record-history-automation" className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted">
      <Zap size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
      <span className="sr-only">Automation </span>
      <span className="truncate">{author.name}</span>
    </span>
  );
}

function RunLink(props: { author: AutomationAuthor; state: RunState | null; describedBy: string; onOpenRun: (automationId: string, claimId: string, name: string) => void }) {
  const { author, state } = props;
  if (author.run === null || state === null || state === "pending" || state === "unknown") return null;
  if (state === "unavailable") {
    // Padded as View run is, so the two line up down the list.
    return <span data-testid="record-history-run-not-here" className="shrink-0 px-1.5 text-[11px] text-subtle">{RUN_NOT_HERE}</span>;
  }
  const claimId = author.run.claimId;
  return (
    <button
      type="button"
      aria-describedby={props.describedBy}
      onClick={() => props.onOpenRun(author.automationId, claimId, author.name)}
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
    >
      View run
    </button>
  );
}

function GroupRow(props: { group: Group; located: ReadonlyMap<string, RunState>; onOpenRun: (automationId: string, claimId: string, name: string) => void }) {
  const { group } = props;
  const authorId = useId();
  return (
    <li data-testid="record-history-entry" className="border-b border-line py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        {group.author === null ? null : <AuthorName author={group.author} id={authorId} />}
        {group.author?.kind === "automation" ? (
          <RunLink author={group.author} state={runState(group.author, props.located)} describedBy={authorId} onOpenRun={props.onOpenRun} />
        ) : null}
        <time
          dateTime={new Date(group.recordedAtMs).toISOString()}
          title={new Date(group.recordedAtMs).toLocaleString()}
          className="ml-auto shrink-0 font-mono text-[11px] text-subtle"
        >
          {relativeTime(group.recordedAtMs)}
        </time>
      </div>
      <ul className="m-0 mt-1 list-none space-y-0.5 p-0">
        {group.changes.map((change) => (
          <li key={change.historyId} className="break-words font-mono text-[11px] leading-snug text-ink">
            {change.field}: <span className="text-muted">{valueText(change.previous)} → </span>{valueText(change.next)}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function RecordHistoryDialog(props: {
  workspaceId: string;
  collectionPath: string;
  recordId: string;
  recordName: string;
  /** An older page to read back to after the first, by its beforeHistoryId. */
  until?: number | null;
  onClose: () => void;
  onOpenRun: (automationId: string, claimId: string, name: string) => void;
  /** A read failed: the page it asked for, or null for the first. */
  onFailed: (before: number | null, error: unknown) => void;
  /** A read landed: where the page after it starts, or null at the end. */
  onRead: (next: number | null) => void;
  /** dohc could not place a run shown; Try again reads back to `until`, the oldest page read. */
  onRunsUnchecked: (until: number | null, error: unknown, runs: readonly string[]) => void;
  /** dohc placed these runs, by their automation and claim ids. */
  onRunsChecked: (runs: readonly string[]) => void;
}) {
  const { workspaceId, collectionPath, recordId } = props;
  const [page, setPage] = useState<{ entries: RecordHistoryEntry[]; next: number | null } | null>(null);
  // The page being read: the first, or the one after the last shown.
  const [loading, setLoading] = useState<"first" | "older" | null>(null);
  // A page could not be read, so the dialog says so and offers Try again inside it; null when none failed.
  const [failed, setFailed] = useState<number | "first" | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const older = useRef<HTMLButtonElement | null>(null);
  const retry = useRef<HTMLButtonElement | null>(null);
  // Try again, or Older changes on the last page, had focus as its page came, so the dialog takes it as the button goes.
  const focusPanel = useRef(false);
  // Older changes had focus when its page failed, so Try again, which takes its place, takes focus.
  const focusRetry = useRef(false);
  // A caller may pass new functions each render; a read must not start again for that.
  const reports = useRef(props);
  reports.current = props;
  // A slow answer for another record, workspace, or an earlier read never lands.
  const request = useRequestSequence([workspaceId, collectionPath, recordId]);
  // Where each run this computer does not keep can be opened, by runOf.
  const [located, setLocated] = useState<ReadonlyMap<string, RunState>>(new Map());
  // Each run is asked about once, a few at a time, while the record stays.
  const lookups = useRequestSequence([workspaceId, collectionPath, recordId]);
  const asked = useRef(new Set<string>());
  const queue = useRef<Array<{ key: string; automationId: string; claimId: string }>>([]);
  const asking = useRef(0);
  const lookupError = useRef<unknown>(null);
  // The runs Notices already says dohc could not place.
  const reportedUnchecked = useRef(new Set<string>());
  // The oldest page read, by the beforeHistoryId it asked with.
  const oldest = useRef<number | null>(null);

  const lookUp = useCallback((): void => {
    const epoch = lookups.current();
    while (asking.current < LOOKUPS_AT_ONCE && queue.current.length > 0) {
      const run = queue.current.shift()!;
      asking.current += 1;
      void (async () => {
        let state: RunState;
        let error: unknown = null;
        try {
          state = (await bridge().locateRecordHistoryRun({ workspaceId, automationId: run.automationId, claimId: run.claimId })).location;
        } catch (caught) {
          state = "unknown";
          error = caught;
        }
        if (!lookups.isCurrent(epoch)) return;
        asking.current -= 1;
        if (state === "unknown") lookupError.current ??= error;
        setLocated((current) => new Map(current).set(run.key, state));
        lookUp();
      })();
    }
  }, [workspaceId, lookups]);

  const load = useCallback((before: number | null) => {
    const token = request.next();
    setLoading(before === null ? "first" : "older");
    void bridge()
      .getCollectionRecordHistory({ workspaceId, collectionPath, recordId, ...(before === null ? {} : { beforeHistoryId: before }) })
      .then((result) => {
        if (!request.isCurrent(token)) return;
        reports.current.onRead(result.nextBeforeHistoryId);
        const focused = document.activeElement;
        focusPanel.current = focused === retry.current || (focused === older.current && result.nextBeforeHistoryId === null);
        setFailed(null);
        oldest.current = before;
        for (const { author } of result.entries) {
          if (author?.kind !== "automation" || author.run?.location !== "unchecked") continue;
          const key = runOf(author)!;
          if (asked.current.has(key)) continue;
          asked.current.add(key);
          queue.current.push({ key, automationId: author.automationId, claimId: author.run.claimId });
        }
        lookUp();
        setPage((current) => {
          if (before === null || current === null) return { entries: result.entries, next: result.nextBeforeHistoryId };
          const shown = new Set(current.entries.map((entry) => entry.historyId));
          return { entries: [...current.entries, ...result.entries.filter((entry) => !shown.has(entry.historyId))], next: result.nextBeforeHistoryId };
        });
        // Read on until the page asked for is shown.
        const until = reports.current.until ?? null;
        const next = result.nextBeforeHistoryId;
        if (until !== null && next !== null && next >= until) load(next);
      })
      .catch((error: unknown) => {
        if (request.isCurrent(token)) {
          focusRetry.current = document.activeElement === older.current;
          setFailed(before ?? "first");
          reports.current.onFailed(before, error);
        }
      })
      .finally(() => {
        if (request.isCurrent(token)) setLoading(null);
      });
  }, [workspaceId, collectionPath, recordId, request, lookUp]);

  useEffect(() => {
    setPage(null);
    setFailed(null);
    setLocated(new Map());
    asked.current = new Set();
    queue.current = [];
    asking.current = 0;
    lookupError.current = null;
    reportedUnchecked.current = new Set();
    oldest.current = null;
    load(null);
  }, [load]);

  // Said once the reads and lookups settle, so Try again reads back to every
  // page shown, and said again only for a run newly left unplaced.
  useEffect(() => {
    if (page === null || loading !== null) return;
    const states = page.entries.flatMap(({ author }) =>
      author?.kind === "automation" && author.run !== null ? [{ key: runOf(author)!, state: runState(author, located) }] : []);
    if (states.some(({ state }) => state === "pending")) return;
    const placed = states.filter(({ state }) => state === "available" || state === "unavailable").map(({ key }) => key);
    if (placed.length > 0) reports.current.onRunsChecked(placed);
    const unknown = states.filter(({ state }) => state === "unknown").map(({ key }) => key);
    if (unknown.every((key) => reportedUnchecked.current.has(key))) return;
    for (const key of unknown) reportedUnchecked.current.add(key);
    reports.current.onRunsUnchecked(oldest.current, lookupError.current, unknown);
  }, [page, located, loading]);

  const status = failed !== null ? HISTORY_READ_FAILED
    : page === null ? "Loading history…"
    : page.entries.length === 0 ? "No field of this record has changed yet." : "";

  useEffect(() => {
    if (!focusRetry.current) return;
    focusRetry.current = false;
    retry.current?.focus();
  }, [failed]);

  useEffect(() => {
    if (!focusPanel.current) return;
    focusPanel.current = false;
    panel.current?.focus();
  }, [page]);

  return (
    <Overlay
      onClose={props.onClose}
      panelRef={panel}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-label": `History of ${props.recordName}`,
        "data-testid": "record-history",
        className: "dohc-elevated dohc-pop-in flex max-h-[85vh] w-[min(560px,92vw)] flex-col gap-3 rounded-xl border border-line bg-panel p-5 text-ink",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 flex min-w-0 items-center gap-2 text-sm font-semibold">
          <HistoryIcon size={16} strokeWidth={1.9} aria-hidden className="shrink-0" />
          <span className="truncate">History · {props.recordName}</span>
        </h2>
        <SecondaryButton onClick={props.onClose}>Close</SecondaryButton>
      </div>
      {page === null || page.entries.length === 0 ? null : (
        <ul className="m-0 min-h-0 list-none overflow-auto p-0">
          {recordHistoryGroups(page.entries).map((group) => (
            <GroupRow key={group.key} group={group} located={located} onOpenRun={props.onOpenRun} />
          ))}
        </ul>
      )}
      {/* One status line that stays mounted, so a screen reader hears each change of its words. */}
      <div className={status === "" ? "sr-only" : "flex items-center gap-2"}>
        <p role="status" className="m-0 text-[12px] text-muted">{status}</p>
        {failed === null ? null : (
          <SecondaryButton
            ref={retry}
            size="compact"
            className="inline-flex items-center gap-1.5 aria-disabled:cursor-wait aria-disabled:opacity-50"
            aria-disabled={loading !== null || undefined}
            aria-busy={loading !== null}
            onClick={() => {
              if (loading === null) load(failed === "first" ? null : failed);
            }}
          >
            {loading === null ? null : <LoaderCircle aria-hidden size={12} strokeWidth={1.9} className="shrink-0 animate-spin" />}
            Try again
          </SecondaryButton>
        )}
      </div>
      {/* Said once, as text everyone reads, not in a tooltip on each row. */}
      {page?.entries.some(({ author }) => author?.kind === "automation" && runState(author, located) === "unavailable") ? (
        <p data-testid="record-history-run-not-here-why" className="m-0 text-[12px] text-muted">{RUN_NOT_HERE_WHY}</p>
      ) : null}
      {page !== null && page.next !== null && failed === null ? (
        <div className="flex justify-center">
          {/* aria-disabled, not disabled, so a keyboard press keeps focus here while the page loads. */}
          <SecondaryButton
            ref={older}
            size="compact"
            className="inline-flex items-center gap-1.5 aria-disabled:cursor-wait aria-disabled:opacity-50"
            aria-disabled={loading === "older" || undefined}
            aria-busy={loading === "older"}
            onClick={() => {
              if (loading === null) load(page.next);
            }}
          >
            {loading === "older" ? <LoaderCircle aria-hidden size={12} strokeWidth={1.9} className="shrink-0 animate-spin" /> : null}
            Older changes
          </SecondaryButton>
        </div>
      ) : null}
    </Overlay>
  );
}
