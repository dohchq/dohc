import { formatChatTime, formatClock } from "../time";
import { basenameOf, dirnameOf } from "../path";
import { ChevronDown, ChevronRight, Cloud, Database, FileArchive, HardDrive, History, Info, Keyboard, Layers, Lock, PenLine, RotateCcw, Search, TriangleAlert, X, Zap, type LucideIcon } from "lucide-react";
import { EmptyState } from "../ui/controls";
import { Ref } from "../ui/Ref";
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { LegendList } from "@legendapp/list/react";
import { HISTORY_MAX_SOURCES, type EngineMomentRecord, type SyncStatusResult, type TimelineEntry } from "../../ipc/bridgeContract";
import { chatAuthorLabel } from "./chatMessages";
import { AgentName, ChatAvatar, LinkMark } from "./ChatAvatar";
import { neutralPresentation } from "./actorPresentation";

// The History timeline: file moments, version markers and Collection
// changes, newest first, in the order main merged them. File moments keep
// their summaries ("Saved latest edits", "Merged version X into Main",
// "Changed while dohc was closed", ...) and a multi-file pass (reconcile, switch,
// merge, restore) groups into one expandable item via its correlationId.
// An agent's consecutive edits to one file fold into one row, a run.
// Product vocabulary only, no git terms.

interface EngineHistoryGroup {
  key: string;
  // A run lists one agent's edits to one file; a pass lists the files it changed.
  run: boolean;
  summary: string;
  recordedAtMs: number;
  correlationId?: string;
  moments: EngineMomentRecord[];
}

type VersionEntry = Extract<TimelineEntry, { kind: "version" }>;
type CollectionEntry = Extract<TimelineEntry, { kind: "collection" }>;

export type TimelineItem =
  | { kind: "files"; key: string; group: EngineHistoryGroup }
  | { kind: "version"; key: string; version: VersionEntry["version"] }
  | { kind: "collection"; key: string; entry: CollectionEntry };

// The Collections a timeline can name and open on their History, with each
// operation's label by its name. A Collection this computer cannot open has
// no `openHistory`.
export type HistoryCollections = ReadonlyMap<string, {
  name: string;
  operationLabels?: ReadonlyMap<string, string>;
  openHistory?: () => void;
}>;

// History still taking in recent changes. Nothing failed and the reader has
// nothing to do, so it offers no control: the next read replaces it.
export function HistoryUpdating(props: { testId: string; className?: string }) {
  return (
    <p role="status" data-testid={props.testId} className={`m-0 flex items-center gap-2 text-xs text-muted ${props.className ?? ""}`}>
      <span aria-hidden className={MARK_BOX}>
        <span className="size-2 animate-pulse rounded-full bg-accent" />
      </span>
      Adding recent changes to History
    </p>
  );
}

// Whether main's status shows the Notices row "History paused": capture
// failed, and not because the store was refused, which has its own notice.
export function isHistoryPaused(syncStatus: SyncStatusResult | null | undefined): boolean {
  return syncStatus?.historyCaptureFailed === true && !syncStatus.engineStoreRefused;
}

// History stopped recording: main's status says capture failed, and the
// Notices row says why. Rereading doesn't end it, so it offers no control. It
// also heads a page read during the pause, which may be missing changes. Its
// dot sits in a row's icon slot, so the words start where the names do.
export function HistoryPaused(props: { testId: string; className?: string }) {
  return (
    <p role="status" data-testid={props.testId} className={`m-0 flex items-center gap-2 text-xs text-muted ${props.className ?? ""}`}>
      <span aria-hidden className={MARK_BOX}>
        <span className="size-2 rounded-full bg-warning" />
      </span>
      History paused
    </p>
  );
}

// The list label for one moment: its real engine summary when it has one,
// else calm product copy derived from the operation.
export function engineMomentSummary(
  moment: Pick<EngineMomentRecord, "summary" | "operation" | "path" | "contentKind" | "byteLength">,
): string {
  if (moment.summary) return moment.summary;
  if (moment.operation === "rename") return `Renamed to ${basenameOf(moment.path)}`;
  if (moment.operation === "delete") return `Deleted ${basenameOf(moment.path)}`;
  if (moment.contentKind === "binary") {
    return `Updated ${basenameOf(moment.path)} (${moment.byteLength ?? 0} bytes)`;
  }
  return `Edited ${basenameOf(moment.path)}`;
}

function engineOperationLabel(moment: EngineMomentRecord): string {
  if (moment.operation === "delete") return "Deleted";
  if (moment.operation === "rename") return "Renamed";
  return "Changed";
}

// One human label for where a moment came from. Engine moments are
// actor-neutral by default (origin, not author).
export function engineOriginLabel(origin: EngineMomentRecord["origin"]): string {
  switch (origin) {
    case "local-file":
      return "Local file edit";
    case "restore":
      return "Restore";
    case "sync":
      return "Sync";
    case "api":
      return "dohc";
    case "ydoc":
      return "Live edit";
    // Text capture kept when its file changed outside dohc, in the words
    // of its notice. Dismissing or restoring it leaves the same change.
    case "capture-recovery":
    case "capture-recovery-cleared":
      return "Text kept";
    default:
      return "Unknown source";
  }
}

// A moment authored by a dohc-tracked agent run displays as
// "the agent name" (the same formatting rule the chat rail uses via
// chatAuthorLabel), and one a Collection automation authored as the
// automation's name and its Collection. An Edit link's direct file write
// names the link and a short id for its holder; an app submission names the
// holder with the same short id, so it never reads like an Edit link's write. A
// restore names this computer's person who made it; their other edits read as a local file
// edit or a live edit. A live edit the relay admitted from an account or link
// holder names them. Everything else keeps its actor-neutral origin label.
export function engineMomentSourceLabel(
  moment: Pick<EngineMomentRecord, "origin" | "agentAuthorName" | "personAuthorName" | "liveAuthorName" | "publicAuthor" | "linkAuthor" | "automationAuthor" | "namedAuthor" | "authorLabels">,
): string {
  if (moment.origin === "restore" && moment.personAuthorName !== undefined) return moment.personAuthorName;
  if (moment.authorLabels) {
    const [first, second, third, ...rest] = moment.authorLabels;
    const shown = [first, second, third].filter((label): label is string => label !== undefined).join(", ");
    return rest.length ? `${shown} and ${rest.length} more` : shown;
  }
  if (moment.liveAuthorName) return moment.liveAuthorName;
  if (moment.publicAuthor) return `Link holder ${moment.publicAuthor.principalId.replace(/^public_/, "").slice(0, 8)}`;
  if (moment.linkAuthor) return `Edit link · holder ${moment.linkAuthor.principalId.slice(0, 8)}`;
  if (moment.automationAuthor) {
    const { name, collection } = moment.automationAuthor;
    return collection === undefined ? name : `${name} in ${collection}`;
  }
  if (moment.namedAuthor) return moment.namedAuthor.label;
  return moment.agentAuthorName !== undefined
    ? chatAuthorLabel({ authorKind: "agent", authorDisplayName: moment.agentAuthorName })
    : engineOriginLabel(moment.origin);
}

// Where a moment came from, as one line of History. An automation's name
// and Collection follow the ⚡ mark, in words, so nothing waits behind hover.
export function EngineMomentSource(props: {
  moment: Pick<EngineMomentRecord, "origin" | "agentAuthorName" | "personAuthorName" | "liveAuthorName" | "publicAuthor" | "linkAuthor" | "automationAuthor" | "namedAuthor" | "authorLabels">;
  testId: string;
  id?: string;
}) {
  const { moment } = props;
  if (moment.automationAuthor) {
    return (
      <span id={props.id} data-testid={props.testId} className="inline-flex items-center gap-1 text-muted">
        <Zap size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
        <span className="sr-only">Automation </span>
        {engineMomentSourceLabel(moment)}
      </span>
    );
  }
  // Agent-authored moments speak in the olive attribution voice; everything
  // else is a neutral origin in ink.
  return (
    <span
      data-testid={props.testId}
      className={moment.agentAuthorName !== undefined ? "text-agent" : "text-muted"}
    >
      {engineMomentSourceLabel(moment)}
    </span>
  );
}

// The group-level author: the shared agent author name when every moment in
// the group carries the same one, else undefined (mixed or neutral groups
// stay unlabeled — never a guessed attribution).
export function groupAgentAuthorName(
  moments: readonly Pick<EngineMomentRecord, "agentAuthorName">[],
): string | undefined {
  const first = moments[0]?.agentAuthorName;
  if (first === undefined) return undefined;
  return moments.every((moment) => moment.agentAuthorName === first)
    ? first
    : undefined;
}

// The one agent that made a moment, by its stable id. Two agents can share a
// name, so a run never compares names.
function soleAgentId(moment: EngineMomentRecord): string | undefined {
  const [author, ...others] = moment.authors ?? [];
  return author?.kind === "agent" && others.length === 0 ? author.agentId : undefined;
}

// Whether `older` continues the run `newer` is in: the same agent editing the
// same file, on the same day.
function continuesRun(newer: EngineMomentRecord, older: EngineMomentRecord): boolean {
  const agentId = soleAgentId(newer);
  return agentId !== undefined && agentId === soleAgentId(older) &&
    newer.path === older.path && newer.operation === "write" && older.operation === "write" &&
    dayKey(newer.recordedAtMs) === dayKey(older.recordedAtMs);
}

// Keeps the order main merged and groups consecutive file moments that share
// a correlationId (one pass records its per-file moments contiguously on the
// capture chain). A version or Collection row between them ends the group.
// An agent's consecutive edits to one file fold into a run, keyed by its
// oldest edit so a new edit on top keeps the row. Each edit may carry its own
// one-moment operation; a moment of a multi-file pass never joins a run.
// Other moments stay single.
export function groupTimeline(entries: readonly TimelineEntry[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.kind === "version") {
      items.push({ kind: "version", key: `version:${entry.version.id}`, version: entry.version });
      continue;
    }
    if (entry.kind === "collection") {
      items.push({ kind: "collection", key: `collection:${entry.datasetId}:${entry.change.revision}`, entry });
      continue;
    }
    const { moment } = entry;
    const previous = items[items.length - 1];
    if (
      previous?.kind === "files" &&
      moment.correlationId !== undefined &&
      previous.group.correlationId === moment.correlationId
    ) {
      previous.group.moments.push(moment);
      continue;
    }
    const next = entries[index + 1];
    const startsPass = moment.correlationId !== undefined && next?.kind === "file" && next.moment.correlationId === moment.correlationId;
    if (previous?.kind === "files" && (previous.group.run || previous.group.moments.length === 1) && !startsPass &&
      continuesRun(previous.group.moments[previous.group.moments.length - 1]!, moment)) {
      previous.group.moments.push(moment);
      previous.group.run = true;
      previous.key = previous.group.key = moment.id;
      continue;
    }
    items.push({
      kind: "files",
      key: moment.id,
      group: {
        key: moment.id,
        run: false,
        summary: engineMomentSummary(moment),
        recordedAtMs: moment.recordedAtMs,
        ...(moment.correlationId !== undefined
          ? { correlationId: moment.correlationId }
          : {}),
        moments: [moment],
      },
    });
  }
  return items;
}

export type MomentStep = { momentId: string; path: string };
export type MomentSteps = { older: MomentStep | null; newer: MomentStep | null };

// Each loaded change's nearest older and newer change to the same file, so
// the diff page can step through one file's History. One pass, newest first.
export function fileMomentSteps(entries: readonly TimelineEntry[]): Map<string, MomentSteps> {
  const steps = new Map<string, MomentSteps>();
  const newest = new Map<string, MomentStep>();
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const step = { momentId: entry.moment.id, path: entry.moment.path };
    const newer = newest.get(step.path) ?? null;
    if (newer) steps.get(newer.momentId)!.older = step;
    steps.set(step.momentId, { older: null, newer });
    newest.set(step.path, step);
  }
  return steps;
}

function automationName(automation: NonNullable<CollectionEntry["change"]["automation"]>): string {
  return automation.name ?? automation.automationId.slice(automation.automationId.lastIndexOf("#") + 1);
}

// Main is where the workspace starts, not a version someone created.
export function versionMarkerTitle(version: VersionEntry["version"]): string {
  return version.kind === "main" ? "Workspace created" : `Created version ${version.name}`;
}

// A Collection change in the person's words. A rules change says so; a
// record change takes its operation's label when the Collection's
// definition names it, else the Collection it changed.
export function collectionChangeTitle(entry: CollectionEntry, label: string | undefined): string {
  if (entry.change.schema) return "Changed fields and rules";
  return label ?? `Changed ${entry.name}`;
}

// The agent that approved a Collection's rules, if one did.
function approvalAgentName(change: CollectionEntry["change"]): string | undefined {
  const agent = change.approvalAgent;
  return agent ? chatAuthorLabel({ authorKind: "agent", authorDisplayName: agent.label ?? "Agent" }) : undefined;
}

function timelineSearchText(item: TimelineItem, labelOf: (entry: CollectionEntry) => string | undefined): string {
  if (item.kind === "version") return versionMarkerTitle(item.version).toLowerCase();
  if (item.kind === "collection") {
    const { name, change } = item.entry;
    return [collectionChangeTitle(item.entry, labelOf(item.entry)), name, change.operation,
      approvalAgentName(change) ?? "", change.automation ? automationName(change.automation) : ""].join("\n").toLowerCase();
  }
  return [
    item.group.summary,
    ...item.group.moments.flatMap((moment) => [
      moment.path,
      engineMomentSummary(moment),
      engineMomentSourceLabel(moment),
      ...(moment.authorLabels ?? []),
    ]),
  ]
    .join("\n")
    .toLowerCase();
}

// Which day heading an item sits under. A Collection change main could not
// date sits where main placed it, under its neighbours' day; its row says
// the date is unknown. Only an item with no placement time either gets the
// "Date unknown" heading.
function itemPlacement(item: TimelineItem): number | null {
  if (item.kind === "files") return item.group.recordedAtMs;
  if (item.kind === "version") return item.version.createdAtMs;
  return item.entry.sortAtMs;
}

function dayKey(recordedAtMs: number): string {
  const recordedAt = new Date(recordedAtMs);
  const month = String(recordedAt.getMonth() + 1).padStart(2, "0");
  const day = String(recordedAt.getDate()).padStart(2, "0");
  return `${recordedAt.getFullYear()}-${month}-${day}`;
}

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatDay(recordedAtMs: number | null): { label: string; dateTime: string | null } {
  if (recordedAtMs === null) return { label: "Date unknown", dateTime: null };
  const recordedAt = new Date(recordedAtMs);
  return {
    label: dayFormat.format(recordedAt),
    dateTime: dayKey(recordedAtMs),
  };
}

// "Budget", "Budget and Guests", "Budget, Guests, Tasks and 2 more", or
// "2 Collections" when this computer knows none of their names.
export function collectionListPhrase(names: readonly string[], total: number): string {
  const shown = names.slice(0, 3);
  const rest = total - shown.length;
  if (shown.length === 0) return `${total} Collection${total === 1 ? "" : "s"}`;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

// The sentences that say what a partial timeline is missing.
export function missingSourcesWords(
  unavailable: readonly { datasetId: string }[],
  omitted: number,
  nameOf: (datasetId: string) => string | undefined,
): { unavailable: string | null; omitted: string | null } {
  const names = unavailable.flatMap((source) => nameOf(source.datasetId) ?? []);
  return {
    unavailable: unavailable.length
      ? `dohc could not load changes from ${collectionListPhrase(names, unavailable.length)}.`
      : null,
    omitted: omitted > 0
      ? `History includes up to ${HISTORY_MAX_SOURCES} Collections. ${omitted} more ${omitted === 1 ? "is" : "are"} left out. To see a Collection's changes, open it and choose History.`
      : null,
  };
}

// One timeline row: 28px, inset, with no rule between rows. Hover and the
// open change take the list ladder's fills. A mark takes an avatar's 18px.
export const MARK_BOX = "grid size-[18px] shrink-0 place-items-center";
const ROW = "h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-75 dohc-focus-row";
const rowTone = (selected: boolean) => (selected ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink");
const COUNT = "shrink-0 rounded border border-line px-1 text-[10px] tabular-nums leading-[14px] text-muted";

// Who made a change, as chats draw them: an agent's square, a person's face,
// an automation's mark, a share link's ring. A change with no one author,
// or several, draws the caller's `fallback`.
export function MomentAuthor(props: { moment: EngineMomentRecord; fallback: ReactNode }) {
  const { moment } = props;
  const presentation = moment.authorPresentations?.[0] ?? neutralPresentation;
  if (moment.agentAuthorName !== undefined) {
    return <ChatAvatar presentation={presentation} name={moment.agentAuthorName} kind="agent" size="strip" />;
  }
  if (moment.automationAuthor) return <ChatAvatar presentation={presentation} name={moment.automationAuthor.name} kind="automation" size="strip" />;
  const person = moment.namedAuthor?.label ?? moment.personAuthorName
    ?? (moment.authors?.[0]?.kind === "human" ? moment.liveAuthorName : undefined);
  if (person !== undefined) return <ChatAvatar presentation={presentation} name={person} kind="human" size="strip" />;
  if (moment.publicAuthor || moment.linkAuthor || moment.liveAuthorName !== undefined) return <LinkMark />;
  return <>{props.fallback}</>;
}

// Where a change with no one author came from, as a mark the size of an
// avatar. Its title names the origin; an unknown origin is a dot.
const ORIGIN_MARKS: Partial<Record<EngineMomentRecord["origin"], LucideIcon>> = {
  "local-file": HardDrive,
  ydoc: PenLine,
  sync: Cloud,
  restore: RotateCcw,
  "capture-recovery": Keyboard,
  "capture-recovery-cleared": Keyboard,
};

function OriginMark(props: { moment: EngineMomentRecord }) {
  const Icon = ORIGIN_MARKS[props.moment.origin];
  return (
    <span aria-hidden title={engineMomentSourceLabel(props.moment)} className={`${MARK_BOX} text-subtle`}>
      {Icon ? <Icon size={14} strokeWidth={1.9} /> : <span className="size-1 rounded-full bg-subtle" />}
    </span>
  );
}

// A row's title: the engine's own summary, else the file's name. The
// operation stays in the title only when it is not an edit.
export function momentRowTitle(moment: EngineMomentRecord): string {
  return moment.summary || moment.operation !== "write" ? engineMomentSummary(moment) : basenameOf(moment.path);
}

// Where the file is, after a title, so the row names it once: its folder
// after its name, its path after a summary that does not name it.
function momentRowPlace(moment: EngineMomentRecord, title: string): string {
  if (title.includes(moment.path)) return "";
  return title.includes(basenameOf(moment.path)) ? dirnameOf(moment.path) : moment.path;
}

// One author in words: an agent and an automation say what they are, so
// they never read as a person.
function authorWords(kind: "agent" | "automation" | undefined, label: string): string {
  if (kind === "agent") return label === "Agent" ? label : `Agent ${label}`;
  return kind === "automation" ? `Automation ${label}` : label;
}

function agentOrAutomation(kind: string | undefined): "agent" | "automation" | undefined {
  return kind === "agent" || kind === "automation" ? kind : undefined;
}

// What a screen reader hears after a change's name: what it did, who made
// it, and when. Several authors are each named by their own kind, in the
// order the change recorded them.
export function momentDescription(moment: EngineMomentRecord): string {
  const who = moment.authorLabels
    ? moment.authorLabels.map((label, index) => authorWords(agentOrAutomation(moment.authors?.[index]?.kind), label)).join(", ")
    : authorWords(
      moment.agentAuthorName !== undefined ? "agent" : moment.automationAuthor ? "automation" : undefined,
      engineMomentSourceLabel(moment),
    );
  return `${engineMomentSummary(moment)}, ${who}, ${formatChatTime(moment.recordedAtMs).label}`;
}

// Who made a top-level change, after its title. An agent's or an
// automation's name shows; anyone else shows the file's folder, and their
// avatar's title and the hidden source name them. Each gives way before the
// title does. An agent's name keeps at least its ellipsis (9.5px of 11px
// Inter), as the save state does, so a squeezed name never shows a sliver.
function MomentDetail(props: { moment: EngineMomentRecord }) {
  const { moment } = props;
  const label = engineMomentSourceLabel(moment);
  if (moment.agentAuthorName !== undefined) {
    return (
      <span data-testid="engine-moment-source" className="min-w-[13px] shrink-[999] truncate text-[11px]">
        <AgentName kind="agent" presentation={moment.authorPresentations?.[0] ?? neutralPresentation}>{label}</AgentName>
      </span>
    );
  }
  if (moment.automationAuthor) {
    return (
      <span data-testid="engine-moment-source" className="min-w-0 flex-1 basis-0 truncate text-[11px] text-muted">
        <span className="sr-only">Automation </span>
        {label}
      </span>
    );
  }
  return (
    <>
      <span className="min-w-0 flex-1 basis-0 truncate text-[11px] text-subtle">
        {momentRowPlace(moment, momentRowTitle(moment))}
      </span>
      <span data-testid="engine-moment-source" className="sr-only">{label}</span>
    </>
  );
}

// Words a control's description reads, kept out of the page: a referenced
// hidden element still describes, and nothing reads it twice.
function HiddenWords(props: { id: string; children: string }) {
  return <span id={props.id} hidden>{props.children}</span>;
}

// What a collapsed run or pass says when the open change is inside it.
const HOLDS_OPEN = "Includes the open change";

// One change in the timeline. The states page renders it too. A run's head
// carries `fold`: its count opens the run's earlier edits, and `holdsOpen`
// marks a collapsed run whose open change is one of them.
export function MomentRow(props: {
  moment: EngineMomentRecord;
  // A file in a multi-file pass, or an earlier edit in an agent's run.
  nested?: "pass" | "run";
  // The change open in the focused editor group.
  selected?: boolean;
  fold?: { count: number; more?: boolean; expanded: boolean; holdsOpen?: boolean; onToggle: () => void };
  onOpenMoment: (momentId: string, filePath: string) => void;
}) {
  const { moment, nested, fold } = props;
  const selected = props.selected === true;
  const recordedAt = formatChatTime(moment.recordedAtMs);
  // The row's name says what it opens; the change itself is its description.
  const descriptionId = useId();
  const holdsOpenId = useId();
  const open = (
    <button
      type="button"
      aria-describedby={descriptionId}
      aria-current={selected ? "true" : undefined}
      data-testid="engine-moment-open"
      data-moment-id={moment.id}
      data-moment-path={moment.path}
      title={`Open diff for ${moment.path}`}
      aria-label={`Open diff for ${moment.path}`}
      onClick={() => props.onOpenMoment(moment.id, moment.path)}
      // A run's head lays out on its row's grid, so the count sits between
      // the name and the time, as a button beside this one.
      className={`${ROW} ${fold ? "col-span-full row-start-1 grid grid-cols-subgrid" : `flex ${rowTone(selected)}`} ${nested ? "pl-8" : ""}`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {nested ? null : <MomentAuthor moment={moment} fallback={<OriginMark moment={moment} />} />}
        {nested === "pass" ? (
          <span className="flex min-w-0">
            <Ref path={moment.path} folder />
          </span>
        ) : (
          // A run is one file's edits, so its head names the file; each
          // edit's own summary is under it.
          <span className={`min-w-0 truncate ${nested ? "" : "text-ink"}`}>{fold ? basenameOf(moment.path) : momentRowTitle(moment)}</span>
        )}
        {moment.protected ? (
          // Secret-backed file moment: the lock is the affordance —
          // the row is metadata-only and its page shows no contents.
          <Lock size={12} aria-hidden data-testid="engine-moment-lock" className="shrink-0 text-subtle" />
        ) : moment.contentKind === "binary" ? (
          <FileArchive size={12} aria-hidden data-testid="engine-moment-binary" className="shrink-0 text-subtle" />
        ) : null}
        {nested === "pass" ? (
          <span className="shrink-0 text-[11px] text-subtle">{engineOperationLabel(moment)}</span>
        ) : nested ? null : (
          <MomentDetail moment={moment} />
        )}
      </span>
      {/* A pass's files share their group's time. */}
      {nested === "pass" ? null : (
        <time
          data-testid="engine-moment-recorded-at"
          dateTime={recordedAt.iso}
          title={recordedAt.iso}
          className={`shrink-0 text-[11px] tabular-nums text-subtle ${fold ? "col-start-3" : ""}`}
        >
          {formatClock(moment.recordedAtMs)}
        </time>
      )}
    </button>
  );
  const description = <HiddenWords id={descriptionId}>{momentDescription(moment)}</HiddenWords>;
  if (!fold) return <>{open}{description}</>;
  // A collapsed run holding the open change takes the selected ink; the
  // change keeps aria-current for itself, and the count says where it is.
  const holdsOpen = fold.holdsOpen === true;
  const countWords = `${fold.count}${fold.more ? " or more" : ""} changes`;
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-1.5 rounded-md transition-colors duration-75 ${rowTone(selected || holdsOpen)}`}>
      {open}
      <button
        type="button"
        data-testid="engine-moment-run-toggle"
        aria-expanded={fold.expanded}
        aria-label={countWords}
        aria-describedby={holdsOpen ? holdsOpenId : undefined}
        title={countWords}
        onClick={fold.onToggle}
        className="relative col-start-2 row-start-1 grid h-6 min-w-6 place-items-center rounded-md px-0.5 hover:bg-hover focus-visible:-outline-offset-2"
      >
        <span className={COUNT}>{fold.count}{fold.more ? "+" : null}</span>
      </button>
      {description}
      {holdsOpen ? <HiddenWords id={holdsOpenId}>{HOLDS_OPEN}</HiddenWords> : null}
    </div>
  );
}

// An agent's run of edits to one file: its newest edit, with the count that
// lists the earlier ones under it.
function RunRow(props: {
  group: EngineHistoryGroup;
  more: boolean;
  expanded: boolean;
  onToggle: () => void;
  openMomentId: string | null;
  onOpenMoment: (momentId: string, filePath: string) => void;
}) {
  const [newest, ...earlier] = props.group.moments;
  const holdsOpen = !props.expanded && earlier.some((moment) => moment.id === props.openMomentId);
  return (
    <div data-testid="engine-moment-run">
      <MomentRow
        moment={newest!}
        selected={newest!.id === props.openMomentId}
        fold={{ count: props.group.moments.length, more: props.more, expanded: props.expanded, holdsOpen, onToggle: props.onToggle }}
        onOpenMoment={props.onOpenMoment}
      />
      {props.expanded ? (
        <div data-testid="engine-moment-run-earlier">
          {earlier.map((moment) => (
            <MomentRow
              key={moment.id}
              moment={moment}
              nested="run"
              selected={moment.id === props.openMomentId}
              onOpenMoment={props.onOpenMoment}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GroupRow(props: {
  group: EngineHistoryGroup;
  more: boolean;
  expanded: boolean;
  onToggle: () => void;
  openMomentId: string | null;
  onOpenMoment: (momentId: string, filePath: string) => void;
}) {
  const { group } = props;
  const { expanded } = props;
  const recordedAt = formatChatTime(group.recordedAtMs);
  // Uniform agent authorship surfaces on the group row itself; mixed or
  // neutral groups show no author (never a guess).
  const agentAuthorName = groupAgentAuthorName(group.moments);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  // A collapsed pass holding the open change says so, as a run does.
  const holdsOpen = !expanded && group.moments.some((moment) => moment.id === props.openMomentId);
  const holdsOpenId = useId();
  return (
    <div data-testid="engine-moment-group">
      <button
        type="button"
        data-testid="engine-moment-group-toggle"
        aria-expanded={expanded}
        aria-describedby={holdsOpen ? holdsOpenId : undefined}
        onClick={props.onToggle}
        className={`${ROW} flex ${rowTone(holdsOpen)}`}
      >
        <span className={`${MARK_BOX} text-subtle`}>
          <Chevron size={14} aria-hidden />
        </span>
        <span className="min-w-0 truncate text-ink">{group.summary}</span>
        {agentAuthorName !== undefined ? (
          <span data-testid="engine-moment-group-source" className="min-w-0 shrink-[999] truncate text-[11px] text-agent">
            {chatAuthorLabel({ authorKind: "agent", authorDisplayName: agentAuthorName })}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        <span className={COUNT}>
          {group.moments.length}
          {props.more ? <span aria-hidden>+</span> : null}
          <span className="sr-only">{props.more ? " or more files" : " files"}</span>
        </span>
        <time dateTime={recordedAt.iso} title={recordedAt.iso} className="shrink-0 text-[11px] tabular-nums text-subtle">
          {formatClock(group.recordedAtMs)}
        </time>
      </button>
      {holdsOpen ? <HiddenWords id={holdsOpenId}>{HOLDS_OPEN}</HiddenWords> : null}
      {expanded ? (
        <div data-testid="engine-moment-group-files">
          {group.moments.map((moment) => (
            <MomentRow
              key={moment.id}
              moment={moment}
              nested="pass"
              selected={moment.id === props.openMomentId}
              onOpenMoment={props.onOpenMoment}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// A version starting, as a marker between changes. It opens nothing, so it
// reads lighter than the changes around it.
function VersionMarkerRow(props: { version: VersionEntry["version"] }) {
  const createdAt = formatChatTime(props.version.createdAtMs);
  return (
    <div className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[13px]">
      <span className={`${MARK_BOX} text-subtle`}>
        <Layers size={14} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-muted">{versionMarkerTitle(props.version)}</span>
      <time dateTime={createdAt.iso} title={createdAt.iso} className="shrink-0 text-[11px] tabular-nums text-subtle">
        {formatClock(props.version.createdAtMs)}
      </time>
    </div>
  );
}

// One saved Collection change. Like a file's row opens its diff, it opens its
// Collection's History, where the change and its Undo are, when this
// computer can open that Collection.
function CollectionChangeRow(props: { entry: CollectionEntry; label?: string; openHistory?: () => void }) {
  const { name, change } = props.entry;
  const recordedAt = change.recordedAtMs === null ? null : formatChatTime(change.recordedAtMs);
  const agent = approvalAgentName(change);
  // Only a record change with no label names its Collection in its title,
  // and only it needs its operation's own name to say which change it was.
  const unlabelled = !change.schema && props.label === undefined;
  // The row's name says what it opens, so the change is its description.
  const metaId = useId();
  const body = (
    <span className="flex min-w-0 items-start gap-1.5">
      <span className={`${MARK_BOX} text-subtle`}>
        <Database size={14} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">
          {collectionChangeTitle(props.entry, props.label)}
        </span>
        <span id={metaId} className="mt-0.5 block truncate text-[11px] text-subtle">
          {agent !== undefined ? (
            <>
              <span data-testid="history-collection-agent" className="text-agent">{agent}</span>
              {" · "}
            </>
          ) : null}
          {change.automation ? (
            <>
              <span className="inline-flex items-center gap-1 text-muted">
                <Zap size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
                <span className="sr-only">Automation </span>
                {automationName(change.automation)}
              </span>
              {" · "}
            </>
          ) : null}
          {recordedAt ? (
            <time dateTime={recordedAt.iso} title={recordedAt.iso} className="tabular-nums">
              {recordedAt.label}
            </time>
          ) : (
            <span data-testid="history-collection-date-unknown">Date unknown</span>
          )}
          {" · "}
          {unlabelled ? <span className="font-mono">{change.operation}</span> : <span>{name}</span>}
        </span>
      </span>
    </span>
  );
  return props.openHistory ? (
    <button
      type="button"
      data-testid="history-collection-open"
      aria-describedby={metaId}
      aria-label={`Open Collection history for ${name}`}
      title={`Open Collection history for ${name}`}
      onClick={props.openHistory}
      className="block w-full rounded-md px-2 py-1.5 text-left transition-colors duration-75 hover:bg-hover dohc-focus-row"
    >
      {body}
    </button>
  ) : (
    <div className="px-2 py-1.5">{body}</div>
  );
}

// What a partial timeline is missing, above its rows. Try again starts a new
// source chain; a source left out by the limit stays out, so only the
// Collections that did not load offer it.
function HistorySourcesNotice(props: {
  words: { unavailable: string | null; omitted: string | null };
  onRetry: () => void;
}) {
  const { words } = props;
  return (
    <div
      data-testid="history-sources-notice"
      className="flex shrink-0 items-start gap-2 border-b border-line bg-panel px-3 py-2 text-[12px] text-muted"
    >
      {words.unavailable ? (
        <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-warning" />
      ) : (
        <Info size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {words.unavailable ? <span data-testid="history-sources-unavailable">{words.unavailable}</span> : null}
        {words.omitted ? <span data-testid="history-sources-omitted">{words.omitted}</span> : null}
      </span>
      {words.unavailable ? (
        <button
          type="button"
          data-testid="history-sources-retry"
          onClick={props.onRetry}
          className="h-6 shrink-0 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

// The timeline body (side panel History view and the history tab render
// this over the same root-owned page state).
export function EngineHistoryView(props: {
  entries: TimelineEntry[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenMoment: (momentId: string, filePath: string) => void;
  // The change open in the focused editor group, marked as selected.
  openMomentId?: string | null;
  unavailableSources?: readonly { datasetId: string }[];
  omittedSources?: number;
  collections?: HistoryCollections;
  // Reads the newest page again, which starts a new source chain.
  onRetry?: () => void;
  // History stopped recording, so this page may be missing changes.
  paused?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const { collections, entries } = props;
  const items = useMemo(() => groupTimeline(props.entries), [props.entries]);
  // While earlier changes remain, the oldest loaded row may continue on the
  // next page, so its count is only a lower bound.
  const moreKey = props.hasMore ? items.at(-1)?.key ?? null : null;
  const labelOf = useCallback(
    (entry: CollectionEntry) => collections?.get(entry.datasetId)?.operationLabels?.get(entry.change.operation),
    [collections],
  );
  const filteredItems = useMemo(
    () =>
      normalizedQuery
        ? items.filter((item) => timelineSearchText(item, labelOf).includes(normalizedQuery))
        : items,
    [items, normalizedQuery, labelOf],
  );
  const rows = useMemo(() => {
    const result: Array<
      | { key: string; day: ReturnType<typeof formatDay>; item?: never }
      | { key: string; item: TimelineItem; day?: never }
    > = [];
    let previousDay: string | null | undefined;
    for (const item of filteredItems) {
      const day = formatDay(itemPlacement(item));
      if (previousDay !== day.dateTime) result.push({ key: `day:${item.key}`, day });
      result.push({ key: item.key, item });
      previousDay = day.dateTime;
    }
    return result;
  }, [filteredItems]);
  const words = useMemo(
    () => missingSourcesWords(props.unavailableSources ?? [], props.omittedSources ?? 0, (datasetId) =>
      collections?.get(datasetId)?.name ??
        entries.find((entry): entry is CollectionEntry => entry.kind === "collection" && entry.datasetId === datasetId)?.name),
    [props.unavailableSources, props.omittedSources, collections, entries],
  );
  const retry = props.onRetry ?? (() => undefined);
  const stickyHeaderIndices = useMemo(
    () => rows.flatMap((row, index) => (row.day ? [index] : [])),
    [rows],
  );
  const focusedIndex = rows.findIndex((row) => row.key === focusedKey);
  // Retain the adjacent groups too, so Tab can leave a row after it scrolls away.
  const retainedKeys = focusedIndex < 0
    ? []
    : rows.slice(Math.max(0, focusedIndex - 2), focusedIndex + 3).map((row) => row.key);
  const headerItemCount = 0;
  const listItemCount = headerItemCount + rows.length + (props.hasMore ? 1 : 0);
  const openMomentId = props.openMomentId ?? null;
  const rowPresentation = useMemo(
    () => ({ expandedGroups, headerItemCount, listItemCount, onOpenMoment: props.onOpenMoment, collections, openMomentId, moreKey }),
    [expandedGroups, headerItemCount, listItemCount, props.onOpenMoment, collections, openMomentId, moreKey],
  );
  const toggleGroup = (key: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const partial = words.unavailable !== null || words.omitted !== null;

  // A known page with no rows. The caller renders this view only when it
  // has a page: "No changes yet" states something about the workspace,
  // and a read still in flight or a read that failed may not state it.
  // Neither may a page that is missing Collections, or one read while
  // History is paused: their changes are unknown, not absent.
  if (props.entries.length === 0 && !props.hasMore) {
    if (partial) {
      return (
        <div
          data-testid="history-collections-unavailable"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted"
        >
          {props.paused ? <HistoryPaused testId="history-paused" /> : null}
          {words.unavailable ? <span>{words.unavailable}</span> : null}
          {words.omitted ? <span>{words.omitted}</span> : null}
          {words.unavailable ? (
            <button
              type="button"
              data-testid="history-sources-retry"
              onClick={retry}
              className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-hover hover:text-ink"
            >
              Try again
            </button>
          ) : null}
        </div>
      );
    }
    if (props.paused) {
      return (
        <div className="flex flex-1 items-center justify-center px-4">
          <HistoryPaused testId="history-paused" />
        </div>
      );
    }
    return (
      <EmptyState
        icon={History}
        title="No changes yet"
        hint="Edits by you or your agent appear here as a timeline you can review."
      />
    );
  }

  return (
    <>
      <div className="shrink-0 border-b border-line bg-panel-2 px-2 py-2">
        <label className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-line bg-bg px-2 text-[11px] text-muted focus-within:border-ink">
          <Search size={12} aria-hidden className="shrink-0 text-subtle" />
          <input
            type="search"
            data-testid="engine-history-search"
            aria-label="Search history"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search history"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-subtle"
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="Clear history search"
              title="Clear history search"
              onClick={() => setQuery("")}
              className="grid size-5 shrink-0 place-items-center rounded-md text-subtle hover:bg-hover hover:text-ink"
            >
              <X size={12} aria-hidden />
            </button>
          ) : null}
        </label>
      </div>
      {partial ? <HistorySourcesNotice words={words} onRetry={retry} /> : null}
      {props.paused ? (
        <HistoryPaused testId="history-paused" className="shrink-0 border-b border-line bg-panel px-3 py-2" />
      ) : null}
      <LegendList
        role="list"
        data-testid="engine-history-list"
        // `isolate` keeps the sticky day headings' z-index inside History,
        // under any overlay.
        className="isolate m-0 min-h-0 flex-1 list-none p-0"
        data={rows}
        keyExtractor={(row) => row.key}
        estimatedItemSize={28}
        getItemType={(row) => (row.day ? "day" : row.item.kind)}
        stickyHeaderIndices={stickyHeaderIndices}
        recycleItems={false}
        alwaysRender={{ keys: retainedKeys }}
        onFocusCapture={(event) =>
          setFocusedKey(
            (event.target as HTMLElement).closest<HTMLElement>("[data-history-key]")
              ?.dataset.historyKey ?? null,
          )
        }
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null);
        }}
        extraData={rowPresentation}
        renderItem={({ item, index }) => item.day ? (
          <li
            role="listitem"
            aria-posinset={headerItemCount + index + 1}
            aria-setsize={listItemCount}
            className="border-b border-line bg-panel-2 px-3 py-1"
          >
            {item.day.dateTime === null ? (
              <span data-testid="engine-history-day-heading" className="dohc-section-label">
                {item.day.label}
              </span>
            ) : (
              <time
                data-testid="engine-history-day-heading"
                dateTime={item.day.dateTime}
                className="dohc-section-label"
              >
                {item.day.label}
              </time>
            )}
          </li>
        ) : (
          <li
            role="listitem"
            aria-posinset={headerItemCount + index + 1}
            aria-setsize={listItemCount}
            data-testid={item.item.kind === "files" ? "engine-moment"
              : item.item.kind === "version" ? "history-version" : "history-collection-change"}
            data-history-key={item.key}
            className="px-1"
          >
            {item.item.kind === "version" ? (
              <VersionMarkerRow version={item.item.version} />
            ) : item.item.kind === "collection" ? (
              <CollectionChangeRow
                entry={item.item.entry}
                label={labelOf(item.item.entry)}
                openHistory={collections?.get(item.item.entry.datasetId)?.openHistory}
              />
            ) : item.item.group.moments.length > 1 ? (
              item.item.group.run ? (
                <RunRow
                  group={item.item.group}
                  more={item.key === moreKey}
                  expanded={expandedGroups.has(item.key)}
                  onToggle={() => toggleGroup(item.key)}
                  openMomentId={openMomentId}
                  onOpenMoment={props.onOpenMoment}
                />
              ) : (
                <GroupRow
                  group={item.item.group}
                  more={item.key === moreKey}
                  expanded={expandedGroups.has(item.key)}
                  onToggle={() => toggleGroup(item.key)}
                  openMomentId={openMomentId}
                  onOpenMoment={props.onOpenMoment}
                />
              )
            ) : (
              <MomentRow
                moment={item.item.group.moments[0]}
                selected={item.item.group.moments[0].id === openMomentId}
                onOpenMoment={props.onOpenMoment}
              />
            )}
          </li>
        )}
        ListFooterComponent={props.hasMore ? (
          <li
            role="listitem"
            aria-posinset={listItemCount}
            aria-setsize={listItemCount}
            className="px-1 pb-1"
          >
            <button
              type="button"
              data-testid="engine-history-load-more"
              disabled={props.loadingMore}
              onClick={props.onLoadMore}
              className="dohc-focus-row block h-7 w-full cursor-pointer rounded-md px-2 text-center text-[11px] text-muted hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-60"
            >
              {props.loadingMore ? "Loading…" : "Show earlier changes"}
            </button>
          </li>
        ) : null}
      />
    </>
  );
}
