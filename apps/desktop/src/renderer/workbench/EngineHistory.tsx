import { formatChatDay, formatChatTime, formatClock, formatDayClock } from "../time";
import { basenameOf, dirnameOf } from "../path";
import { ChevronDown, ChevronRight, Cloud, Database, FileArchive, HardDrive, History, Info, Keyboard, Layers, Lock, PenLine, RotateCcw, Search, TriangleAlert, X, Zap, type LucideIcon } from "lucide-react";
import { EmptyState, GhostButton } from "../ui/controls";
import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { LegendList } from "@legendapp/list/react";
import { isCaptureRecoveryOrigin } from "@dohc/workspace-contracts/engine";
import { HISTORY_MAX_SOURCES, type EngineMomentRecord, type SyncStatusResult, type TimelineEntry } from "../../ipc/bridgeContract";
import { chatAuthorLabel } from "./chatMessages";
import { ChatAvatar, LinkMark } from "./ChatAvatar";
import { neutralPresentation } from "./actorPresentation";

// The History timeline: file moments, version markers and Collection
// changes, newest first, in the order main merged them. File moments keep
// their summaries ("Saved latest edits", "Merged version X into Main",
// "Changed while dohc was closed", ...) and a multi-file pass (reconcile, switch,
// merge, restore) groups into one expandable item via its correlationId.
// One author's consecutive edits to one file fold into one row, a run.
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

// The one agent or person that made a moment, by their stable id. Two agents
// can share a name, so a run never compares names.
function soleAuthorKey(moment: EngineMomentRecord): string | undefined {
  const [author, ...others] = moment.authors ?? [];
  if (author === undefined || others.length > 0) return undefined;
  if (author.kind === "agent") return `agent:${author.agentId}`;
  return author.kind === "human" ? `human:${author.humanId}` : undefined;
}

// An edit a run can hold. A restore and kept typing each keep a row of
// their own, so they are never folded out of sight.
function runEdit(moment: EngineMomentRecord): boolean {
  return moment.operation === "write" && moment.origin !== "restore" && !isCaptureRecoveryOrigin(moment.origin);
}

// Whether `older` continues the run `newer` is in: the same agent or person
// editing the same file, on the same day.
function continuesRun(newer: EngineMomentRecord, older: EngineMomentRecord): boolean {
  const author = soleAuthorKey(newer);
  return author !== undefined && author === soleAuthorKey(older) &&
    newer.path === older.path && runEdit(newer) && runEdit(older) &&
    dayKey(newer.recordedAtMs) === dayKey(older.recordedAtMs);
}

// Keeps the order main merged and groups consecutive file moments that share
// a correlationId (one pass records its per-file moments contiguously on the
// capture chain). A version or Collection row between them ends the group.
// One agent's or person's consecutive edits to one file fold into a run,
// keyed by its oldest edit so a new edit on top keeps the row. Each edit may
// carry its own one-moment operation; a moment of a multi-file pass never
// joins a run. Other moments stay single.
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
      momentAuthorLabel(moment),
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

// Today, Yesterday, then the date, as chat's day dividers say it.
function formatDay(recordedAtMs: number | null): { label: string; dateTime: string | null } {
  if (recordedAtMs === null) return { label: "Date unknown", dateTime: null };
  return {
    label: formatChatDay(recordedAtMs),
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

// What a partial timeline's quiet line shows; its sentences are the tooltip.
function missingSourcesShort(
  unavailable: readonly { datasetId: string }[],
  omitted: number,
  nameOf: (datasetId: string) => string | undefined,
): { unavailable: string | null; omitted: string | null } {
  const names = unavailable.flatMap((source) => nameOf(source.datasetId) ?? []);
  return {
    unavailable: unavailable.length ? `dohc could not load ${collectionListPhrase(names, unavailable.length)}` : null,
    omitted: omitted > 0 ? `${countFormat.format(omitted)} Collection${omitted === 1 ? "" : "s"} left out` : null,
  };
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

// One timeline row. A change is two lines, 48px, as Notion's page history
// reads: when, then who made it and what changed, beside their face. A file
// under a pass or an edit under a run is one line, 28px, its words starting
// where the names above it do. Rows touch; hover and the open change take
// the list ladder's fills. A mark takes an avatar's 18px slot, so every name
// starts on one edge.
export const MARK_BOX = "grid size-[18px] shrink-0 place-items-center";
const TWO_LINES = `grid h-12 w-full min-w-0 grid-cols-[18px_minmax(0,1fr)] content-center gap-x-2 rounded-md px-2 text-left transition-colors duration-75 dohc-focus-row`;
const WHEN = "col-span-2 min-w-0 truncate text-[13px] font-medium leading-5 tabular-nums text-ink";
const LINE_TWO = "flex min-w-0 items-center gap-2 text-[12px] leading-4 text-muted";
const ONE_LINE = `flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75 dohc-focus-row`;
const rowTone = (selected: boolean) => (selected ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink");
const countFormat = new Intl.NumberFormat();

// A count of what has loaded: "3,029", or "49+" read as "49 or more" while
// earlier changes remain.
function LoadedCount(props: { count: number; more?: boolean; noun: string }) {
  const count = countFormat.format(props.count);
  if (!props.more) return <span className="tabular-nums">{count} {props.noun}</span>;
  return (
    <span className="tabular-nums">
      <span aria-hidden>{count}+ {props.noun}</span>
      <span className="sr-only">{count} or more {props.noun}</span>
    </span>
  );
}

// Who made a change, as chats draw them: an agent's square, a person's face,
// an automation's mark, a share link's ring. A change with no one author,
// or several, draws the caller's `fallback`.
// A change as a face and a name credit it. A change's diff page reads it
// without its place in the list.
type CreditedMoment = Omit<EngineMomentRecord, "momentOrder">;

export function MomentAuthor(props: { moment: CreditedMoment; fallback: ReactNode }) {
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

export function OriginMark(props: { moment: CreditedMoment }) {
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

// What a change did, in one file's History, where the file goes without
// saying: its own summary, else its operation.
export function fileMomentSummary(moment: Pick<EngineMomentRecord, "summary" | "operation" | "path">): string {
  if (moment.summary) return moment.summary;
  if (moment.operation === "rename") return `Renamed to ${basenameOf(moment.path)}`;
  return moment.operation === "delete" ? "Deleted" : "Edited";
}

// Who a row names beside its face. A change by this computer's person shows
// their face, so it names them too, unless it holds kept typing, which says
// so instead. Everyone else is named as History sources name them.
function momentAuthorLabel(moment: CreditedMoment): string {
  if (isCaptureRecoveryOrigin(moment.origin)) return engineMomentSourceLabel(moment);
  return moment.personAuthorName ?? engineMomentSourceLabel(moment);
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
      momentAuthorLabel(moment),
    );
  return `${engineMomentSummary(moment)}, ${who}, ${formatChatTime(moment.recordedAtMs).label}`;
}

// Who made a change, beside their face. The face carries an agent's hue, so
// the name stays in the line's ink; an automation says what it is to a
// screen reader.
export function MomentName(props: { moment: CreditedMoment; testId?: string; className?: string }) {
  const { moment } = props;
  return (
    <span data-testid={props.testId ?? "engine-moment-source"} className={`min-w-0 truncate ${props.className ?? ""}`}>
      {moment.automationAuthor ? <span className="sr-only">Automation </span> : null}
      {momentAuthorLabel(moment)}
    </span>
  );
}

// A protected file's change shows no contents; a binary one shows bytes.
function ContentMark(props: { moment: EngineMomentRecord }) {
  if (props.moment.protected) {
    return <Lock size={12} aria-hidden data-testid="engine-moment-lock" className="shrink-0 text-subtle" />;
  }
  return props.moment.contentKind === "binary"
    ? <FileArchive size={12} aria-hidden data-testid="engine-moment-binary" className="shrink-0 text-subtle" />
    : null;
}

// Origins whose label already says what happened, such as "Local file edit".
const ACTION_ORIGINS = new Set<EngineMomentRecord["origin"]>(["local-file", "ydoc", "restore", "capture-recovery", "capture-recovery-cleared"]);

// What changed, under the name. In the workspace's History it names the
// file first, unless its summary already does; an edit with no summary
// says where the file is instead. In one file's History, a bare "Edited"
// goes unsaid after a name that already says it.
function MomentWhat(props: { moment: EngineMomentRecord; context: "workspace" | "file"; fileOnly?: boolean }) {
  const { moment } = props;
  if (props.context === "file") {
    const saysIt = !moment.summary && moment.operation === "write" && ACTION_ORIGINS.has(moment.origin)
      && momentAuthorLabel(moment) === engineOriginLabel(moment.origin);
    return saysIt ? null : <span className="min-w-0 truncate">{fileMomentSummary(moment)}</span>;
  }
  const name = basenameOf(moment.path);
  const summary = props.fileOnly || (!moment.summary && moment.operation === "write") ? null : engineMomentSummary(moment);
  return (
    <>
      {summary?.includes(name) ? null : <span className="min-w-0 max-w-[70%] shrink-0 truncate text-ink">{name}</span>}
      {summary === null
        ? <span className="min-w-0 truncate text-subtle">{dirnameOf(moment.path)}</span>
        : <span className="min-w-0 truncate">{summary}</span>}
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

// One change, in the workspace's History or in one file's. Selecting it
// opens that change. The states page and About render it too. A run's head
// carries `fold`: its count opens the run's earlier edits, and `holdsOpen`
// marks a collapsed run whose open change is one of them.
export function HistoryRow(props: {
  moment: EngineMomentRecord;
  // One file's History leaves the file's name out and dates each row.
  context: "workspace" | "file";
  // A file in a multi-file pass, or an earlier edit in a run.
  nested?: "pass" | "run";
  // The change open in the focused editor group.
  selected?: boolean;
  fold?: { count: number; more?: boolean; expanded: boolean; holdsOpen?: boolean; onToggle: () => void };
  onOpen: (momentId: string, filePath: string) => void;
}) {
  const { moment, nested, fold } = props;
  const selected = props.selected === true;
  const recordedAt = formatChatTime(moment.recordedAtMs);
  // The row's name says what it opens; the change itself is its description.
  const descriptionId = useId();
  const holdsOpenId = useId();
  const time = (className: string) => (
    <time data-testid="engine-moment-recorded-at" dateTime={recordedAt.iso} title={recordedAt.label} className={className}>
      {/* The workspace's History heads each day; one file's dates each row. */}
      {props.context === "file" ? formatDayClock(moment.recordedAtMs) : formatClock(moment.recordedAtMs)}
    </time>
  );
  const shared = {
    type: "button",
    "aria-describedby": descriptionId,
    "aria-current": selected ? "true" : undefined,
    "data-testid": "engine-moment-open",
    "data-moment-id": moment.id,
    "data-moment-path": moment.path,
    title: `Open diff for ${moment.path}`,
    "aria-label": `Open diff for ${moment.path}`,
    onClick: () => props.onOpen(moment.id, moment.path),
  } as const;
  const description = <HiddenWords id={descriptionId}>{momentDescription(moment)}</HiddenWords>;
  if (nested) {
    return (
      <>
        <button {...shared} className={`${ONE_LINE} ${rowTone(selected)}`}>
          <span aria-hidden className={MARK_BOX} />
          {nested === "pass" ? (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 max-w-[70%] shrink-0 truncate text-ink">{basenameOf(moment.path)}</span>
              <span className="min-w-0 truncate text-[12px] text-subtle">{dirnameOf(moment.path)}</span>
            </span>
          ) : (
            // An earlier edit in a run leads with its time, as its head
            // does; the head already names who made them all.
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {time("shrink-0 font-medium tabular-nums text-ink")}
              <span className="min-w-0 truncate text-[12px] text-muted">{fileMomentSummary(moment)}</span>
            </span>
          )}
          <ContentMark moment={moment} />
          {/* A pass's files share their group's time. Most passes change
              files, so only a rename or a delete says what it did. */}
          {nested === "pass" && moment.operation !== "write" ? (
            <span className="shrink-0 text-[12px] text-subtle">{engineOperationLabel(moment)}</span>
          ) : null}
        </button>
        {description}
      </>
    );
  }
  const open = (
    <button {...shared} className={`${TWO_LINES} ${fold ? "" : rowTone(selected)}`}>
      {/* A run's count sits at the end of the time's line. */}
      {time(`${WHEN} ${fold ? "pr-24" : ""}`)}
      <MomentAuthor moment={moment} fallback={<OriginMark moment={moment} />} />
      <span className={LINE_TWO}>
        <MomentName moment={moment} className="max-w-[45%] shrink-0" />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <MomentWhat moment={moment} context={props.context} fileOnly={fold !== undefined} />
          <ContentMark moment={moment} />
        </span>
      </span>
    </button>
  );
  if (!fold) return <>{open}{description}</>;
  // A collapsed run holding the open change takes the selected ink; the
  // change keeps aria-current for itself, and the count says where it is.
  const holdsOpen = fold.holdsOpen === true;
  const countWords = `${countFormat.format(fold.count)}${fold.more ? " or more" : ""} changes`;
  const Chevron = fold.expanded ? ChevronDown : ChevronRight;
  return (
    <div className={`relative rounded-md transition-colors duration-75 ${rowTone(selected || holdsOpen)}`}>
      {open}
      <button
        type="button"
        data-testid="engine-moment-run-toggle"
        aria-expanded={fold.expanded}
        aria-label={countWords}
        aria-describedby={holdsOpen ? holdsOpenId : undefined}
        title={countWords}
        onClick={fold.onToggle}
        className={`absolute right-1 top-[5px] flex h-5 items-center gap-1 rounded-md px-1 text-[12px] text-subtle hover:bg-hover hover:text-ink focus-visible:-outline-offset-2`}
      >
        <LoadedCount count={fold.count} more={fold.more} noun="changes" />
        <Chevron size={12} aria-hidden />
      </button>
      {description}
      {holdsOpen ? <HiddenWords id={holdsOpenId}>{HOLDS_OPEN}</HiddenWords> : null}
    </div>
  );
}

// One author's run of edits to one file: its newest edit, with the count that
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
      <HistoryRow
        moment={newest!}
        context="workspace"
        selected={newest!.id === props.openMomentId}
        fold={{ count: props.group.moments.length, more: props.more, expanded: props.expanded, holdsOpen, onToggle: props.onToggle }}
        onOpen={props.onOpenMoment}
      />
      {props.expanded ? (
        <div data-testid="engine-moment-run-earlier">
          {earlier.map((moment) => (
            <HistoryRow
              key={moment.id}
              moment={moment}
              context="workspace"
              nested="run"
              selected={moment.id === props.openMomentId}
              onOpen={props.onOpenMoment}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// A pass over many files, such as Changed while dohc was closed: what it
// did, then how many files, opening in place to list them.
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
        className={`${TWO_LINES} ${rowTone(holdsOpen)}`}
      >
        <time dateTime={recordedAt.iso} title={recordedAt.label} className={WHEN}>
          {formatClock(group.recordedAtMs)}
        </time>
        <span className={`${MARK_BOX} text-subtle`}>
          <Chevron size={14} aria-hidden />
        </span>
        <span className={LINE_TWO}>
          {agentAuthorName !== undefined ? (
            <span data-testid="engine-moment-group-source" className="min-w-0 max-w-[45%] shrink-0 truncate">
              {chatAuthorLabel({ authorKind: "agent", authorDisplayName: agentAuthorName })}
            </span>
          ) : null}
          <span className="min-w-0 truncate">{group.summary}</span>
          <span className="shrink-0 text-subtle">
            <LoadedCount count={group.moments.length} more={props.more} noun="files" />
          </span>
        </span>
      </button>
      {holdsOpen ? <HiddenWords id={holdsOpenId}>{HOLDS_OPEN}</HiddenWords> : null}
      {expanded ? (
        <div data-testid="engine-moment-group-files">
          {group.moments.map((moment) => (
            <HistoryRow
              key={moment.id}
              moment={moment}
              context="workspace"
              nested="pass"
              selected={moment.id === props.openMomentId}
              onOpen={props.onOpenMoment}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// A version starting, as a marker between changes. It reads as a change
// does, its time first, but it opens nothing.
function VersionMarkerRow(props: { version: VersionEntry["version"] }) {
  const createdAt = formatChatTime(props.version.createdAtMs);
  return (
    <div className={TWO_LINES}>
      <time dateTime={createdAt.iso} title={createdAt.label} className={WHEN}>
        {formatClock(props.version.createdAtMs)}
      </time>
      <span className={`${MARK_BOX} text-subtle`}>
        <Layers size={14} aria-hidden />
      </span>
      <span className={LINE_TWO}>
        <span className="min-w-0 truncate">{versionMarkerTitle(props.version)}</span>
      </span>
    </div>
  );
}

// One saved Collection change. Like a file's row opens its diff, it opens its
// Collection's History, where the change and its Undo are, when this
// computer can open that Collection. A Collection change has no face, so
// what changed follows the time, beside the Collection's mark; who made it
// and where come after.
function CollectionChangeRow(props: { entry: CollectionEntry; label?: string; openHistory?: () => void }) {
  const { name, change } = props.entry;
  const agent = approvalAgentName(change);
  // Only a record change with no label names its Collection in its title,
  // and only it needs its operation's own name to say which change it was.
  const unlabelled = !change.schema && props.label === undefined;
  // The row's name says what it opens, so the change is its description.
  const metaId = useId();
  const body = (
    <>
      {change.recordedAtMs === null ? (
        <span data-testid="history-collection-date-unknown" className="col-span-2 min-w-0 truncate text-[13px] leading-5 text-muted">Date unknown</span>
      ) : (
        <time dateTime={formatChatTime(change.recordedAtMs).iso} title={formatChatTime(change.recordedAtMs).label} className={WHEN}>
          {formatClock(change.recordedAtMs)}
        </time>
      )}
      <span className={`${MARK_BOX} text-subtle`}>
        <Database size={14} aria-hidden />
      </span>
      <span className={LINE_TWO}>
        <span data-testid="history-collection-title" className="min-w-0 max-w-[60%] shrink-0 truncate">
          {collectionChangeTitle(props.entry, props.label)}
        </span>
        <span id={metaId} className="flex min-w-0 items-center gap-2">
          {agent !== undefined ? (
            <span data-testid="history-collection-agent" className="min-w-0 shrink-0 truncate">{agent}</span>
          ) : null}
          {change.automation ? (
            <span className="inline-flex min-w-0 shrink-0 items-center gap-1">
              <Zap size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
              <span className="sr-only">Automation </span>
              <span className="truncate">{automationName(change.automation)}</span>
            </span>
          ) : null}
          <span className="min-w-0 truncate text-subtle">{unlabelled ? change.operation : name}</span>
        </span>
      </span>
    </>
  );
  return props.openHistory ? (
    <button
      type="button"
      data-testid="history-collection-open"
      aria-describedby={metaId}
      aria-label={`Open Collection history for ${name}`}
      title={`Open Collection history for ${name}`}
      onClick={props.openHistory}
      className={`${TWO_LINES} text-muted hover:bg-hover`}
    >
      {body}
    </button>
  ) : (
    <div className={TWO_LINES}>{body}</div>
  );
}

// What a partial timeline is missing, as one quiet line each above its
// rows. The full sentence is its tooltip and what a screen reader hears.
// Try again starts a new source chain; a source left out by the limit stays
// out, so only the Collections that did not load offer it.
function HistorySourcesNotice(props: {
  words: ReturnType<typeof missingSourcesWords>;
  short: ReturnType<typeof missingSourcesWords>;
  onRetry: () => void;
}) {
  const { words, short } = props;
  return (
    <div data-testid="history-sources-notice" className="flex shrink-0 flex-col px-3">
      {words.unavailable ? (
        <p title={words.unavailable} className="m-0 flex h-7 min-w-0 items-center gap-2 text-[12px] text-muted">
          <span aria-hidden className={MARK_BOX}>
            <TriangleAlert size={12} className="text-warning" />
          </span>
          <span aria-hidden className="min-w-0 flex-1 truncate">{short.unavailable}</span>
          <span data-testid="history-sources-unavailable" className="sr-only">{words.unavailable}</span>
          <GhostButton data-testid="history-sources-retry" onClick={props.onRetry} className="shrink-0">
            Try again
          </GhostButton>
        </p>
      ) : null}
      {words.omitted ? (
        <p title={words.omitted} className="m-0 flex h-7 min-w-0 items-center gap-2 text-[12px] text-muted">
          <span aria-hidden className={MARK_BOX}>
            <Info size={12} className="text-subtle" />
          </span>
          <span aria-hidden className="min-w-0 flex-1 truncate">{short.omitted}</span>
          <span data-testid="history-sources-omitted" className="sr-only">{words.omitted}</span>
        </p>
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
  const [words, shortWords] = useMemo(() => {
    const nameOf = (datasetId: string) => collections?.get(datasetId)?.name ??
      entries.find((entry): entry is CollectionEntry => entry.kind === "collection" && entry.datasetId === datasetId)?.name;
    const unavailable = props.unavailableSources ?? [];
    const omitted = props.omittedSources ?? 0;
    return [missingSourcesWords(unavailable, omitted, nameOf), missingSourcesShort(unavailable, omitted, nameOf)];
  }, [props.unavailableSources, props.omittedSources, collections, entries]);
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
    return <EmptyState icon={History} title="No changes yet" />;
  }

  return (
    <>
      {/* Search reads as one more row until it is used: its mark in the
          avatar slot, its words where the names start. */}
      <div className="relative shrink-0 px-1 pb-1">
        <span aria-hidden className={`${MARK_BOX} pointer-events-none absolute left-3 top-[5px] text-subtle`}>
          <Search size={14} />
        </span>
        <input
          type="search"
          data-testid="engine-history-search"
          aria-label="Search history"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          className="h-7 w-full min-w-0 rounded-md bg-transparent pl-[34px] pr-8 text-[13px] text-ink transition-colors duration-75 placeholder:text-subtle hover:bg-hover focus:bg-hover [&::-webkit-search-cancel-button]:hidden"
        />
        {query.length > 0 ? (
          <button
            type="button"
            aria-label="Clear history search"
            title="Clear history search"
            onClick={() => setQuery("")}
            className="absolute right-2 top-1 grid size-5 place-items-center rounded-md text-subtle hover:bg-hover hover:text-ink"
          >
            <X size={12} aria-hidden />
          </button>
        ) : null}
      </div>
      {partial ? <HistorySourcesNotice words={words} short={shortWords} onRetry={retry} /> : null}
      {props.paused ? <HistoryPaused testId="history-paused" className="h-7 shrink-0 px-3" /> : null}
      <LegendList
        role="list"
        data-testid="engine-history-list"
        // `isolate` keeps the sticky day headings' z-index inside History,
        // under any overlay.
        className="isolate m-0 min-h-0 flex-1 list-none p-0"
        data={rows}
        keyExtractor={(row) => row.key}
        estimatedItemSize={48}
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
            // The day's label sits over its first row, on the panel, so a
            // stuck label covers the rows that scroll under it.
            className="flex h-8 items-end bg-panel px-3 pb-1"
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
              <HistoryRow
                moment={item.item.group.moments[0]}
                context="workspace"
                selected={item.item.group.moments[0].id === openMomentId}
                onOpen={props.onOpenMoment}
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
              className="dohc-focus-row block h-8 w-full cursor-pointer rounded-md px-2 text-center text-[12px] text-muted hover:bg-hover hover:text-ink disabled:cursor-wait disabled:opacity-60"
            >
              {props.loadingMore ? "Loading…" : "Show earlier changes"}
            </button>
          </li>
        ) : null}
      />
    </>
  );
}
