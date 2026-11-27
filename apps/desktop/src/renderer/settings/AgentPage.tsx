import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  CircleAlert,
  Clock,
  ExternalLink,
  FilePenLine,
  Folder,
  Forward,
  History,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Pause,
  Pencil,
  Send,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import {
  AGENT_TOOLS,
  launchCommand,
  launchCommandHint,
  launchFromCommand,
  launchProfile,
  type AgentToolsResult,
} from "../../agents/agentToolCatalog";
import {
  agentHandle,
  MAX_AGENT_NOTE_LENGTH,
  type Agent,
  type AgentSettings,
  type AgentThread,
  type DesktopUserSettings,
} from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CopyButton } from "../ui/CopyButton";
import { RetryRow, SecondaryButton } from "../ui/controls";
import { isComposingKey } from "../ui/keys";
import { Menu } from "../ui/Menu";
import { SegmentedControl } from "../ui/SegmentedControl";
import { useRequestSequence } from "../useRequestSequence";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import { ChangeThreadDialog } from "./ChangeThreadDialog";
import { ForwardWorkspaceDialog } from "./ForwardWorkspaceDialog";
import { HueControl, SwitchControl } from "./SettingRow";
import {
  T3_CODE,
  T3_CODE_CANNOT_KEEP,
  T3CodeAllow,
  T3CodeAllowAgain,
  t3CodeAllowed,
  t3CodeAllowedUntil,
  t3CodeModeName,
  useT3CodeAccess,
} from "./T3CodeThread";

const LINK = "rounded text-[12px] text-ink underline underline-offset-2 hover:text-muted";
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 1440;
export const BOX = "rounded-lg border border-line bg-panel";
export const ROW =
  "flex min-h-11 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0";
export const SECTION = "m-0 mb-1.5 mt-5 text-[12px] font-medium text-subtle";
export const VALUE = "ml-auto flex min-w-0 items-center gap-2 text-[12px] text-muted";

export type CheckState = { status: "replied"; seconds: number } | { status: "failed" };

/** The run a person started in Settings for an agent they run, and its control. */
export type AgentRunControl = {
  activeRun: { id: string; agentId: string } | null;
  busy: boolean;
  onToggle: (agentId: string) => void;
};

function validMinutes(value: string): boolean {
  const minutes = Number(value);
  return (
    value.trim() !== "" &&
    Number.isInteger(minutes) &&
    minutes >= MIN_TIMEOUT &&
    minutes <= MAX_TIMEOUT
  );
}

/** The tool as detection found it, such as "Codex 0.98, signed in". */
export function toolLine(tool: "claude" | "codex", detection: AgentToolsResult | null): string {
  const name = AGENT_TOOLS.find((entry) => entry.id === tool)!.name;
  const found = detection?.tools.find((entry) => entry.tool === tool);
  if (!found) return name;
  if (found.probe === "not-found") return `${name}, not found`;
  const auth =
    found.auth === "signed-in" ? ", signed in" : found.auth === "signed-out" ? ", signed out" : "";
  return `${name}${found.version ? ` ${found.version}` : ""}${auth}`;
}

// One value edited in place: Enter or leaving the field saves, Escape keeps it as it was.
// A value it can't save keeps the field open, with the reason beside it.
function InlineField(props: {
  label: string;
  initial: string;
  className: string;
  numeric?: boolean;
  // Why a value can't be saved, or null when it can.
  problem?: (value: string) => string | null;
  // Shown right after the field, such as its unit.
  after?: ReactNode;
  // A line under the field about what the draft does once saved.
  hint?: (draft: string) => string;
  onCommit: (value: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const cancelled = useRef(false);
  const hintId = useId();
  useEffect(() => input.current?.select(), []);
  const field = (
    <>
      <input
        ref={input}
        aria-label={props.label}
        aria-invalid={error ? true : undefined}
        data-unsaved={error ? true : undefined}
        data-edit-in-place
        aria-describedby={
          [props.hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined
        }
        value={draft}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="none"
        {...(props.numeric
          ? {
              type: "number",
              inputMode: "numeric" as const,
              min: MIN_TIMEOUT,
              max: MAX_TIMEOUT,
              step: 1,
            }
          : { maxLength: 4096 })}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError(null);
        }}
        onBlur={() => {
          const found = cancelled.current ? null : (props.problem?.(draft) ?? null);
          setError(found);
          if (found) return;
          if (!cancelled.current) props.onCommit(draft);
          props.onDone();
        }}
        onKeyDown={(event) => {
          if (isComposingKey(event)) return;
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelled.current = true;
            event.currentTarget.blur();
          }
        }}
        className={`h-7 rounded-md border bg-bg px-2 text-[12px] text-ink ${error ? "border-danger" : "border-line focus:border-ink"} ${props.className}`}
      />
      {props.after}
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="flex min-w-0 items-center gap-1 text-[12px] text-danger"
        >
          <CircleAlert size={12} aria-hidden className="shrink-0" />
          {error}
        </span>
      ) : null}
    </>
  );
  return props.hint ? (
    <div className="flex w-full min-w-0 flex-col gap-1">
      {field}
      <p id={hintId} className="m-0 text-[12px] text-muted">
        {props.hint(draft)}
      </p>
    </div>
  ) : (
    field
  );
}

export function PageRow(props: {
  icon?: ReactNode;
  label: ReactNode;
  labelId?: string;
  testId?: string;
  children?: ReactNode;
  wrap?: boolean;
}) {
  return (
    <div data-testid={props.testId} className={`${ROW} ${props.wrap ? "flex-wrap" : ""}`}>
      {props.icon ? (
        <span aria-hidden className="shrink-0 text-muted">
          {props.icon}
        </span>
      ) : null}
      <span id={props.labelId} className="min-w-0 shrink text-[13px] text-ink">
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

// What a check says on the Test row, or what an agent you run is doing.
export function checkStatus(props: {
  checking: boolean;
  check: CheckState | undefined;
}): ReactNode {
  return props.checking ? (
    <span className="inline-flex items-center gap-1 text-muted">
      <LoaderCircle size={12} aria-hidden className="animate-spin" />
      Checking…
    </span>
  ) : props.check?.status === "replied" ? (
    <span className="inline-flex items-center gap-1 text-success">
      <Check size={12} aria-hidden />
      {`Replied in ${props.check.seconds} s`}
    </span>
  ) : props.check?.status === "failed" ? (
    <span className="inline-flex items-center gap-1 text-danger">
      <CircleAlert size={12} aria-hidden />
      Did not reply
    </span>
  ) : (
    <span className="text-muted">Not checked</span>
  );
}

type PageError = (message: string, cause?: unknown, retry?: () => Promise<void>) => void;

const WHILE_BUSY = [
  { value: "line", label: "Wait in line" },
  { value: "own-chat", label: "Right away in its own chat" },
  { value: "steer", label: "Go right away" },
] as const;
const ACCESS_READ_FAILED = "dohc could not check whether T3 Code allows it.";

// The person's note for an agent with a thread. Leaving the field saves, and
// Escape keeps the note as it was. An empty note removes the key.
function AgentNote(props: {
  agent: Agent;
  onChange: (change: (agent: AgentSettings) => AgentSettings) => void;
}) {
  const saved = props.agent.note ?? "";
  const [held, setHeld] = useState(saved);
  const [draft, setDraft] = useState(saved);
  // A note saved elsewhere, such as in the settings file, replaces the draft.
  if (held !== saved) {
    setHeld(saved);
    setDraft(saved);
  }
  const cancelled = useRef(false);
  const noteId = useId();
  const hintId = useId();
  const left = MAX_AGENT_NOTE_LENGTH - draft.length;
  return (
    <div data-testid="agent-note-row" className="flex flex-col gap-2 px-3 py-3">
      <label htmlFor={noteId} className="text-[13px] text-ink">
        Your note
      </label>
      <textarea
        id={noteId}
        data-testid="agent-note"
        data-edit-in-place
        aria-describedby={hintId}
        rows={3}
        maxLength={MAX_AGENT_NOTE_LENGTH}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false;
            setDraft(saved);
            return;
          }
          const note = draft.trim();
          setDraft(note);
          if (note === saved) return;
          props.onChange((current) => {
            const { note: _removed, ...rest } = current;
            return note ? { ...rest, note } : rest;
          });
        }}
        onKeyDown={(event) => {
          if (isComposingKey(event) || event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          event.currentTarget.blur();
        }}
        className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:border-ink"
      />
      <p id={hintId} className="m-0 flex gap-3 text-[12px] text-muted">
        <span className="mr-auto">dohc sends it to the thread with every message.</span>
        {left <= 200 ? <span className="shrink-0">{`${left} left`}</span> : null}
      </p>
    </div>
  );
}

const THREAD_READ_FAILED = "dohc could not read this thread from T3 Code.";

// The thread an agent is connected to, by its title in T3 Code, with the ways
// to open it there and to connect the agent to another one. Main finds the
// thread only from a workspace the agent forwards from, so the page shows the
// row only there. The title is read
// once the page knows T3 Code allows dohc, or could not check. While the page
// says T3 Code does not allow dohc, no title can be read, and the row does not
// say why a second time.
function ThreadRow(props: {
  agent: Agent;
  thread: AgentThread;
  workspaceId: string;
  access: "checking" | "refused" | "usable";
  onError?: PageError | undefined;
  // The dialog may have got dohc allowed in T3 Code.
  onAllowChecked: () => void;
}) {
  const { agent, thread, workspaceId, access } = props;
  const report = useRef(props.onError);
  report.current = props.onError;
  const read = useWorkspaceQuery(useWorkspaceSession(), {
    // A new thread, or dohc allowed again, reads again.
    key: JSON.stringify([agent.id, thread.id, access]),
    manual: access !== "usable",
    load: () => bridge().readAgentThread({ workspaceId, agentId: agent.id }),
  });
  const { error, retry } = read;
  // Main saves a new thread, and its settings reach this window on their own.
  // An answer for another thread than the one the settings here name is not
  // shown, and the thread is read again until the two agree.
  const answered = read.value;
  const current = answered?.threadId === thread.id ? answered : undefined;
  const value = current && "title" in current ? current : undefined;
  useEffect(() => {
    if (answered === undefined || answered.threadId === thread.id) return;
    const timer = setTimeout(() => void retry(), 300);
    return () => clearTimeout(timer);
  }, [answered, thread.id, retry]);
  // Why this thread could not be read: what the tool said of it, or why dohc could not ask.
  const failure =
    error !== null
      ? ipcErrorMessage(error, THREAD_READ_FAILED)
      : current && "problem" in current
        ? current.problem
        : null;
  // A failed read says why once, in Notices, with its Try again.
  useEffect(() => {
    if (failure !== null) report.current?.(failure, error ?? new Error(failure), retry);
  }, [failure, error, retry]);
  const [changing, setChanging] = useState(false);
  // A row that is gone, with its agent or its workspace, reports nothing.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const open = async (): Promise<void> => {
    if (!shown.current) return;
    try {
      await bridge().openAgentThread({ workspaceId, agentId: agent.id });
    } catch (cause) {
      if (!shown.current) return;
      report.current?.(
        ipcErrorMessage(cause, `dohc could not open ${agent.name}'s thread in ${T3_CODE}.`),
        cause,
        open,
      );
    }
  };
  return (
    <>
      <PageRow testId="agent-page-thread" icon={<MessagesSquare size={14} />} label="Thread" wrap>
        {access === "refused" ? null : failure !== null ? (
          <div className="ml-auto min-w-0">
            <RetryRow testId="agent-page-thread-retry" onRetry={() => void retry()}>
              {failure}
            </RetryRow>
          </div>
        ) : (
          <span data-testid="agent-page-thread-title" className={VALUE}>
            {value === undefined ? (
              <LoaderCircle size={12} aria-label="Reading the thread" className="animate-spin" />
            ) : (
              <span className="min-w-0 truncate text-ink" title={value.title}>
                {value.title}
              </span>
            )}
          </span>
        )}
      </PageRow>
      <div className="flex min-h-11 flex-wrap items-center justify-end gap-x-2 gap-y-1 border-b border-line px-3 py-2 text-[12px]">
        {failure === null && value?.closed ? (
          // T3 Code says which of the two only together. dohc still forwards to
          // the thread, so this claims nothing about what the thread then does.
          <p data-testid="agent-page-thread-closed" className="m-0 mr-auto min-w-0 text-muted">
            {`This thread is archived or settled in ${T3_CODE}.`}
          </p>
        ) : null}
        <SecondaryButton
          size="row"
          data-testid="agent-page-thread-open"
          onClick={() => void open()}
        >
          <ExternalLink size={12} aria-hidden />
          {`Open in ${T3_CODE}`}
        </SecondaryButton>
        <SecondaryButton
          size="row"
          data-testid="agent-page-thread-change"
          onClick={() => setChanging(true)}
        >
          Change thread
        </SecondaryButton>
      </div>
      {changing ? (
        <ChangeThreadDialog
          workspaceId={workspaceId}
          agentId={agent.id}
          agentName={agent.name}
          threadId={thread.id}
          otherWorkspaces={(agent.workspaces ?? []).filter((id) => id !== workspaceId).length}
          onClose={() => {
            setChanging(false);
            // The dialog can allow dohc, or allow it again with another mode.
            props.onAllowChecked();
          }}
        />
      ) : null}
    </>
  );
}

// The switch for the workspace the window shows. Main makes both changes and
// saves them. Turning it on asks first. Turning it off asks nothing, because
// the switch turns it on again. It moves at the click and holds still until
// main answers, and then shows what the settings say, so a workspace main
// could not turn off reads as on again.
function WorkspaceSwitch(props: {
  agent: Agent;
  workspaceId: string;
  // The saved settings have this workspace on for the agent.
  serves: boolean;
  onAsk: () => void;
  onError?: PageError | undefined;
}) {
  const { agent, workspaceId } = props;
  const [turningOff, setTurningOff] = useState(false);
  const running = useRef(false);
  // An answer for a switch that is gone, with its agent or its workspace, reports and changes nothing.
  const calls = useRequestSequence();
  const report = useRef(props.onError);
  report.current = props.onError;
  const turnOff = async (): Promise<void> => {
    const token = calls.next();
    running.current = true;
    setTurningOff(true);
    try {
      await bridge().setAgentThreadWorkspace({ workspaceId, agentId: agent.id, on: false });
    } catch (cause) {
      if (!calls.isCurrent(token)) return;
      running.current = false;
      setTurningOff(false);
      report.current?.(
        ipcErrorMessage(
          cause,
          `dohc could not stop forwarding from this workspace to ${agent.name}.`,
        ),
        cause,
        // Try again on a notice this switch has outlived, or a later press replaced, does nothing.
        async () => {
          if (calls.isCurrent(token)) await turnOff();
        },
      );
      return;
    }
    if (!calls.isCurrent(token)) return;
    running.current = false;
    setTurningOff(false);
  };
  const on = props.serves && !turningOff;
  return (
    <SwitchControl
      label={`Forward messages from this workspace to ${agent.name}`}
      tooltip={`${on ? "Turn off" : "Turn on"} for this workspace`}
      description={on ? "Turn off" : "Turn on"}
      checked={on}
      busy={turningOff}
      // Not disabled while it runs, because a disabled switch drops keyboard
      // focus. A press then does nothing.
      onChange={(next) => {
        if (running.current) return;
        if (next) props.onAsk();
        else void turnOff();
      }}
    />
  );
}

// What a person changes about an agent with a thread: whether dohc forwards
// to it, whether it forwards from this workspace, which thread it is, whether
// T3 Code still allows dohc, what a message does while the thread works, and
// the note that goes with each one.
function ThreadAgentBoxes(props: {
  agent: Agent;
  workspaceId: string;
  workspaceName: string;
  onChange: (change: (agent: AgentSettings) => AgentSettings) => void;
  onError?: PageError | undefined;
}) {
  const { agent, onChange } = props;
  const serves = agent.workspaces?.includes(props.workspaceId) ?? false;
  // The ask before this workspace is turned on, for the agent and workspace
  // it was opened on. Another agent or workspace closes it.
  const here = `${props.workspaceId}:${agent.id}`;
  const [asking, setAsking] = useState<string | null>(null);
  if (asking !== null && asking !== here) setAsking(null);
  const report = useRef(props.onError);
  report.current = props.onError;
  const access = useT3CodeAccess((message, cause, retry) =>
    report.current?.(message, cause, retry),
  );
  const { state, readError, retryRead } = access;
  // A failed read says why once, in Notices, with its Try again.
  useEffect(() => {
    if (readError !== null)
      report.current?.(ipcErrorMessage(readError, ACCESS_READ_FAILED), readError, retryRead);
  }, [readError, retryRead]);
  const allowed = state !== undefined && state.canKeep && t3CodeAllowed(state);
  // dohc knows the mode only when the person allowed it here, not on T3 Code's page.
  const mode = state?.access ? t3CodeModeName(state.access) : null;
  const whileBusy = agent.whileBusy ?? "own-chat";
  return (
    <>
      <div data-testid="agent-thread" className={`${BOX} mt-5`}>
        <PageRow icon={<Forward size={14} />} label="Forward messages">
          <span className={VALUE}>
            <SwitchControl
              label={`Forward messages to ${agent.name}`}
              tooltip={`${agent.enabled ? "Turn off" : "Turn on"} ${agent.name}`}
              description={agent.enabled ? "Turn off" : "Turn on"}
              checked={agent.enabled}
              onChange={(enabled) => onChange((current) => ({ ...current, enabled }))}
            />
          </span>
        </PageRow>
        <PageRow
          testId="agent-thread-workspace"
          icon={<Folder size={14} />}
          label={
            <>
              Forward from this workspace
              {serves ? null : (
                <span className="mt-1 block text-[12px] text-muted">
                  Its thread gets no messages from this workspace.
                </span>
              )}
            </>
          }
        >
          <span className={VALUE}>
            {/* Another agent or workspace starts the switch over. */}
            <WorkspaceSwitch
              key={here}
              agent={agent}
              workspaceId={props.workspaceId}
              serves={serves}
              onAsk={() => setAsking(here)}
              onError={props.onError}
            />
          </span>
        </PageRow>
        {asking === here ? (
          <ForwardWorkspaceDialog
            key={here}
            workspaceId={props.workspaceId}
            workspaceName={props.workspaceName}
            agent={agent}
            onClose={() => setAsking(null)}
          />
        ) : null}
        {/* Main finds the thread only from a workspace it has saved for the
            agent, so the row waits for the settings to have it, and for the
            ask to close. */}
        {agent.thread && serves && asking !== here ? (
          // Another agent or workspace starts the row over, which closes its dialog.
          <ThreadRow
            key={`${props.workspaceId}:${agent.id}`}
            agent={agent}
            thread={agent.thread}
            workspaceId={props.workspaceId}
            access={
              state === undefined
                ? readError === null
                  ? "checking"
                  : "usable"
                : allowed
                  ? "usable"
                  : "refused"
            }
            onError={props.onError}
            onAllowChecked={() => void retryRead()}
          />
        ) : null}
        <PageRow icon={<KeyRound size={14} />} label={`dohc in ${T3_CODE}`} wrap>
          {readError !== null ? (
            <div data-testid="agent-thread-access" className="ml-auto min-w-0">
              <RetryRow testId="t3-code-access-retry" onRetry={() => void retryRead()}>
                {ACCESS_READ_FAILED}
              </RetryRow>
            </div>
          ) : (
            <span data-testid="agent-thread-access" className={VALUE}>
              {state === undefined ? (
                <LoaderCircle
                  size={12}
                  aria-label={`Checking ${T3_CODE}`}
                  className="animate-spin"
                />
              ) : allowed ? (
                <span
                  title={`${
                    mode === null
                      ? ""
                      : `dohc can read and message threads running with ${mode} or lower access. `
                  }This sign-in lasts 30 days. Allow dohc again here when it expires.`}
                >
                  {`Allowed ${mode === null ? "" : `with ${mode} `}until ${t3CodeAllowedUntil(state.signedInUntilMs!)}`}
                </span>
              ) : (
                // Why not, or the way to allow it, follows under the row.
                <span className="inline-flex items-center gap-1 text-warning">
                  <TriangleAlert size={12} aria-hidden />
                  Not allowed
                </span>
              )}
            </span>
          )}
        </PageRow>
        {state === undefined ? null : allowed ? (
          <div className="px-3 py-1.5">
            <T3CodeAllowAgain access={access} />
          </div>
        ) : state.canKeep ? (
          <div className="px-3 py-3">
            <T3CodeAllow access={access} size="row" />
          </div>
        ) : (
          <p data-testid="t3-code-cannot-keep" className="m-0 px-3 py-2.5 text-[12px] text-danger">
            {T3_CODE_CANNOT_KEEP}
          </p>
        )}
      </div>

      <h4 className={SECTION}>Messages</h4>
      <div data-testid="agent-thread-messages" className={BOX}>
        <PageRow
          wrap
          label={
            <>
              While it works
              {whileBusy === "line" ? null : (
                <span className="mt-1 block text-[12px] text-muted">
                  {whileBusy === "steer"
                    ? "Only your own messages go right away. Other people's wait in line."
                    : "Your messages in its own chat go right away. Messages elsewhere wait in line."}
                </span>
              )}
            </>
          }
        >
          <span className="ml-auto shrink-0 [&_button]:whitespace-nowrap">
            <SegmentedControl
              label="While it works"
              testId="agent-while-busy"
              value={whileBusy}
              options={WHILE_BUSY}
              onChange={(next) => onChange((current) => ({ ...current, whileBusy: next }))}
            />
          </span>
        </PageRow>
        <AgentNote agent={agent} onChange={onChange} />
      </div>
    </>
  );
}

/**
 * One agent's page in Settings › Agents: who it is, then what a person
 * changes about it. An agent dohc starts has its switch, its check, what it
 * can do and how dohc starts it. An agent with a thread has the switch that
 * forwards to it, the switch for this workspace, whether its tool allows dohc,
 * and what goes with a message.
 * An agent you run has its MCP config and the run that marks this workspace's
 * changes as its own. Each change saves at once.
 */
export function AgentPage(props: {
  agent: Agent;
  agents: DesktopUserSettings["agents"];
  workspaceId: string;
  // What the open workspace goes by.
  workspaceName: string;
  tools: AgentToolsResult | null;
  // For an agent you run: its MCP config, or null when this workspace has none.
  mcpConfig: string | null;
  // Why this workspace has no MCP config, when it says.
  mcpUnavailable: string | null;
  listening: boolean;
  paused: boolean;
  checking: boolean;
  check: CheckState | undefined;
  canCheck: boolean;
  // Why Send test can't start, shown on hover.
  checkReason: string | null;
  // The same reason under the box, unless something else on screen says it.
  checkNote: string | null;
  // The name a run's agent goes by, for a run that belongs to another agent.
  agentName: (agentId: string) => string;
  run?: AgentRunControl | undefined;
  // The rename field, shown in place of the name.
  nameField: ReactNode | null;
  // The chip that says automations wake this agent.
  automationChip: ReactNode;
  // Absent on the agent automations already wake, and on one dohc cannot start.
  onUseForAutomations?: () => void;
  onRename: () => void;
  onRemove: () => void;
  onCheck: () => void;
  onChange: (change: (agent: AgentSettings) => AgentSettings) => void;
  // A failure on the page that the workspace's Notices keep.
  onError?: PageError;
  onBack: () => void;
  backRef?: React.Ref<HTMLButtonElement>;
}) {
  const { agent, onChange } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<"timeout" | "command" | null>(null);
  const [confirmShell, setConfirmShell] = useState(false);
  const runLabelId = useId();
  const launched = agent.launch !== undefined;
  // dohc forwards to this agent's own thread and never starts it.
  const forwarded = agent.thread !== undefined;
  const profile = agent.launch ? launchProfile(agent.launch) : undefined;
  // The person's own command, or a tool's program with their own flags.
  const command =
    agent.launch && (!profile || (profile.arguments?.length ?? 0) > 0)
      ? launchCommand(agent.launch)
      : null;
  const tool = profile ? AGENT_TOOLS.find((entry) => entry.id === profile.tool)! : null;
  const handle = agentHandle(agent.name);
  const saveCommand = (value: string) => {
    const next = launchFromCommand(value, profile);
    if (next && value.trim() !== (agent.launch ? launchCommand(agent.launch) : "")) {
      onChange((current) => ({ ...current, launch: next }));
    }
  };
  const subtitle = [
    handle ? `@${handle}` : null,
    forwarded
      ? `Thread in ${T3_CODE}`
      : !agent.launch
        ? null
        : profile
          ? toolLine(profile.tool, props.tools)
          : "Your command",
  ].filter((part): part is string => part !== null);
  const activeRun = props.run?.activeRun ?? null;
  const ownRun = activeRun?.agentId === agent.id;

  return (
    <section data-testid="agent-page" data-agent-id={agent.id} aria-label={agent.name}>
      <button
        ref={props.backRef}
        type="button"
        data-testid="agent-back"
        onClick={props.onBack}
        className="-ml-1 mb-4 inline-flex items-center gap-1 rounded px-1 text-[13px] text-muted hover:text-ink"
      >
        <ChevronLeft size={14} aria-hidden />
        Agents
      </button>
      <div className="flex items-center gap-3">
        <ChatAvatar
          name={agent.name}
          kind="agent"
          presentation={{ group: "", hue: agent.hue === "olive" ? null : agent.hue, self: false }}
          size="post"
          className={(launched || forwarded) && !agent.enabled ? "opacity-50" : undefined}
        />
        <div className="min-w-0 flex-1">
          {props.nameField ?? (
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                title="Rename"
                aria-label={`Rename ${agent.name}`}
                onClick={props.onRename}
                className="min-w-0 truncate rounded text-left text-[15px] font-semibold text-ink"
              >
                {agent.name}
              </button>
              {props.automationChip}
            </div>
          )}
          {props.nameField ? null : (
            <p
              data-testid="agent-page-subtitle"
              className="m-0 mt-0.5 flex flex-wrap items-center gap-1 text-[12px] text-muted"
            >
              {subtitle.map((part, index) => (
                <span key={part} className="inline-flex items-center gap-1">
                  {index > 0 ? (
                    <span aria-hidden className="text-subtle">
                      ·
                    </span>
                  ) : null}
                  {index === 0 && handle ? <span className="font-mono">{part}</span> : part}
                </span>
              ))}
              {!launched && !forwarded ? (
                <>
                  {subtitle.length > 0 ? (
                    <span aria-hidden className="text-subtle">
                      ·
                    </span>
                  ) : null}
                  <span>Through MCP</span>
                </>
              ) : null}
            </p>
          )}
        </div>
        <Menu
          label={`${agent.name} actions`}
          testId="agent-menu"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          width={200}
          items={[
            ...(props.onUseForAutomations
              ? [
                  {
                    id: "automations",
                    label: "Use for automations",
                    icon: <Workflow size={14} aria-hidden />,
                    onSelect: props.onUseForAutomations,
                  },
                ]
              : []),
            {
              id: "rename",
              label: "Rename",
              icon: <Pencil size={14} aria-hidden />,
              onSelect: props.onRename,
            },
          ]}
        />
      </div>

      {forwarded ? (
        <ThreadAgentBoxes
          agent={agent}
          workspaceId={props.workspaceId}
          workspaceName={props.workspaceName}
          onChange={onChange}
          onError={props.onError}
        />
      ) : launched ? (
        <>
          <div className={`${BOX} mt-5`}>
            <PageRow icon={<Monitor size={14} />} label="Run on this computer">
              <span className={VALUE}>
                {props.paused && agent.enabled ? (
                  <span className="inline-flex items-center gap-1">
                    <Pause size={12} aria-hidden />
                    Paused
                  </span>
                ) : null}
                <SwitchControl
                  label={`Run ${agent.name} on this computer`}
                  tooltip={`${agent.enabled ? "Turn off" : "Turn on"} ${agent.name}`}
                  description={agent.enabled ? "Turn off" : "Turn on"}
                  checked={agent.enabled}
                  onChange={(enabled) => onChange((current) => ({ ...current, enabled }))}
                />
              </span>
            </PageRow>
            <PageRow icon={<Send size={14} />} label="Test">
              <span data-testid="agent-check-state" className={VALUE}>
                {checkStatus({ checking: props.checking, check: props.check })}
                <SecondaryButton
                  data-testid="agent-check"
                  size="row"
                  disabled={!props.canCheck}
                  title={props.checkReason ?? undefined}
                  onClick={props.onCheck}
                >
                  {props.check?.status === "failed" && !props.checking ? "Try again" : "Send test"}
                </SecondaryButton>
              </span>
            </PageRow>
          </div>
          {props.checkNote ? (
            <p data-testid="agents-check-note" className="m-0 mt-2 text-[12px] text-muted">
              {props.checkNote}
            </p>
          ) : null}

          <h4 className={SECTION}>What it can do</h4>
          <div data-testid="agent-can" className={BOX}>
            <PageRow icon={<MessageSquare size={14} />} label="Chats">
              <span className={VALUE}>
                {handle ? (
                  <>
                    Replies when you mention <span className="font-mono text-ink">@{handle}</span>
                  </>
                ) : (
                  "Its name has no @handle"
                )}
              </span>
            </PageRow>
            {tool ? (
              <>
                <PageRow icon={<FilePenLine size={14} />} label="Workspace files">
                  <span className={VALUE} title={tool.permissions}>
                    Edits without asking
                  </span>
                </PageRow>
                {tool.id === "claude" ? (
                  <PageRow icon={<SquareTerminal size={14} />} label="Commands">
                    <span className={VALUE}>
                      <SwitchControl
                        label={`Let ${agent.name} run any command`}
                        tooltip={
                          agent.allowShell
                            ? "Runs any command without asking"
                            : "Runs only the commands your Claude settings allow"
                        }
                        checked={agent.allowShell === true}
                        onChange={(on) =>
                          on
                            ? setConfirmShell(true)
                            : onChange(({ allowShell: _off, ...current }) => current)
                        }
                      />
                    </span>
                  </PageRow>
                ) : null}
                <PageRow icon={<Workflow size={14} />} label="When an automation wakes it">
                  <span className={VALUE}>Replies only</span>
                </PageRow>
              </>
            ) : null}
            <PageRow icon={<Clock size={14} />} label="Stops after">
              <span className={VALUE}>
                {editing === "timeout" ? (
                  <>
                    <InlineField
                      label={`Minutes before ${agent.name} stops`}
                      initial={String(agent.timeoutMinutes)}
                      numeric
                      className="w-16 text-right"
                      after={<span className="text-muted">min</span>}
                      problem={(value) =>
                        validMinutes(value)
                          ? null
                          : `Enter whole minutes from ${MIN_TIMEOUT} to ${MAX_TIMEOUT}.`
                      }
                      onDone={() => setEditing(null)}
                      onCommit={(value) => {
                        const minutes = Number(value);
                        if (minutes !== agent.timeoutMinutes)
                          onChange((current) => ({ ...current, timeoutMinutes: minutes }));
                      }}
                    />
                  </>
                ) : (
                  <>
                    <span className="text-ink">{agent.timeoutMinutes} min</span>
                    <button
                      type="button"
                      className={LINK}
                      aria-label={`Change when ${agent.name} stops`}
                      onClick={() => setEditing("timeout")}
                    >
                      Change
                    </button>
                  </>
                )}
              </span>
            </PageRow>
          </div>
          {confirmShell ? (
            <ConfirmDialog
              title={`Let ${agent.name} run any command?`}
              icon={SquareTerminal}
              confirmLabel="Allow commands"
              onCancel={() => setConfirmShell(false)}
              onConfirm={() => {
                setConfirmShell(false);
                onChange((current) => ({ ...current, allowShell: true }));
              }}
              testId="allow-shell-dialog"
              cancelTestId="allow-shell-cancel"
              confirmTestId="allow-shell-confirm"
            >
              <p>
                It runs them without asking, with your access to this computer. What it reads in
                chats and files can steer them, and dohc cannot undo them.
              </p>
            </ConfirmDialog>
          ) : null}
        </>
      ) : (
        <>
          <h4 className={SECTION}>Connect</h4>
          <div data-testid="agent-connect" className={BOX}>
            <PageRow label="Paste this into your agent's MCP settings">
              <span className={VALUE}>
                <CopyButton
                  key={props.workspaceId}
                  label="Copy MCP config"
                  size="button"
                  testId="mcp-config-copy"
                  disabled={props.mcpConfig === null}
                  getText={() => props.mcpConfig}
                />
              </span>
            </PageRow>
            {props.mcpConfig !== null ? (
              <pre
                data-testid="mcp-config"
                className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink"
              >
                {props.mcpConfig}
              </pre>
            ) : props.mcpUnavailable ? (
              <p data-testid="mcp-unavailable" className="m-0 px-3 py-2.5 text-[12px] text-danger">
                {props.mcpUnavailable}
              </p>
            ) : null}
          </div>
          {props.mcpConfig !== null ? (
            <p data-testid="agent-mcp-note" className="m-0 mt-2 text-[12px] text-muted">
              For local apps on this computer such as Claude Desktop or Cursor. Save the app's MCP
              config file, then restart the app.
            </p>
          ) : null}
          {props.run ? (
            <>
              <h4 className={SECTION}>History</h4>
              <div className={BOX}>
                <PageRow
                  icon={<History size={14} />}
                  label={`Mark changes as ${agent.name}'s`}
                  labelId={runLabelId}
                >
                  <span className={VALUE}>
                    <span
                      data-testid="mcp-status"
                      data-state={activeRun === null ? "stopped" : ownRun ? "running" : "other"}
                    >
                      {activeRun === null
                        ? "Stopped"
                        : ownRun
                          ? "Running"
                          : `Running as ${props.agentName(activeRun.agentId)}`}
                    </span>
                    <SecondaryButton
                      data-testid="mcp-enable-toggle"
                      size="row"
                      aria-describedby={runLabelId}
                      disabled={props.run.busy}
                      onClick={() => props.run?.onToggle(agent.id)}
                    >
                      {activeRun ? "Stop run" : "Start run"}
                    </SecondaryButton>
                  </span>
                </PageRow>
              </div>
              <p className="m-0 mt-2 text-[12px] text-muted">
                {`MCP edits (and CLI commands with --agent-id) already show as ${agent.name}'s. Start a run to also mark direct file edits in this workspace.`}
              </p>
            </>
          ) : null}
        </>
      )}

      <h4 className={SECTION}>Details</h4>
      <div data-testid="agent-details" className={BOX}>
        <PageRow label="Color" wrap>
          <span className="ml-auto">
            <HueControl
              label={`Color of ${agent.name}`}
              shape="agent"
              value={agent.hue}
              onChange={(hue) => onChange((current) => ({ ...current, hue }))}
            />
          </span>
        </PageRow>
        {profile ? (
          <>
            <PageRow label="Tool">
              <span className={VALUE}>{toolLine(profile.tool, props.tools)}</span>
            </PageRow>
            {command === null ? (
              <PageRow label="Program">
                <span className={`${VALUE} break-all`}>{profile.executable}</span>
              </PageRow>
            ) : null}
          </>
        ) : null}
        {agent.launch ? (
          <PageRow label="Command" wrap={editing === "command"}>
            <span className={`${VALUE} ${editing === "command" ? "w-full" : ""}`}>
              {editing === "command" ? (
                <InlineField
                  label={`Command that starts ${agent.name}`}
                  initial={launchCommand(agent.launch)}
                  className="w-full font-mono"
                  hint={(draft) => launchCommandHint(launchFromCommand(draft, profile))}
                  onDone={() => setEditing(null)}
                  onCommit={saveCommand}
                />
              ) : command !== null ? (
                <>
                  <code className="min-w-0 truncate font-mono text-ink" title={command}>
                    {command}
                  </code>
                  <button
                    type="button"
                    className={LINK}
                    aria-label={`Change the command that starts ${agent.name}`}
                    onClick={() => setEditing("command")}
                  >
                    Change
                  </button>
                </>
              ) : (
                <button type="button" className={LINK} onClick={() => setEditing("command")}>
                  Use your own command
                </button>
              )}
            </span>
          </PageRow>
        ) : forwarded ? null : (
          <PageRow label="Reaches">
            <span className={VALUE}>This workspace (copy the config in each workspace)</span>
          </PageRow>
        )}
      </div>

      <div className={`${BOX} mt-5`}>
        <PageRow icon={<Trash2 size={14} />} label="Remove agent">
          <span className={VALUE}>
            <SecondaryButton
              data-testid="agent-remove"
              size="row"
              className="text-danger"
              aria-label={`Remove ${agent.name}…`}
              onClick={props.onRemove}
            >
              Remove…
            </SecondaryButton>
          </span>
        </PageRow>
      </div>
    </section>
  );
}
