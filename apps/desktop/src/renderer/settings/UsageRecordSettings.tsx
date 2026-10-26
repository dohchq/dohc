import { Archive, EyeOff, HardDrive, Shield, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { INVALID_USAGE_RECORD, type UsageRecordResult, type UsageRecordRow } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { withErrorWords } from "../../ipc/errorWords";
import { ConfirmDialog, ConfirmDialogCard } from "../ui/ConfirmDialog";
import { CopyButton } from "../ui/CopyButton";
import { EmptyState, SecondaryButton } from "../ui/controls";
import { SkeletonRows } from "../ui/SkeletonRows";
import { unreadableNotice, unreadableWords } from "../shell/usageRecordStops";
import { SwitchControl } from "./SettingRow";

// The usage record: counts dohc keeps on this computer and never sends. It is
// not the usage reports above it, which a packaged build sends.
export type UsageRecordView = { status: "loading" } | { status: "failed" } | UsageRecordResult;
type Readable = Extract<UsageRecordResult, { status: "readable" }>;
type Door = keyof UsageRecordRow["doors"];

const DOORS: readonly { door: Door; name: string }[] = [
  { door: "renderer", name: "dohc" },
  { door: "cli", name: "CLI" },
  { door: "mcp", name: "MCP" },
  { door: "automation", name: "Automation" },
];
export const NOT_COUNTED = "Not counted by this version";
const SWITCH_LABEL = "Keep a usage record";
// What to do next. A file dohc cannot decode can be set aside; one it cannot
// open needs the person to fix it.
const unreadableHint = (code: string) => code === INVALID_USAGE_RECORD
  ? "This version of dohc does not recognize its contents. Start a new record, and dohc keeps this file in the same folder."
  : "Fix the file or its permissions at the path below, then try again.";

function total(row: UsageRecordRow): number {
  return DOORS.reduce((sum, { door }) => sum + row.doors[door].count, 0);
}
function counts(row: UsageRecordRow): boolean {
  return DOORS.some(({ door }) => row.doors[door].counted);
}

// Last used first, then what this build counts, then by name.
function ordered(rows: readonly UsageRecordRow[]): UsageRecordRow[] {
  return rows.toSorted((a, b) =>
    (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "")
    || total(b) - total(a)
    || Number(counts(b)) - Number(counts(a))
    || a.label.localeCompare(b.label));
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayWords(day: string, today: string): string {
  if (day === today) return "today";
  const date = new Date(`${day}T12:00:00`);
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  if (localDay(next) === today) return "yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** What Copy puts on the clipboard: the rows and what this build counts. No
 * paths and no content. */
export function usageRecordText(record: Readable): string {
  const cell = (row: UsageRecordRow, door: Door) => {
    const { count, counted } = row.doors[door];
    if (counted) return String(count);
    return count > 0 ? `${count} (not counted by this version)` : "not counted";
  };
  return [
    "dohc usage record",
    `Counting: ${record.enabled ? "on" : "off"}`,
    record.since ? `Since ${record.since}. Partly counted days: ${record.incompleteDays}.` : "No days recorded.",
    ["Capability", ...DOORS.map(({ name }) => name), "Last used"].join("\t"),
    ...record.rows.map((row) =>
      [row.capabilityId, ...DOORS.map(({ door }) => cell(row, door)), row.lastUsed ?? ""].join("\t")),
  ].join("\n");
}

function NotCounted() {
  return (
    <span title={NOT_COUNTED} className="inline-flex text-subtle">
      <EyeOff size={12} aria-hidden />
      <span className="sr-only">{NOT_COUNTED}</span>
    </span>
  );
}

// A count an earlier version saved for a door this one does not count keeps
// its number and takes the mark: no newer use adds to it.
function Cell(props: { cell: UsageRecordRow["doors"][Door] }) {
  const { count, counted } = props.cell;
  if (counted) return count > 0 ? <>{count}</> : <span className="sr-only">0</span>;
  if (count === 0) return <NotCounted />;
  return <span className="inline-flex items-center gap-1.5">{count}<NotCounted /></span>;
}

function Table(props: { rows: readonly UsageRecordRow[]; today: string }) {
  // A door this build never counts is marked in its heading too, whatever
  // counts earlier versions saved there.
  const neverCounted = new Set(DOORS.filter(({ door }) => props.rows.every((row) => !row.doors[door].counted)).map(({ door }) => door));
  return (
    <div role="region" tabIndex={0} aria-label="Usage record counts" className="max-h-[320px] overflow-auto focus-visible:-outline-offset-2">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 bg-panel">
          <tr>
            {["Capability", ...DOORS.map(({ name }) => name), "Last used"].map((name, index) => {
              const door = DOORS[index - 1]?.door;
              return (
                <th key={name} scope="col" className="border-b border-line px-3 py-2 text-left text-[12px] font-medium text-subtle">
                  <span className="inline-flex items-center gap-1">
                    {name}
                    {door && neverCounted.has(door) ? <NotCounted /> : null}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered(props.rows).map((row) => {
            const counted = counts(row);
            return (
              <tr key={row.capabilityId} data-testid={`usage-record-row-${row.capabilityId}`} data-counted={counted}>
                <th scope="row" className={`border-b border-line px-3 py-[7px] text-left font-sans font-normal ${counted ? "text-ink" : "text-muted"}`}>
                  {row.label}
                </th>
                {DOORS.map(({ door }) => (
                  <td key={door} data-door={door} className="border-b border-line px-3 py-[7px] font-mono tabular-nums text-ink">
                    <Cell cell={row.doors[door]} />
                  </td>
                ))}
                <td className="border-b border-line px-3 py-[7px] font-mono text-subtle">
                  {row.lastUsed ? dayWords(row.lastUsed, props.today) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function UsageRecordCard(props: {
  view: UsageRecordView;
  today: string;
  busy?: boolean;
  onSwitch(enabled: boolean): void;
  onClear(): void;
  onRetry(): void;
  onStart(): void;
  onRestore(): void;
}) {
  const { view } = props;
  const titleId = useId();
  const readable = view.status === "readable" ? view : null;
  const used = readable ? readable.rows.some((row) => total(row) > 0) : false;
  // Off with nothing saved has nothing to keep or clear; the empty state says so.
  const keptOff = readable && !readable.enabled && used;
  const clear = used && (
    <SecondaryButton size="row" data-testid="usage-record-clear" disabled={props.busy} aria-disabled={props.busy}
      onClick={props.onClear}>
      Clear
    </SecondaryButton>
  );
  return (
    <section data-testid="usage-record" data-state={readable ? (readable.enabled ? "on" : "off") : view.status}
      aria-labelledby={titleId} className="mt-4 overflow-hidden rounded-lg border border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3 text-[13px]">
        <Shield size={14} aria-hidden className="shrink-0 text-muted" />
        <h3 id={titleId} className="m-0 text-[13px] font-medium text-ink">What dohc records about use</h3>
        {readable?.since ? (
          <span className="font-mono text-[11px] text-subtle">since {dayWords(readable.since, props.today)}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {keptOff ? clear : null}
          {readable ? (
            <SwitchControl label={SWITCH_LABEL} checked={readable.enabled} disabled={props.busy} onChange={props.onSwitch} />
          ) : (
            <span aria-hidden className="h-5 w-9" />
          )}
        </span>
      </header>
      {keptOff ? (
        <p data-testid="usage-record-off" className="m-0 border-b border-line bg-panel-2 px-4 py-2 text-[12px] text-muted">
          Off. dohc keeps the saved counts and adds none. Clear removes them.
        </p>
      ) : null}
      {view.status === "loading" ? (
        <SkeletonRows label="Loading the usage record…" rows={4} className="p-4" testId="usage-record-loading" />
      ) : view.status === "failed" ? (
        <div className="py-6">
          <EmptyState icon={TriangleAlert} tone="danger" title="dohc could not open the usage record." data-testid="usage-record-failed">
            <SecondaryButton size="row" onClick={props.onRetry}>Try again</SecondaryButton>
          </EmptyState>
        </div>
      ) : view.status === "unreadable" ? (
        <div className="py-6">
          <EmptyState icon={TriangleAlert} tone="danger" data-testid="usage-record-unreadable"
            title={unreadableWords(view.code)} hint={unreadableHint(view.code)}>
            {view.code === INVALID_USAGE_RECORD ? (
              <SecondaryButton size="row" data-testid="usage-record-start" disabled={props.busy} aria-disabled={props.busy}
                onClick={props.onStart}>
                Start a new record
              </SecondaryButton>
            ) : (
              <SecondaryButton size="row" data-testid="usage-record-retry" onClick={props.onRetry}>Try again</SecondaryButton>
            )}
          </EmptyState>
        </div>
      ) : used ? (
        <Table rows={view.rows} today={props.today} />
      ) : (
        <div className="py-6">
          <EmptyState data-testid="usage-record-empty"
            title={view.enabled ? "Nothing counted yet." : "No counts saved."}
            hint={view.enabled
              ? "dohc adds a count when you finish an action it counts, such as creating a version."
              : "Turn the record on to count what you do in dohc."} />
        </div>
      )}
      {view.status === "readable" || view.status === "unreadable" ? (
        <footer className="flex items-center gap-3 border-t border-line px-4 py-2.5 text-[12px] text-muted">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {used ? (
              <span className="inline-flex items-center gap-1.5">
                <NotCounted />
                <span aria-hidden>{NOT_COUNTED}</span>
              </span>
            ) : null}
            <span className="flex min-w-0 items-center gap-1.5">
              <HardDrive size={12} aria-hidden className="shrink-0 text-success" />
              <code data-testid="usage-record-file" title={view.file} className="min-w-0 select-text truncate font-mono text-[11px] text-ink">
                {view.file}
              </code>
              <span className="shrink-0">dohc never sends it.</span>
            </span>
          </div>
          {readable ? (
            <span className="flex shrink-0 items-center gap-1.5">
              <CopyButton testId="usage-record-copy" getText={() => usageRecordText(readable)} />
              {readable.enabled ? clear : null}
            </span>
          ) : null}
        </footer>
      ) : null}
      {(view.status === "readable" || view.status === "unreadable") && view.setAside ? (
        <SetAsideRow name={view.setAside} busy={props.busy} onRestore={props.onRestore} />
      ) : null}
    </section>
  );
}

// The record set aside last, in the record's folder. Restore swaps it back.
function SetAsideRow(props: { name: string; busy?: boolean | undefined; onRestore(): void }) {
  return (
    <div data-testid="usage-record-set-aside" role="group" aria-label="Usage record set aside"
      className="flex items-center gap-1.5 border-t border-line px-4 py-2.5 text-[12px] text-muted">
      <Archive size={12} aria-hidden className="shrink-0 text-subtle" />
      <code title={props.name} className="min-w-0 select-text truncate font-mono text-[11px] text-ink">{props.name}</code>
      <CopyButton iconOnly label="Copy the file name" testId="usage-record-set-aside-copy" getText={() => props.name} />
      <SecondaryButton size="row" data-testid="usage-record-restore" className="ml-auto" disabled={props.busy}
        aria-disabled={props.busy} onClick={props.onRestore}>
        Restore
      </SecondaryButton>
    </div>
  );
}

type ReportFailure = (message: string, cause?: unknown, retry?: () => Promise<void>) => void;

/** Clear's confirm. It offers Copy first, because Clear cannot be undone. */
export function UsageRecordClearConfirm(props: { record: Readable; card?: boolean; onCancel(): void; onConfirm(): void }) {
  const Dialog = props.card ? ConfirmDialogCard : ConfirmDialog;
  return (
    <Dialog intent="danger" title="Clear the usage record?" confirmLabel="Clear record"
      testId="usage-record-clear-confirm" cancelTestId="usage-record-clear-cancel" confirmTestId="usage-record-clear-action"
      onCancel={props.onCancel} onConfirm={props.onConfirm}>
      <p className="mt-2 text-[13px] text-muted">
        This deletes every saved count on this computer. dohc cannot restore them. Copy the record first to keep it.
      </p>
      <div className="mt-3">
        <CopyButton label="Copy the record" testId="usage-record-clear-copy" getText={() => usageRecordText(props.record)} />
      </div>
    </Dialog>
  );
}

/** Privacy's usage record. It reads once when Privacy opens and after each
 * change, and never polls. A read that answers after Privacy closed, or after
 * a newer read started, is dropped, unless Try again in Notices asked for it
 * after Privacy closed. */
export function UsageRecordSettings(props: { onError?: ReportFailure | undefined }) {
  const [view, setView] = useState<UsageRecordView>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const live = useRef(true);
  const reads = useRef(0);
  const onError = useRef(props.onError);
  onError.current = props.onError;

  const read = useCallback(async function read(fromNotices = false): Promise<void> {
    const attempt = ++reads.current;
    const current = () => live.current && attempt === reads.current;
    const owed = () => current() || fromNotices && !live.current;
    const retry = () => read(true);
    try {
      const result = await bridge().readUsageRecord({});
      if (current()) setView(result);
      // The card keeps the record safe from writes; Notices keeps the problem.
      if (result.status === "unreadable" && owed()) onError.current?.(unreadableNotice(result.code), undefined, retry);
    } catch (cause) {
      if (current()) setView({ status: "failed" });
      if (owed()) onError.current?.(withErrorWords("dohc could not open the usage record.", cause), cause, retry);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void read();
    return () => {
      live.current = false;
    };
  }, [read]);

  // `retryable` offers Try again in Notices. Clear never does: it confirms first.
  const change = async (run: () => Promise<void>, failure: string, retryable = false): Promise<void> => {
    setBusy(true);
    try {
      await run();
    } catch (cause) {
      // Reported even after Privacy closed: the shell keeps it in Notices.
      const words = withErrorWords(failure, cause);
      if (retryable) onError.current?.(words, cause, () => change(run, failure, true));
      else onError.current?.(words, cause);
    }
    // Read after a failure too, so the card shows what main kept.
    await read();
    if (live.current) setBusy(false);
  };

  return (
    <>
      <UsageRecordCard
        view={view}
        today={localDay(new Date())}
        busy={busy}
        onSwitch={(enabled) => void change(
          () => bridge().setUsageRecordEnabled({ enabled }),
          enabled ? "dohc could not turn the usage record on." : "dohc could not turn the usage record off.",
        )}
        onClear={() => setConfirming(true)}
        onRetry={() => {
          setView({ status: "loading" });
          void read();
        }}
        onStart={() => void change(() => bridge().startUsageRecord({}), "dohc could not start a new usage record.", true)}
        onRestore={() => void change(() => bridge().restoreUsageRecord({}), "dohc could not restore the usage record set aside.", true)}
      />
      {confirming && view.status === "readable"
        ? createPortal(
            <UsageRecordClearConfirm
              record={view}
              onCancel={() => setConfirming(false)}
              onConfirm={() => {
                setConfirming(false);
                void change(() => bridge().clearUsageRecord({}), "dohc could not clear the usage record.");
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}
