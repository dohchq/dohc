import { automationReachCopy } from "../automationReachCopy";
import { AlertTriangle, ArrowLeft, CalendarClock, CheckCircle2, CircleDashed, Clock, FileCode2, Plus, X, Zap } from "lucide-react";
import type { FieldDefinition } from "@dohc/workspace-contracts";
import { nextDue } from "@dohc/workspace-contracts/automation-schedule";
import { AUTOMATION_SERVER_OFF } from "@dohc/workspace-contracts/relay";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ListCollectionAutomationsResult,
  ScheduleHostResult,
  WriteCollectionAutomationsResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { relativeTime } from "../relativeTime";
import { computerInSentence, shownScheduleHost } from "../scheduleHost";
import { SwitchControl } from "../settings/SettingRow";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { IconButton, SecondaryButton } from "../ui/controls";
import { MoreMenu } from "../ui/MoreMenu";
import { useRequestSequence } from "../useRequestSequence";
import { AutomationBuilder } from "./AutomationBuilder";
import { AutomationRuns } from "./AutomationRuns";
import { newAutomation, type AutomationTable } from "./automationDraft";
import { RUN_TIME, Sentence, StatusLine } from "./AutomationParts";
import {
  automationSentence,
  collectionName,
  sentenceText,
  type Automation,
  type AutomationsFile,
  type AutomationSummary,
  type ValidAutomationSummary,
} from "./automationSentence";
import { useAutomationRetry } from "./useAutomationRetry";
import { AUTOMATION_HOLDS_UNREADABLE } from "../workbench/NoticeCenter";

// The ⚡ panel: a Collection's automations in plain words, each with an on
// and off switch and its runs on this computer. Main reads and writes
// automations.yaml; this panel sends it the whole list it wants saved over
// the content it read, so a change made elsewhere in between is a conflict,
// not a lost write.

// Mirrors of the file contract, which the renderer never loads.
const MAX_AUTOMATIONS = 50;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 120;
export const AUTOMATIONS_FILE = "automations.yaml";

type ErrorReport = (fallback: string, error: unknown, retry?: (() => void) | null) => void;

/** What the builder edits, and what it started from. */
interface Editing {
  /** Keeps one builder mounted while its baseline changes after a conflict. */
  session: number;
  /** The draft the builder opens with. */
  start: Automation;
  /** What counts as unchanged. */
  baseline: Automation;
  /** The file's copy when editing began, or null for a new automation. */
  original: Automation | null;
  cannotRun: string | null;
  reach: ValidAutomationSummary["reach"] | null;
}

let sessions = 0;
const nextSession = () => (sessions += 1);
// Drafts with changes a panel held when it went away without asking, by
// workspace and Collection. The panel opens the draft again.
const keptDrafts = new Map<string, Editing>();

/** Tests start without drafts an earlier test's panel kept. */
export function resetKeptAutomationDraftsForTests(): void {
  keptDrafts.clear();
}

/** What the panel can save over: the file's hash and its automations, or null when editing is off. */
function editableOf(file: AutomationsFile | null): { contentHash: string | null; automations: Automation[] } | null {
  if (file?.status === "missing") return { contentHash: null, automations: [] };
  if (file?.status !== "read" || file.automations.some((entry) => !entry.valid)) return null;
  return {
    contentHash: file.contentHash,
    automations: file.automations.flatMap((entry) => (entry.valid ? [entry.automation] : [])),
  };
}

/**
 * Whether an automation belongs in the panel of one dataset table: its
 * trigger names that table, or names none. A dataset keeps one
 * automations.yaml for all its tables, and each table is a Collection. An
 * entry dohc cannot read, or one whose trigger names a table the dataset
 * lacks, as after a rename, shows in every table with why it does not run.
 * A document Collection's panel, with no table, shows every automation.
 */
export function shownInTable(entry: AutomationSummary, table: AutomationTable | undefined): boolean {
  if (table === undefined || !entry.valid) return true;
  const trigger = entry.automation.when;
  return !("table" in trigger) || trigger.table === null || trigger.table === table.name || !table.tables.has(trigger.table);
}

/** How many automations a Collection's ⚡ button counts: those its panel lists. */
export function automationCount(file: ListCollectionAutomationsResult | null, table?: AutomationTable): number {
  return file?.status === "read" ? file.automations.filter((entry) => shownInTable(entry, table)).length : 0;
}

/** The ⚡ Automations button at the top of a Collection, with how many it has. */
export function AutomationsButton(props: { open: boolean; count: number; onClick: () => void }) {
  return (
    <SecondaryButton
      data-testid="collection-automations-button"
      aria-pressed={props.open}
      onClick={props.onClick}
      className={`flex items-center gap-1.5${props.open ? " bg-panel-2 text-ink" : ""}`}
    >
      <Zap size={12} aria-hidden />
      Automations
      {props.count > 0 ? (
        <span className="rounded-full border border-line bg-panel-2 px-1.5 text-[11px] leading-4 text-muted">
          {props.count}
        </span>
      ) : null}
    </SecondaryButton>
  );
}

/**
 * The panel in place of the list when dohc has no automations file to show
 * for this Collection, with what says why and any way forward. Without
 * them it is still finding the file.
 */
export function AutomationsNote(props: { children?: ReactNode; onClose: () => void }) {
  return (
    <aside
      data-testid="collection-automations-panel"
      aria-label="Automations"
      aria-busy={props.children === undefined}
      className="flex w-80 shrink-0 flex-col border-l border-line bg-panel"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="flex-1" />
        <IconButton aria-label="Close automations" title="Close automations" onClick={props.onClose}>
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      {props.children === undefined ? null : <div className="px-3 py-4 text-[12px] text-muted">{props.children}</div>}
    </aside>
  );
}

/** A new slug for a copy: "stamp-copy", then "stamp-copy-2". */
function copyId(id: string, taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "-copy" : `-copy-${index}`;
    const candidate = `${id.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function writeProblem(result: Exclude<WriteCollectionAutomationsResult, { status: "written" | "reformats" }>): string {
  switch (result.status) {
    case "conflict":
      return `${AUTOMATIONS_FILE} changed while you were editing.`;
    case "unreadable":
      return `dohc cannot read every automation in ${AUTOMATIONS_FILE}, so it saved nothing. Fix the file, then try again.`;
    case "refused": {
      const [first] = result.diagnostics;
      return `dohc could not save this automation.${first ? ` ${first.code} at ${first.path}.` : ""}`;
    }
    case "unavailable":
      return "This Collection's automations run on its owner's computer, so you cannot change them here.";
  }
}

/**
 * Puts a deleted automation back where it was, from the delete's notice.
 * The notice outlives the panel, so this reads the file again itself.
 */
async function restoreAutomation(
  target: { workspaceId: string; collectionPath: string },
  automation: Automation,
  index: number,
  onError: ErrorReport,
): Promise<void> {
  const again = () => void restoreAutomation(target, automation, index, onError);
  try {
    const current = await bridge().listCollectionAutomations(target);
    const editable = current.status === "unavailable" ? null : editableOf(current);
    if (editable === null) {
      onError(`dohc cannot read every automation in ${AUTOMATIONS_FILE}, so it did not put "${automation.name}" back.`, null, again);
      return;
    }
    if (editable.automations.some((entry) => entry.id === automation.id)) return;
    const automations = [...editable.automations];
    automations.splice(Math.min(index, automations.length), 0, automation);
    const result = await bridge().writeCollectionAutomations({
      ...target, expectedContentHash: editable.contentHash, automations, reformat: false,
    });
    if (result.status === "reformats") {
      onError(`${AUTOMATIONS_FILE} changed by hand since the delete, so dohc did not put "${automation.name}" back.`, null);
    } else if (result.status !== "written") {
      onError(writeProblem(result), null, result.status === "conflict" ? again : null);
    }
  } catch (error) {
    onError(`dohc could not put "${automation.name}" back.`, error, again);
  }
}

function ReachStatus(props: {
  summary: ValidAutomationSummary;
  collectionPath: string;
  onAllow: (step: string, seq: number) => void;
}) {
  const { summary } = props;
  if (summary.cannotRun !== null) {
    return <StatusLine tone="warning" icon={AlertTriangle} label="Does not run">{summary.cannotRun}</StatusLine>;
  }
  if (summary.reach.kind === "waiting") {
    return (
      <StatusLine tone="muted" icon={Clock} label="Waiting">
        <p className="m-0">Waiting to check who can edit {collectionName(props.collectionPath)}.</p>
        {summary.reach.reason ? <p className="m-0 text-subtle">{summary.reach.reason}</p> : null}
      </StatusLine>
    );
  }
  const stopped = [...new Set(summary.reach.steps.flatMap((step) => (step.verdict === "stopped" ? [step.reason] : [])))];
  return (
    <>
      {stopped.length > 0 ? (
        <StatusLine tone="danger" icon={AlertTriangle} label="Stopped">{stopped.join(" ")}</StatusLine>
      ) : null}
      {summary.reach.steps.map((step, index) =>
        step.verdict === "held" ? (
          <StatusLine key={index} tone="warning" icon={AlertTriangle} label="Waiting for you">
            <p className="m-0">
              {step.stoppedFor
                ? `A step can now ${automationReachCopy(step)}. It stopped before because ${step.stoppedFor} could not.`
                : step.fileUnread
                  ? `A step can ${automationReachCopy(step)}. dohc cannot read the automations file in one version of the workspace. New steps here wait for you.`
                  : `A step can now ${automationReachCopy(step)}. It could not before.`}
            </p>
            <SecondaryButton size="compact" className="mt-1" onClick={() => props.onAllow(step.step, step.seq)}>
              Allow
            </SecondaryButton>
          </StatusLine>
        ) : null,
      )}
    </>
  );
}

function LastRun(props: { lastRun: ValidAutomationSummary["lastRun"]; onOpen: () => void }) {
  const { lastRun } = props;
  if (lastRun === null) return null;
  const [Icon, color, word] =
    lastRun.state === "failed"
      ? [AlertTriangle, "text-warning", "failed"]
      : lastRun.state === "done"
        ? [CheckCircle2, "text-success", "finished"]
        : [CircleDashed, "text-subtle", "is running"];
  const label = `Runs. The last run ${word} ${relativeTime(lastRun.atMs)}.`;
  return (
    <IconButton aria-label={label} title={label} onClick={props.onOpen}>
      <Icon size={13} aria-hidden className={color} />
    </IconButton>
  );
}

// How a next run shows: the person's local time, down to the minute.
// The longest delay setTimeout keeps; a longer one fires at once.
const LONGEST_TIMEOUT_MS = 2 ** 31 - 1;

/** When a switched-on schedule that can run is next due after `nowMs`, or null. */
function nextRunOf(summary: ValidAutomationSummary, nowMs: number): number | null {
  const { automation } = summary;
  if (!automation.enabled || automation.when.kind !== "schedule" || summary.cannotRun !== null) return null;
  try {
    return nextDue(automation.when, nowMs);
  } catch {
    // A time zone this computer cannot follow: main already says it cannot run.
    return null;
  }
}

/**
 * Each schedule's next run in local time, by automation id. The panel works
 * it out from the schedule as main does, and again when the soonest one
 * comes due or the window gets focus, as after the computer sleeps or moves
 * to another time zone. A new formatter each time follows that zone.
 */
function useNextRuns(file: ListCollectionAutomationsResult | null): ReadonlyMap<string, string> {
  const [tick, setTick] = useState(0);
  const { runs, soonestMs } = useMemo(() => {
    const nowMs = Date.now();
    const format = new Intl.DateTimeFormat(undefined, RUN_TIME);
    const shown = new Map<string, string>();
    let soonest: number | null = null;
    if (file?.status !== "read") return { runs: shown, soonestMs: soonest };
    for (const entry of file.automations) {
      if (!entry.valid) continue;
      const next = nextRunOf(entry, nowMs);
      if (next === null) continue;
      shown.set(entry.automationId, format.format(next));
      soonest = soonest === null ? next : Math.min(soonest, next);
    }
    return { runs: shown, soonestMs: soonest };
  }, [file, tick]);
  useEffect(() => {
    if (soonestMs === null) return;
    const again = () => setTick((value) => value + 1);
    const timer = window.setTimeout(again, Math.min(Math.max(soonestMs - Date.now(), 0), LONGEST_TIMEOUT_MS));
    window.addEventListener("focus", again);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", again);
    };
  }, [runs, soonestMs]);
  return runs;
}

type RelayHost = Extract<ScheduleHostResult, { kind: "relay" }>;
/**
 * What the panel knows about the computer that runs schedules: the relay's
 * last answer, and why dohc could not check it again, such as offline.
 */
type ScheduleHostView = { relay: RelayHost | null; note: string | null };

/**
 * Which of the owner's computers runs this workspace's schedules. The panel
 * reads it only while it shows a next run, and again when the host or the
 * account changes. An answer for another workspace or account never lands.
 */
function useScheduleHost(workspaceId: string, wanted: boolean, onError: ErrorReport) {
  const [host, setHost] = useState<ScheduleHostView | null>(null);
  const request = useRequestSequence([workspaceId]);
  const reportError = useRef(onError);
  reportError.current = onError;
  const read = useCallback(async () => {
    const token = request.next();
    try {
      const result = await bridge().readScheduleHost({ workspaceId });
      if (!request.isCurrent(token)) return;
      // A note keeps the host the relay named last, now unchecked.
      setHost((current) => ({
        relay: result.kind === "relay" ? result : result.kind === "note" ? current?.relay ?? null : null,
        note: result.kind === "note" ? result.message : null,
      }));
    } catch (error) {
      if (request.isCurrent(token)) {
        reportError.current("dohc could not read which computer runs schedules.", error, () => void read());
      }
    }
  }, [workspaceId]);
  useEffect(() => {
    request.next();
    setHost(null);
    if (!wanted) return;
    void read();
    const offHost = bridge().onScheduleHostChanged((changed) => {
      if (changed === workspaceId) void read();
    });
    const offSession = bridge().onCloudSessionChanged(({ phase }) => {
      request.next();
      setHost(null);
      if (phase === "ready") void read();
    });
    return () => {
      offHost();
      offSession();
    };
  }, [wanted, read, workspaceId]);
  return { host, read };
}

/** The name of the computer that runs schedules when it is another one, such as "this server", or null. */
function otherHostName(relay: RelayHost | null): string | null {
  const hostInstallId = relay === null ? null : shownScheduleHost(relay).hostInstallId;
  if (relay === null || hostInstallId === null) return null;
  const computer = relay.computers.find((entry) => entry.installId === hostInstallId);
  if (computer === undefined) return "another computer";
  return computer.thisComputer ? null : computerInSentence(computer);
}

/** A schedule's next run, and the computer that runs it when that is not this one. */
function NextRun(props: { at: string | undefined; runsOn: string | null }) {
  if (props.at === undefined) return null;
  return (
    <StatusLine tone="muted" icon={CalendarClock} label="Schedule">
      Next run {props.at}{props.runsOn === null ? null : ` on ${props.runsOn}`}
    </StatusLine>
  );
}

/**
 * Says once, above the list, what stops or delays this workspace's
 * schedules: no computer runs them, the server named to run them does not
 * run automations, a handover waits, or dohc could not check. Each offers
 * its way forward.
 */
function ScheduleHostNote(props: { host: ScheduleHostView | null; onCheckAgain: () => void; onChooseComputer: () => void }) {
  const relay = props.host?.relay ?? null;
  const note = props.host?.note ?? null;
  const shown = relay === null ? null : shownScheduleHost(relay);
  const from = relay?.computers.find((computer) => computer.installId === shown?.handoverFrom);
  const choose = (
    <SecondaryButton size="compact" className="mt-1.5" onClick={props.onChooseComputer}>Choose a computer</SecondaryButton>
  );
  return (
    <>
      {note === null ? null : (
        <div data-testid="schedule-host-unchecked" className="border-b border-line px-3 py-2 text-[12px] text-muted">
          <p className="m-0">{note}</p>
          <SecondaryButton size="compact" className="mt-1.5" onClick={props.onCheckAgain}>Check again</SecondaryButton>
        </div>
      )}
      {shown?.hostInstallId === null ? (
        <div data-testid="schedule-host-missing" className="border-b border-line px-3 py-2 text-[12px] text-muted">
          <p className="m-0">{shown.serverOff ? AUTOMATION_SERVER_OFF : "No computer runs this workspace's schedules."}</p>
          {choose}
        </div>
      ) : from ? (
        <div data-testid="schedule-host-handover" className="border-b border-line px-3 py-2 text-[12px] text-muted">
          <p className="m-0">Schedules wait for {computerInSentence(from)} to hand over.</p>
          {choose}
        </div>
      ) : null}
    </>
  );
}

/**
 * A Collection's automations as main reads them, for the header's count and
 * the panel. `version` rises with each answer, so views that read more (such
 * as runs) know to read again. Latest wins: a slow answer never replaces a
 * newer one.
 */
export function useCollectionAutomations(workspaceId: string, collectionPath: string | null, onError: ErrorReport) {
  const [state, setState] = useState<{ file: ListCollectionAutomationsResult | null; holdsUnreadable: boolean; version: number }>({
    file: null, holdsUnreadable: false, version: 0,
  });
  const request = useRequestSequence([workspaceId, collectionPath]);
  const reload = useCallback(async () => {
    const token = request.next();
    // Null while the page is still finding its Collection's folder.
    if (collectionPath === null) return;
    try {
      // When dohc cannot read which steps were allowed, every automation
      // waits, and the panel offers the way back the notice does.
      const [result, holds] = await Promise.all([
        bridge().listCollectionAutomations({ workspaceId, collectionPath }),
        bridge().listAutomationHolds({ workspaceId }),
      ]);
      if (request.isCurrent(token)) {
        setState((current) => ({ file: result, holdsUnreadable: holds.unreadable, version: current.version + 1 }));
      }
    } catch (error) {
      if (request.isCurrent(token)) onError("dohc could not read this Collection's automations.", error, () => void reload());
    }
  }, [workspaceId, collectionPath, onError]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload };
}

export function AutomationsPanel(props: {
  workspaceId: string;
  collectionPath: string;
  /** The dataset table this panel shows; absent for a document Collection. */
  table?: AutomationTable;
  /** A run's Undo changed records the page cannot see change, as a dataset's are. */
  onRunUndone?: () => void;
  automations: ReturnType<typeof useCollectionAutomations>;
  /** This Collection's fields, for the builder. */
  fields: readonly FieldDefinition[];
  /** Rises each time the page's header asks the panel to close. */
  closeAsk?: number;
  /** A notice asked to open one automation's runs, at the run it names; `seq` rises with each ask. */
  focus: { automationId: string; run: string | null; seq: number } | null;
  /**
   * The page asked to build a new automation from this draft, as for a button
   * nothing uses yet; `seq` rises with each ask.
   */
  start?: { automation: Automation; seq: number } | null;
  /** The panel took the start request; the page forgets it, so a new panel does not take it again. */
  onStarted?: () => void;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  /** Opens the setting where the owner chooses which computer runs schedules. */
  onOpenScheduleSettings: () => void;
  /** Opens the dialog that adds fields, such as a Button field; undefined where this person cannot. */
  onOpenFields?: () => void;
  onError: ErrorReport;
  onNotice: (message: string, undo?: () => void) => void;
}) {
  const { workspaceId, collectionPath, table, onError, onNotice } = props;
  const { file, holdsUnreadable, version, reload: load } = props.automations;
  const nextRuns = useNextRuns(file);
  const fileRef = useRef(file);
  fileRef.current = file;
  const [runsOf, setRunsOf] = useState<{ automationId: string; name: string; run?: string | null } | null>(null);
  // Runs replaces the list, so focus moves to Back, and Back returns it to
  // the actions of the row that opened Runs.
  const backButton = useRef<HTMLButtonElement | null>(null);
  const returnFocusTo = useRef<string | null>(null);
  const openRuns = (automationId: string, name: string) => {
    returnFocusTo.current = automationId;
    setRunsOf({ automationId, name });
  };
  // What the builder edits. A draft kept when the panel went away without
  // asking, such as on a workspace switch, opens again here.
  const draftKey = JSON.stringify([workspaceId, collectionPath, table?.name ?? null]);
  const [editing, setEditing] = useState<Editing | null>(() => keptDrafts.get(draftKey) ?? null);
  // The builder shows it under a schedule it edits.
  const scheduleHost = useScheduleHost(workspaceId, nextRuns.size > 0 || editing !== null, onError);
  const relayHost = scheduleHost.host?.relay ?? null;
  // Without a computer to run them, schedules have no next run to show.
  const noHost = relayHost !== null && shownScheduleHost(relayHost).hostInstallId === null;
  const runsOn = otherHostName(relayHost);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const latestDraft = useRef<{ automation: Automation; dirty: boolean } | null>(null);
  useEffect(() => {
    keptDrafts.delete(draftKey);
    return () => {
      const open = editingRef.current;
      if (open && latestDraft.current?.dirty) keptDrafts.set(draftKey, { ...open, start: latestDraft.current.automation });
    };
  }, [draftKey]);
  // Back, Close, Cancel, and a notice leave the builder through here, so a
  // draft with changes asks first.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const leave = (then: () => void) => {
    if (editingRef.current) setLeaving(() => then);
    else then();
  };
  const [saving, setSaving] = useState(false);
  const [reformat, setReformat] = useState<(() => void) | null>(null);
  // Rises when the workspace or Collection changes, or the panel closes: a
  // save or Allow that answers after that changes nothing here.
  const scope = useRequestSequence([workspaceId, collectionPath]);
  useEffect(() => setReformat(null), [workspaceId, collectionPath]);

  // Runs settle, fail, and wait on this computer without touching the file.
  useEffect(() => {
    const reload = (event: { workspaceId: string }) => {
      if (event.workspaceId === workspaceId) void load();
    };
    const offFailures = bridge().onAutomationRunsChanged(reload);
    const offHolds = bridge().onAutomationHoldsChanged(reload);
    return () => {
      offFailures();
      offHolds();
    };
  }, [workspaceId, load]);

  useEffect(() => {
    const ask = props.start;
    // The builder opens once the list is read, so it can be edited and take focus.
    if (!ask || file === null) return;
    props.onStarted?.();
    leave(() => {
      setRunsOf(null);
      // Steps the page filled in are a change, so leaving asks before it drops them.
      setEditing({ session: nextSession(), start: ask.automation, baseline: { ...ask.automation, do: [] }, original: null, cannotRun: null, reach: null });
    });
    // Only a new ask opens the builder; a reload does not.
  }, [props.start?.seq, file === null]);

  useEffect(() => {
    if (!props.focus) return;
    const summary = file?.status === "read"
      ? file.automations.find((entry) => entry.valid && entry.automationId === props.focus?.automationId)
      : undefined;
    const name = summary?.valid ? summary.automation.name : (props.focus.automationId.split("#").at(-1) ?? "");
    const { automationId, run } = props.focus;
    leave(() => {
      setEditing(null);
      setRunsOf({ automationId, name, run });
    });
    // Only a new ask moves the panel; a reload does not.
  }, [props.focus?.seq]);

  // Only an ask made while this panel is open closes it: one from before
  // it opened was already answered.
  const answeredCloseAsk = useRef(props.closeAsk ?? 0);
  useEffect(() => {
    const ask = props.closeAsk ?? 0;
    if (ask <= answeredCloseAsk.current) return;
    answeredCloseAsk.current = ask;
    leave(props.onClose);
  }, [props.closeAsk]);

  const requestRetry = useCallback(
    (target: { automationId: string; claimId: string; onServer: boolean }, startOver: boolean) =>
      bridge().retryCollectionAutomation({ workspaceId, ...target, startOver }),
    [workspaceId],
  );
  const { retry, dialog: retryDialog } = useAutomationRetry({ workspaceId, request: requestRetry, onError, onQueued: () => void load() });

  /**
   * Saves `change` of the automations over the file the panel read. A file
   * the writer would lay out differently is saved only after the person
   * agrees to lose its comments and hand formatting.
   */
  const save = useCallback(
    (
      change: (automations: Automation[]) => Automation[],
      onSaved: () => void = () => undefined,
      agreed = false,
      onNotSaved: () => void = () => undefined,
      // What the toast's Try again runs, and what saving in the new layout
      // runs, when either must check more than the file hash.
      retry?: () => void,
      agreeAndSave?: () => void,
    ) => {
      const current = fileRef.current;
      const editable = current === null || current.status === "unavailable" ? null : editableOf(current);
      if (editable === null) return;
      const again = retry ?? (() => save(change, onSaved, agreed, onNotSaved));
      const epoch = scope.current();
      setSaving(true);
      void bridge()
        .writeCollectionAutomations({
          workspaceId,
          collectionPath,
          expectedContentHash: editable.contentHash,
          automations: change(editable.automations),
          reformat: agreed,
        })
        .then(async (result) => {
          if (!scope.isCurrent(epoch)) return;
          if (result.status === "reformats") {
            setReformat(() => agreeAndSave ?? (() => save(change, onSaved, true, onNotSaved)));
          }
          await load();
          if (!scope.isCurrent(epoch)) return;
          if (result.status === "written") {
            onSaved();
            return;
          }
          onNotSaved();
          if (result.status !== "reformats") onError(writeProblem(result), null, result.status === "conflict" ? again : null);
        })
        .catch((error: unknown) => {
          if (!scope.isCurrent(epoch)) return;
          onNotSaved();
          onError(`dohc could not save ${AUTOMATIONS_FILE}.`, error, again);
        })
        .finally(() => {
          if (scope.isCurrent(epoch)) setSaving(false);
        });
    },
    [workspaceId, collectionPath, load, onError],
  );

  // Delete takes away the row that held focus, so focus moves to the next
  // automation's switch, or the one before, or Close. It moves once the
  // save has settled: switches are disabled while it runs, and a disabled
  // control cannot take focus.
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  const closeButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (runsOf) {
      backButton.current?.focus();
      return;
    }
    const automationId = returnFocusTo.current;
    returnFocusTo.current = null;
    const row = automationId === null ? undefined : rowElements.current.get(automationId.split("#").at(-1) ?? "");
    row?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
  }, [runsOf]);
  const [focusAfterDelete, setFocusAfterDelete] = useState<{ neighbor: string | null } | null>(null);
  useEffect(() => {
    if (focusAfterDelete === null || saving) return;
    const { neighbor } = focusAfterDelete;
    const row = neighbor === null ? undefined : rowElements.current.get(neighbor);
    (row?.querySelector<HTMLElement>('[role="switch"]') ?? closeButton.current)?.focus();
    setFocusAfterDelete(null);
  }, [focusAfterDelete, saving]);

  // The way back when dohc cannot read which steps were allowed: hold every
  // step for Allow again, or open the folder to fix the file.
  const resetHolds = () => {
    const epoch = scope.current();
    void bridge()
      .resetAutomationHolds({ workspaceId })
      .then((result) => {
        if (!scope.isCurrent(epoch)) return;
        if (result.status === "roster-unknown") {
          onError("Couldn't reset automation holds.", new Error("dohc cannot check who can edit this workspace yet. Try again in a moment."), resetHolds);
        } else {
          void load();
        }
      })
      .catch((error: unknown) => {
        if (scope.isCurrent(epoch)) onError("Couldn't reset automation holds.", error, resetHolds);
      });
  };
  const revealHolds = () => {
    const epoch = scope.current();
    void bridge()
      .revealAutomationHolds({ workspaceId })
      .catch((error: unknown) => {
        if (scope.isCurrent(epoch)) onError("Couldn't open the automations folder.", error);
      });
  };

  const allow = (automationId: string, definitionHash: string, step: string, seq: number) => {
    const epoch = scope.current();
    void bridge()
      .confirmCollectionAutomationStep({ workspaceId, automationId, definitionHash, step, seq, onServer: false })
      .then(() => {
        if (scope.isCurrent(epoch)) void load();
      })
      .catch((error: unknown) => {
        if (scope.isCurrent(epoch)) onError("dohc could not allow that automation step.", error);
      });
  };

  const editable = file === null || file.status === "unavailable" ? null : editableOf(file);
  // The file's cap counts every automation in it, a dataset's other tables' too.
  const count = editable?.automations.length ?? 0;
  const shown = file?.status === "read" ? file.automations.filter((entry) => shownInTable(entry, table)) : [];
  const filePath = `${collectionPath}/${AUTOMATIONS_FILE}`;

  const duplicate = (automation: Automation) =>
    save((automations) => {
      const copy: Automation = {
        ...automation,
        id: copyId(automation.id, new Set(automations.map((entry) => entry.id))),
        name: `${automation.name} copy`.slice(0, MAX_NAME_LENGTH),
        // A copy that ran at once would do everything twice.
        enabled: false,
      };
      const index = automations.findIndex((entry) => entry.id === automation.id);
      return [...automations.slice(0, index + 1), copy, ...automations.slice(index + 1)];
    });

  const remove = (automation: Automation) => {
    // Undo puts it back at its place in the file; focus moves to a row on screen.
    const index = (editable?.automations ?? []).findIndex((entry) => entry.id === automation.id);
    const rows = shown.flatMap((entry) => (entry.valid ? [entry.automation] : []));
    const at = rows.findIndex((entry) => entry.id === automation.id);
    const neighbor = rows[at + 1] ?? rows[at - 1] ?? null;
    save(
      (automations) => automations.filter((entry) => entry.id !== automation.id),
      () => {
        setFocusAfterDelete({ neighbor: neighbor?.id ?? null });
        onNotice(`Deleted "${automation.name}"`, () =>
          void restoreAutomation({ workspaceId, collectionPath }, automation, index, onError));
      },
    );
  };

  /**
   * The builder saves the automation it edits in place, or adds a new one
   * at the end, and goes back to the list once the file has it. When the
   * file's copy is no longer the one editing started from, someone else
   * changed or deleted it: nothing is saved, and the next Save replaces
   * theirs on purpose. A Try again from the toast checks again against the
   * file as it is then, even after the builder closed.
   */
  const saveEdited = (
    automation: Automation,
    open: Editing | null = editingRef.current,
    agreed = false,
    submittedDraft = latestDraft.current?.automation,
  ) => {
    const current = fileRef.current;
    const listed = current === null || current.status === "unavailable" ? undefined : editableOf(current)?.automations;
    if (!open || !listed) return;
    const stillOpen = editingRef.current?.session === open.session;
    const { original } = open;
    const now = original === null ? undefined : listed.find((entry) => entry.id === original.id);
    const stopLeaving = () => {
      if (editingRef.current?.session === open.session) setLeaving(null);
    };
    if (original !== null && now === undefined) {
      stopLeaving();
      if (stillOpen) setEditing({ ...open, original: null });
      onError(`"${original.name}" was deleted from ${AUTOMATIONS_FILE} while you were editing, so dohc did not save. Save again to add it back.`, null);
      return;
    }
    if ((original !== null && JSON.stringify(now) !== JSON.stringify(original)) ||
      (original === null && listed.some((entry) => entry.id === automation.id))) {
      stopLeaving();
      const theirs = now ?? listed.find((entry) => entry.id === automation.id) ?? null;
      if (stillOpen) setEditing({ ...open, original: theirs, baseline: theirs ?? open.baseline });
      onError(`"${automation.name}" changed in ${AUTOMATIONS_FILE} while you were editing, so dohc did not save. Save again to replace it with yours.`, null);
      return;
    }
    save(
      (automations) => original === null
        ? [...automations, automation]
        : automations.map((entry) => (entry.id === original.id ? automation : entry)),
      () => {
        const current = editingRef.current;
        if (current?.session !== open.session) return;
        // A notice can retry an older draft while this builder has newer edits.
        // Acknowledge the saved version without closing those edits.
        if (JSON.stringify(latestDraft.current?.automation) !== JSON.stringify(submittedDraft)) {
          setEditing({
            ...current,
            start: automation,
            original: automation,
            baseline: automation,
          });
          stopLeaving();
          return;
        }
        forgetDraft();
        setEditing(null);
        const then = leavingRef.current;
        setLeaving(null);
        then?.();
      },
      agreed,
      stopLeaving,
      () => saveEdited(automation, open, agreed, submittedDraft),
      () => saveEdited(automation, open, true, submittedDraft),
    );
  };
  // A draft saved or discarded is not kept when the panel goes away.
  const forgetDraft = () => {
    latestDraft.current = null;
    editingRef.current = null;
  };
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;
  const startNew = () => {
    const start = newAutomation(props.fields, table?.name ?? null);
    setEditing({ session: nextSession(), start, baseline: start, original: null, cannotRun: null, reach: null });
  };
  const edit = (entry: ValidAutomationSummary) => setEditing({
    session: nextSession(),
    start: entry.automation,
    baseline: entry.automation,
    original: entry.automation,
    cannotRun: entry.cannotRun,
    reach: entry.reach,
  });

  const title = editing ? (editing.start.id === "" ? "New automation" : editing.start.name) : runsOf?.name ?? null;
  const header = title !== null ? (
    <>
      <IconButton
        ref={backButton}
        aria-label="Back to automations"
        title="Back to automations"
        onClick={() => leave(() => {
          setEditing(null);
          setRunsOf(null);
        })}
      >
        <ArrowLeft size={14} aria-hidden />
      </IconButton>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title}</span>
    </>
  ) : (
    <>
      <span className="flex-1" />
      {/* An empty list offers New automation in its own place. */}
      {editable !== null && shown.length > 0 && count < MAX_AUTOMATIONS ? (
        <IconButton aria-label="New automation" title="New automation" onClick={startNew}>
          <Plus size={14} aria-hidden />
        </IconButton>
      ) : null}
    </>
  );

  return (
    <aside
      data-testid="collection-automations-panel"
      aria-label="Automations"
      className="flex w-80 shrink-0 flex-col border-l border-line bg-panel"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        {header}
        {file?.status === "read" || file?.status === "unreadable" ? (
          <IconButton aria-label={`Open ${AUTOMATIONS_FILE}`} title={`Open ${AUTOMATIONS_FILE}`} onClick={() => props.onOpenFile(filePath)}>
            <FileCode2 size={14} aria-hidden />
          </IconButton>
        ) : null}
        <IconButton ref={closeButton} aria-label="Close automations" title="Close automations" onClick={() => leave(props.onClose)}>
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {editing ? (
          <AutomationBuilder
            key={editing.session}
            workspaceId={workspaceId}
            collectionPath={collectionPath}
            table={table ?? null}
            fields={props.fields}
            automation={editing.start}
            baseline={editing.baseline}
            cannotRun={editing.cannotRun}
            reach={editing.reach}
            addsStay={file?.status === "read" ? file.addsStay : []}
            takenIds={new Set(editable?.automations.map((automation) => automation.id) ?? [])}
            saving={saving}
            readOnly={editable === null}
            you={(file?.status === "read" || file?.status === "missing" ? file.you : undefined) ?? null}
            leaveRequested={leaving !== null}
            onLeave={() => {
              forgetDraft();
              const then = leaving;
              setLeaving(null);
              then?.();
            }}
            onStay={() => setLeaving(null)}
            onDraftChange={(draft) => {
              latestDraft.current = draft;
            }}
            onSave={saveEdited}
            onCancel={() => leave(() => setEditing(null))}
            onOpenFile={props.onOpenFile}
            onOpenFields={props.onOpenFields}
            scheduleHost={
              <ScheduleHostNote
                host={scheduleHost.host}
                onCheckAgain={() => void scheduleHost.read()}
                onChooseComputer={props.onOpenScheduleSettings}
              />
            }
            onError={onError}
          />
        ) : runsOf ? (
          <AutomationRuns
            // A new automation or opened run starts from its first page.
            key={JSON.stringify([workspaceId, runsOf.automationId, runsOf.run ?? null])}
            workspaceId={workspaceId}
            automationId={runsOf.automationId}
            run={runsOf.run ?? null}
            refreshKey={version}
            onRetry={retry}
            onError={onError}
            onNotice={(message) => onNotice(message)}
            onUndone={props.onRunUndone}
          />
        ) : file === null ? null : file.status === "unavailable" ? (
          <p className="m-0 px-3 py-4 text-[12px] text-muted">This Collection's automations run on its owner's computer.</p>
        ) : file.status === "unreadable" ? (
          <div className="px-3 py-3 text-[12px] text-muted">
            <p className="m-0">dohc cannot read {AUTOMATIONS_FILE}. Fix the file to edit automations here.</p>
            <p className="m-0 mt-1 font-mono text-[11px] text-subtle">
              {file.diagnostic.code}{file.diagnostic.line === undefined ? "" : ` on line ${file.diagnostic.line}`}
            </p>
            <SecondaryButton size="compact" className="mt-2" onClick={() => props.onOpenFile(filePath)}>Open file</SecondaryButton>
          </div>
        ) : file.status === "missing" || shown.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-3 py-4">
            <p className="m-0 text-[12px] text-muted">No automations in this Collection yet.</p>
            {count < MAX_AUTOMATIONS ? (
              <SecondaryButton size="compact" className="flex items-center gap-1" onClick={startNew}>
                <Plus size={12} aria-hidden />
                New automation
              </SecondaryButton>
            ) : null}
          </div>
        ) : (
          <>
            {holdsUnreadable ? (
              <div data-testid="automation-holds-unreadable" className="border-b border-line px-3 py-2 text-[12px] text-muted">
                <p className="m-0">{AUTOMATION_HOLDS_UNREADABLE}</p>
                <div className="mt-1.5 flex gap-1.5">
                  <SecondaryButton size="compact" onClick={resetHolds}>Reset holds</SecondaryButton>
                  <SecondaryButton size="compact" onClick={revealHolds}>Open folder</SecondaryButton>
                </div>
              </div>
            ) : null}
            {editable === null ? (
              <div className="border-b border-line px-3 py-2 text-[12px] text-muted">
                <p className="m-0">Fix the automations dohc cannot read to edit them here.</p>
                <SecondaryButton size="compact" className="mt-1.5" onClick={() => props.onOpenFile(filePath)}>Open file</SecondaryButton>
              </div>
            ) : null}
            <ScheduleHostNote
              host={scheduleHost.host}
              onCheckAgain={() => void scheduleHost.read()}
              onChooseComputer={props.onOpenScheduleSettings}
            />
            <ul className="m-0 list-none p-0">
              {shown.map((entry, index) =>
                entry.valid ? (
                  <li
                    key={entry.automationId}
                    ref={(element) => {
                      if (element) rowElements.current.set(entry.automation.id, element);
                      else rowElements.current.delete(entry.automation.id);
                    }}
                    data-testid={`automation-${entry.automation.id}`}
                    className="flex items-start gap-2 border-b border-line px-3 py-2.5"
                  >
                    <div className="pt-0.5">
                      <SwitchControl
                        label={entry.automation.name}
                        checked={entry.automation.enabled}
                        disabled={editable === null || saving}
                        onChange={(enabled) =>
                          save((automations) => automations.map((automation) =>
                            automation.id === entry.automation.id ? { ...automation, enabled } : automation))}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        disabled={editable === null}
                        onClick={() => edit(entry)}
                        className="block max-w-full truncate rounded text-left text-[13px] font-medium text-ink hover:underline disabled:no-underline"
                      >
                        {entry.automation.name}
                      </button>
                      <p className="m-0 mt-0.5 break-words text-[12px] leading-snug text-muted" title={sentenceText(automationSentence(entry.automation))}>
                        <Sentence parts={automationSentence(entry.automation)} />
                      </p>
                      <ReachStatus
                        summary={entry}
                        collectionPath={collectionPath}
                        onAllow={(step, seq) => allow(entry.automationId, entry.definitionHash, step, seq)}
                      />
                      <NextRun at={noHost ? undefined : nextRuns.get(entry.automationId)} runsOn={runsOn} />
                    </div>
                    <LastRun
                      lastRun={entry.lastRun}
                      onOpen={() => openRuns(entry.automationId, entry.automation.name)}
                    />
                    <MoreMenu
                      label={`${entry.automation.name} actions`}
                      items={[
                        { label: "Edit", onSelect: () => edit(entry), disabled: editable === null },
                        { label: "Runs", onSelect: () => openRuns(entry.automationId, entry.automation.name) },
                        { label: "Duplicate", onSelect: () => duplicate(entry.automation), disabled: editable === null || saving || count >= MAX_AUTOMATIONS },
                        { label: "Delete", onSelect: () => remove(entry.automation), disabled: editable === null || saving },
                      ]}
                    />
                  </li>
                ) : (
                  <li key={`invalid-${index}`} className="border-b border-line px-3 py-2.5">
                    <p className="m-0 truncate text-[13px] font-medium text-ink">{entry.name ?? entry.id ?? `Automation ${index + 1}`}</p>
                    <StatusLine tone="danger" icon={AlertTriangle} label="Cannot read">
                      <p className="m-0">dohc cannot read this automation, so it does not run.</p>
                      {entry.diagnostics[0] ? (
                        <p className="m-0 font-mono text-[11px] text-subtle">
                          {entry.diagnostics[0].code} at {entry.diagnostics[0].path}
                        </p>
                      ) : null}
                    </StatusLine>
                  </li>
                ),
              )}
            </ul>
          </>
        )}
      </div>
      {retryDialog}
      {reformat ? (
        <ConfirmDialog
          title={`Save ${AUTOMATIONS_FILE} in dohc's layout?`}
          confirmLabel="Save"
          testId="automations-reformat"
          cancelTestId="automations-reformat-cancel"
          confirmTestId="automations-reformat-confirm"
          onCancel={() => setReformat(null)}
          onConfirm={() => {
            const agreed = reformat;
            setReformat(null);
            agreed();
          }}
        >
          <p className="m-0 mt-2 text-[13px] text-muted">
            dohc rewrites the whole file when it saves, so you lose its comments and hand formatting.
          </p>
        </ConfirmDialog>
      ) : null}
    </aside>
  );
}
