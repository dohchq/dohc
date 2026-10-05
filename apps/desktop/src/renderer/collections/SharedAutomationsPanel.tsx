import { AlertTriangle, Clock, FileCode2, History as HistoryIcon, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ListCollectionAutomationsResult, SwitchCollectionAutomationResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { SwitchControl } from "../settings/SettingRow";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { IconButton, Pill, SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { Sentence, StatusLine } from "./AutomationParts";
import { AUTOMATIONS_FILE, type AutomationFocus } from "./AutomationsPanel";
import { automationSentence, sentenceText } from "./automationSentence";

// The ⚡ panel for a Collection reached through a share: its automations as
// automations.yaml says, with a switch where the share allows one. A switch
// saves the file. The host runs the automations and keeps their runs, so
// this panel never says whether one runs.

export type SharedAutomationDefinitions = Extract<ListCollectionAutomationsResult, { status: "shared" }>["definitions"];
type ErrorReport = (fallback: string, error: unknown, retry?: (() => void) | null) => void;

/** What went wrong with a switch, or null when the panel shows the outcome itself. */
function switchProblem(result: SwitchCollectionAutomationResult, words: string): string | null {
  switch (result.status) {
    case "written":
    case "reformats":
      return null;
    case "conflict":
      return `${AUTOMATIONS_FILE} changed after dohc read it, so dohc did not switch ${words}.`;
    case "unknown":
      return `dohc could not tell whether it switched ${words}.`;
    case "unreadable":
      return `dohc cannot read every automation in ${AUTOMATIONS_FILE}, so it saved nothing. Fix the file, then try again.`;
    case "refused": {
      const [first] = result.diagnostics;
      return `dohc could not switch ${words}.${first ? ` ${first.code} at ${first.path}.` : ""}`;
    }
    case "unavailable":
    case "refused-write":
      return result.reason;
  }
}

/**
 * Switches one automation over automations.yaml as main reads it now. This
 * is a switch's Try again, which a Notices row keeps after the panel closes.
 */
async function switchAgain(
  target: { workspaceId: string; collectionPath: string },
  automation: string,
  name: string,
  enabled: boolean,
  onError: ErrorReport,
): Promise<void> {
  const words = `"${name}" ${enabled ? "on" : "off"}`;
  const again = () => void switchAgain(target, automation, name, enabled, onError);
  try {
    const listed = await bridge().listCollectionAutomations(target);
    const definitions = listed.status === "shared" ? listed.definitions : null;
    const entry = definitions?.file.status === "read"
      ? definitions.file.entries.find((candidate) => candidate.status === "valid" && candidate.automation.id === automation)
      : undefined;
    if (!definitions?.contentHash || entry === undefined) {
      onError(`${AUTOMATIONS_FILE} no longer has "${name}", so dohc did not switch it.`, null);
      return;
    }
    if (entry.enabledInFile === enabled) return;
    if (!entry.canSwitch) {
      onError(entry.switchReason ?? `dohc could not switch ${words}.`, null);
      return;
    }
    const result = await bridge().switchCollectionAutomation({
      ...target, automation, enabled, expectedContentHash: definitions.contentHash, reformat: false, submitId: crypto.randomUUID(),
    });
    const problem = result.status === "reformats"
      ? `${AUTOMATIONS_FILE} has hand formatting, so dohc did not switch ${words}. Switch it in the panel to save the file in dohc's layout.`
      : switchProblem(result, words);
    if (problem !== null) onError(problem, null, result.status === "unknown" || result.status === "conflict" ? again : null);
  } catch (error) {
    onError(`dohc could not switch ${words}.`, error, again);
  }
}

export function SharedAutomationsPanel(props: {
  readOnly?: boolean;
  workspaceId: string;
  collectionPath: string;
  definitions: SharedAutomationDefinitions;
  /** Rises with each read of the file that succeeds. */
  version: number;
  reload: () => Promise<void>;
  /** A notice's ask to show one automation's switch, by its id in automations.yaml. */
  focus: AutomationFocus | null;
  closeAsk?: number;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onError: ErrorReport;
}) {
  const { workspaceId, collectionPath, definitions, version, reload, onError } = props;
  const filePath = `${collectionPath}/${AUTOMATIONS_FILE}`;
  // The switch on its way to main, shown where the person put it.
  const [sending, setSending] = useState<{ automation: string; enabled: boolean } | null>(null);
  // Switches main saved, by automation. Until a read after the save
  // succeeds, each shows what main saved and whether the relay has it.
  const [saved, setSaved] = useState<ReadonlyMap<string, { enabled: boolean; pending: boolean; version: number }>>(new Map());
  const latest = useRef({ definitions, version, saved, readOnly: props.readOnly });
  latest.current = { definitions, version, saved, readOnly: props.readOnly };
  // The file main wrote last, which the next switch saves over until a read replaces it.
  const lastWrite = useRef<{ contentHash: string; version: number } | null>(null);
  const [reformat, setReformat] = useState<(() => void) | null>(null);
  // One switch at a time: each saves over the file the one before changed.
  const busy = useRef(false);
  // Rises when the workspace or Collection changes, or the panel closes: a
  // switch that answers after that changes nothing here.
  const scope = useRequestSequence([workspaceId, collectionPath]);
  useEffect(() => {
    busy.current = false;
    lastWrite.current = null;
    setSending(null);
    setSaved(new Map());
    setReformat(null);
  }, [workspaceId, collectionPath]);
  // A read after a save says whether the relay has the file yet.
  useEffect(() => {
    if (definitions.sync === "pending") return;
    setSaved((current) => {
      const kept = [...current].filter(([, save]) => save.version === version);
      return kept.length === current.size ? current : new Map(kept);
    });
  }, [definitions, version]);

  const toggle = (automation: string, name: string, enabled: boolean, agreed = false) => {
    const { definitions: current, version: read, saved: saves, readOnly } = latest.current;
    const entry = current.file.status === "read"
      ? current.file.entries.find((candidate) => candidate.status === "valid" && candidate.automation.id === automation)
      : undefined;
    const save = saves.get(automation);
    const shown = save !== undefined && save.version === read ? save.enabled : entry?.enabledInFile;
    const expectedContentHash = lastWrite.current?.version === read ? lastWrite.current.contentHash : current.contentHash;
    if (readOnly || busy.current || expectedContentHash === null || !entry?.canSwitch || shown === enabled) return;
    const words = `"${name}" ${enabled ? "on" : "off"}`;
    const again = () => void switchAgain({ workspaceId, collectionPath }, automation, name, enabled, onError);
    const epoch = scope.current();
    busy.current = true;
    setSending({ automation, enabled });
    void bridge()
      .switchCollectionAutomation({
        workspaceId, collectionPath, automation, enabled, expectedContentHash, reformat: agreed, submitId: crypto.randomUUID(),
      })
      .then(async (result) => {
        if (!scope.isCurrent(epoch)) return;
        if (result.status === "reformats") {
          setReformat(() => () => toggle(automation, name, enabled, true));
          return;
        }
        if (result.status === "written") {
          const save = { enabled, pending: result.sync === "pending", version: latest.current.version };
          lastWrite.current = { contentHash: result.contentHash, version: save.version };
          setSaved((saves) => new Map(saves).set(automation, save));
        }
        await reload();
        if (!scope.isCurrent(epoch)) return;
        const problem = switchProblem(result, words);
        // Try again reads the file again, so it still works after the panel closes.
        if (problem !== null) onError(problem, null, result.status === "unknown" || result.status === "conflict" ? again : null);
      })
      .catch((error: unknown) => {
        if (scope.isCurrent(epoch)) onError(`dohc could not switch ${words}.`, error, again);
      })
      .finally(() => {
        if (!scope.isCurrent(epoch)) return;
        busy.current = false;
        setSending(null);
      });
  };

  // A notice's ask lands on the automation's switch, or its row when the
  // share allows no switch. An automation this panel has not read yet gets
  // one more read, and Close holds focus until it shows.
  const rows = useRef(new Map<string, HTMLLIElement>());
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const rowRef = (id: string | null) => (element: HTMLLIElement | null) => {
    if (id === null) return;
    if (element) rows.current.set(id, element);
    else rows.current.delete(id);
  };
  const [focusAsk, setFocusAsk] = useState<{ automation: string; version: number } | null>(null);
  useEffect(() => {
    if (props.focus?.controls) setFocusAsk({ automation: props.focus.automationId, version: latest.current.version });
  }, [props.focus?.seq]);
  useEffect(() => {
    if (focusAsk === null) return;
    const row = rows.current.get(focusAsk.automation);
    if (row) {
      (row.querySelector<HTMLElement>('[role="switch"]:enabled') ?? row).focus();
      setFocusAsk(null);
      return;
    }
    closeButton.current?.focus();
    if (version === focusAsk.version) void reload();
    else setFocusAsk(null);
  }, [focusAsk, version]);

  // Only an ask made while this panel is open closes it.
  const answeredCloseAsk = useRef(props.closeAsk ?? 0);
  useEffect(() => {
    const ask = props.closeAsk ?? 0;
    if (ask <= answeredCloseAsk.current) return;
    answeredCloseAsk.current = ask;
    props.onClose();
  }, [props.closeAsk]);

  const file = definitions.file;
  const entries = file.status === "read" ? file.entries : [];
  const pending = definitions.sync === "pending";
  const unreadable = entries.some((entry) => entry.status === "invalid");
  const fileNote = (children: ReactNode) => (
    <div className="border-b border-line px-3 py-2 text-[12px] text-muted">{children}</div>
  );

  return (
    <aside
      data-testid="collection-automations-panel"
      aria-label="Automations"
      className="flex w-80 shrink-0 flex-col border-l border-line bg-panel"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="flex-1" />
        {file.status === "missing" ? null : (
          <IconButton aria-label={`Open ${AUTOMATIONS_FILE}`} title={`Open ${AUTOMATIONS_FILE}`} onClick={() => props.onOpenFile(filePath)}>
            <FileCode2 size={14} aria-hidden />
          </IconButton>
        )}
        <IconButton ref={closeButton} aria-label="Close automations" title="Close automations" onClick={props.onClose}>
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {file.status === "missing" || (file.status === "read" && entries.length === 0) ? (
          <p className="m-0 px-3 py-4 text-[12px] text-muted">This Collection has no automations.</p>
        ) : file.status === "unreadable" ? (
          <div className="px-3 py-3 text-[12px] text-muted">
            <p className="m-0">dohc cannot read {AUTOMATIONS_FILE}.</p>
            <p className="m-0 mt-1 font-mono text-[11px] text-subtle">
              {file.diagnostic.code}{file.diagnostic.line === undefined ? "" : ` on line ${file.diagnostic.line}`}
            </p>
            <SecondaryButton size="compact" className="mt-2" onClick={() => props.onOpenFile(filePath)}>Open file</SecondaryButton>
          </div>
        ) : (
          <>
            {!props.readOnly && definitions.canSwitch && unreadable ? fileNote(
              <>
                <p className="m-0">Fix the automations dohc cannot read to switch them here.</p>
                <SecondaryButton size="compact" className="mt-1.5" onClick={() => props.onOpenFile(filePath)}>Open file</SecondaryButton>
              </>,
            ) : null}
            {definitions.sync === "refused" ? fileNote(
              <StatusLine tone="warning" icon={AlertTriangle} label="Not synced">Your change to {AUTOMATIONS_FILE} did not sync.</StatusLine>,
            ) : pending && saved.size === 0 && sending === null ? fileNote(
              <StatusLine tone="muted" icon={Clock} label="Waiting">Waiting to sync</StatusLine>,
            ) : null}
            <ul className="m-0 list-none p-0">
              {entries.map((entry, index) => {
                if (entry.status === "invalid") {
                  const [diagnostic] = entry.diagnostics;
                  return (
                    <li key={`invalid-${index}`} ref={rowRef(entry.id)} tabIndex={-1} className="border-b border-line px-3 py-2.5">
                      <p className="m-0 truncate text-[13px] font-medium text-ink">{entry.name ?? entry.id ?? `Automation ${index + 1}`}</p>
                      <StatusLine tone="danger" icon={AlertTriangle} label="Cannot read">
                        <p className="m-0">dohc cannot read this automation.</p>
                        {diagnostic ? <p className="m-0 font-mono text-[11px] text-subtle">{diagnostic.code} at {diagnostic.path}</p> : null}
                      </StatusLine>
                    </li>
                  );
                }
                const { automation } = entry;
                const sent = sending?.automation === automation.id ? sending : null;
                const save = saved.get(automation.id);
                // No read since main saved it: show what main saved.
                const unread = save !== undefined && save.version === version;
                const sentence = automationSentence(automation);
                return (
                  <li
                    key={automation.id}
                    ref={rowRef(automation.id)}
                    tabIndex={-1}
                    data-testid={`automation-${automation.id}`}
                    className="flex items-start gap-2 border-b border-line px-3 py-2.5"
                  >
                    <div className="w-9 shrink-0 pt-0.5">
                      {!props.readOnly && entry.canSwitch ? (
                        <SwitchControl
                          label={automation.name}
                          checked={sent?.enabled ?? (unread ? save.enabled : entry.enabledInFile === true)}
                          disabled={sending !== null}
                          onChange={(enabled) => toggle(automation.id, automation.name, enabled)}
                        />
                      ) : (
                        <Pill>{entry.enabledInFile ? "On" : "Off"}</Pill>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="m-0 truncate text-[13px] font-medium text-ink">{automation.name}</p>
                      <p className="m-0 mt-0.5 break-words text-[12px] leading-snug text-muted" title={sentenceText(sentence)}>
                        <Sentence parts={sentence} />
                      </p>
                      {entry.switchReason ? <p className="m-0 mt-1 text-[12px] leading-snug text-muted">{entry.switchReason}</p> : null}
                      {sent !== null || (save !== undefined && (unread ? save.pending : pending)) ? (
                        <StatusLine tone="muted" icon={Clock} label="Waiting">Waiting to sync</StatusLine>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="m-0 flex items-start gap-1.5 px-3 py-3 text-[12px] leading-snug text-muted">
              <HistoryIcon size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
              Run history stays on the owner's computer.
            </p>
          </>
        )}
      </div>
      {reformat && !props.readOnly ? (
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
