import { AlertTriangle, ArrowLeft, CheckCircle2, CircleDashed, Clock, FileCode2, Info, MoreHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ListCollectionAutomationsResult, WriteCollectionAutomationsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { relativeTime } from "../relativeTime";
import { SwitchControl } from "../settings/SettingRow";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { IconButton, SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { AutomationRuns } from "./AutomationRuns";
import {
  automationSentence,
  collectionName,
  sentenceText,
  type Automation,
  type AutomationsFile,
  type SentencePart,
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

/** What the panel can save over: the file's hash and its automations, or null when editing is off. */
function editableOf(file: AutomationsFile | null): { contentHash: string | null; automations: Automation[] } | null {
  if (file?.status === "missing") return { contentHash: null, automations: [] };
  if (file?.status !== "read" || file.automations.some((entry) => !entry.valid)) return null;
  return {
    contentHash: file.contentHash,
    automations: file.automations.flatMap((entry) => (entry.valid ? [entry.automation] : [])),
  };
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

function Sentence({ parts }: { parts: readonly SentencePart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "code" ? (
          <code key={index} className="rounded bg-panel-2 px-1 font-mono text-[11px] text-ink">{part.text}</code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function StatusLine(props: { tone: "muted" | "warning" | "danger"; icon: typeof Info; label: string; children: ReactNode }) {
  const color = props.tone === "danger" ? "text-danger" : props.tone === "warning" ? "text-warning" : "text-subtle";
  return (
    <div className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug text-muted">
      <props.icon size={12} aria-label={props.label} className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

function ReachStatus(props: {
  summary: ValidAutomationSummary;
  collectionPath: string;
  onAllow: (step: number, seq: number) => void;
}) {
  const { summary } = props;
  if (summary.unsupported !== null) {
    return <StatusLine tone="muted" icon={Info} label="Cannot run yet">{summary.unsupported}</StatusLine>;
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
              A step can now {step.action === "find" ? `find records in ${step.target}` : `change ${step.target}`}.{" "}
              {step.stoppedFor ? `It stopped before because ${step.stoppedFor} could not.` : "It could not before."}
            </p>
            <SecondaryButton size="compact" className="mt-1" onClick={() => props.onAllow(index, step.seq)}>
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

type MenuItem = { label: string; onSelect: () => void; disabled?: boolean };

const MENU_WIDTH_PX = 144;

/**
 * A row's ••• menu. Focus moves between its items: arrow keys, Home, and
 * End move it, Enter or Space picks, and Escape or a pick returns it to the
 * trigger. It sits at a fixed place under its trigger, so the panel's
 * scrolling list cannot clip it.
 */
function RowMenu(props: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open !== null]);
  const close = () => {
    setOpen(null);
    trigger.current?.focus();
  };
  const pick = (item: MenuItem) => {
    if (item.disabled) return;
    close();
    item.onSelect();
  };
  const move = (to: (current: number, count: number) => number) => {
    const count = props.items.length;
    const current = items.current.findIndex((item) => item === document.activeElement);
    items.current[(to(current, count) + count) % count]?.focus();
  };
  return (
    <div>
      <IconButton
        ref={trigger}
        aria-label={props.label}
        title={props.label}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onClick={() => {
          const box = trigger.current?.getBoundingClientRect();
          setOpen((value) => (value || !box ? null : { top: box.bottom + 4, left: Math.max(4, box.right - MENU_WIDTH_PX) }));
        }}
      >
        <MoreHorizontal size={14} aria-hidden />
      </IconButton>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={props.label}
          onKeyDown={(event) => {
            const moves: Record<string, (current: number, count: number) => number> = {
              ArrowDown: (current) => current + 1,
              ArrowUp: (current) => current - 1,
              Home: () => 0,
              End: (_current, count) => count - 1,
            };
            const to = moves[event.key];
            if (to) {
              event.preventDefault();
              move(to);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "Tab") {
              setOpen(null);
            }
          }}
          style={{ top: open.top, left: open.left, width: MENU_WIDTH_PX }}
          className="dohc-popover dohc-pop-in fixed z-40 rounded-lg border border-line bg-panel p-1"
        >
          {props.items.map((item, index) => (
            <button
              key={item.label}
              ref={(element) => {
                items.current[index] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              // Disabled items keep focus, so arrow keys pass over them.
              aria-disabled={item.disabled ? true : undefined}
              onMouseEnter={(event) => event.currentTarget.focus()}
              onClick={() => pick(item)}
              className="flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-panel-2 hover:text-ink focus:bg-line focus:text-ink aria-disabled:opacity-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A Collection's automations as main reads them, for the header's count and
 * the panel. `version` rises with each answer, so views that read more (such
 * as runs) know to read again. Latest wins: a slow answer never replaces a
 * newer one.
 */
export function useCollectionAutomations(workspaceId: string, collectionPath: string, onError: ErrorReport) {
  const [state, setState] = useState<{ file: ListCollectionAutomationsResult | null; holdsUnreadable: boolean; version: number }>({
    file: null, holdsUnreadable: false, version: 0,
  });
  const request = useRequestSequence([workspaceId, collectionPath]);
  const reload = useCallback(async () => {
    const token = request.next();
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
  automations: ReturnType<typeof useCollectionAutomations>;
  /** A notice asked to open one automation's runs; `seq` rises with each ask. */
  focus: { automationId: string; seq: number } | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onError: ErrorReport;
  onNotice: (message: string, undo?: () => void) => void;
}) {
  const { workspaceId, collectionPath, onError, onNotice } = props;
  const { file, holdsUnreadable, version, reload: load } = props.automations;
  const fileRef = useRef(file);
  fileRef.current = file;
  const [runsOf, setRunsOf] = useState<{ automationId: string; name: string } | null>(null);
  // Runs replaces the list, so focus moves to Back, and Back returns it to
  // the actions of the row that opened Runs.
  const backButton = useRef<HTMLButtonElement | null>(null);
  const returnFocusTo = useRef<string | null>(null);
  const openRuns = (automationId: string, name: string) => {
    returnFocusTo.current = automationId;
    setRunsOf({ automationId, name });
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
    const offFailures = bridge().onAutomationFailuresChanged(reload);
    const offHolds = bridge().onAutomationHoldsChanged(reload);
    return () => {
      offFailures();
      offHolds();
    };
  }, [workspaceId, load]);

  useEffect(() => {
    if (!props.focus) return;
    const summary = file?.status === "read"
      ? file.automations.find((entry) => entry.valid && entry.automationId === props.focus?.automationId)
      : undefined;
    const name = summary?.valid ? summary.automation.name : (props.focus.automationId.split("#").at(-1) ?? "");
    setRunsOf({ automationId: props.focus.automationId, name });
    // Only a new ask moves the panel; a reload does not.
  }, [props.focus?.seq]);

  const { retry, dialog: retryDialog } = useAutomationRetry({ workspaceId, onError, onQueued: () => void load() });

  /**
   * Saves `change` of the automations over the file the panel read. A file
   * the writer would lay out differently is saved only after the person
   * agrees to lose its comments and hand formatting.
   */
  const save = useCallback(
    (change: (automations: Automation[]) => Automation[], onSaved: () => void = () => undefined, agreed = false) => {
      const current = fileRef.current;
      const editable = current === null || current.status === "unavailable" ? null : editableOf(current);
      if (editable === null) return;
      const again = () => save(change, onSaved, agreed);
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
          if (result.status === "reformats") setReformat(() => () => save(change, onSaved, true));
          await load();
          if (!scope.isCurrent(epoch)) return;
          if (result.status === "written") onSaved();
          else if (result.status !== "reformats") {
            onError(writeProblem(result), null, result.status === "conflict" ? again : null);
          }
        })
        .catch((error: unknown) => {
          if (scope.isCurrent(epoch)) onError(`dohc could not save ${AUTOMATIONS_FILE}.`, error, again);
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

  const allow = (automationId: string, definitionHash: string, step: number, seq: number) => {
    const epoch = scope.current();
    void bridge()
      .confirmCollectionAutomationStep({ workspaceId, automationId, definitionHash, step, seq })
      .then(() => {
        if (scope.isCurrent(epoch)) void load();
      })
      .catch((error: unknown) => {
        if (scope.isCurrent(epoch)) onError("dohc could not allow that automation step.", error);
      });
  };

  const editable = file === null || file.status === "unavailable" ? null : editableOf(file);
  const count = editable?.automations.length ?? 0;
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
    const list = editable?.automations ?? [];
    const index = list.findIndex((entry) => entry.id === automation.id);
    const neighbor = list[index + 1] ?? list[index - 1] ?? null;
    save(
      (automations) => automations.filter((entry) => entry.id !== automation.id),
      () => {
        setFocusAfterDelete({ neighbor: neighbor?.id ?? null });
        onNotice(`Deleted "${automation.name}"`, () =>
          void restoreAutomation({ workspaceId, collectionPath }, automation, index, onError));
      },
    );
  };

  const header = runsOf ? (
    <>
      <IconButton ref={backButton} aria-label="Back to automations" title="Back to automations" onClick={() => setRunsOf(null)}>
        <ArrowLeft size={14} aria-hidden />
      </IconButton>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{runsOf.name}</span>
    </>
  ) : (
    <span className="flex-1" />
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
        <IconButton ref={closeButton} aria-label="Close automations" title="Close automations" onClick={props.onClose}>
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {runsOf ? (
          <AutomationRuns
            workspaceId={workspaceId}
            automationId={runsOf.automationId}
            refreshKey={version}
            onRetry={retry}
            onError={onError}
            onNotice={(message) => onNotice(message)}
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
        ) : file.status === "missing" || file.automations.length === 0 ? (
          <p className="m-0 px-3 py-4 text-[12px] text-muted">No automations in this Collection yet.</p>
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
            <ul className="m-0 list-none p-0">
              {file.automations.map((entry, index) =>
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
                      <p className="m-0 truncate text-[13px] font-medium text-ink">{entry.automation.name}</p>
                      <p className="m-0 mt-0.5 break-words text-[12px] leading-snug text-muted" title={sentenceText(automationSentence(entry.automation))}>
                        <Sentence parts={automationSentence(entry.automation)} />
                      </p>
                      <ReachStatus
                        summary={entry}
                        collectionPath={collectionPath}
                        onAllow={(step, seq) => allow(entry.automationId, entry.definitionHash, step, seq)}
                      />
                    </div>
                    <LastRun
                      lastRun={entry.lastRun}
                      onOpen={() => openRuns(entry.automationId, entry.automation.name)}
                    />
                    <RowMenu
                      label={`${entry.automation.name} actions`}
                      items={[
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
