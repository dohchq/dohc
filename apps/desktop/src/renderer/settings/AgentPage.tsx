import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  CircleAlert,
  Clock,
  FilePenLine,
  Forward,
  History,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Pause,
  Pencil,
  Send,
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
  type DesktopUserSettings,
} from "../../settings/userSettings";
import { ipcErrorMessage } from "../ipcError";
import { CopyButton } from "../ui/CopyButton";
import { RetryRow, SecondaryButton } from "../ui/controls";
import { isComposingKey } from "../ui/keys";
import { Menu } from "../ui/Menu";
import { SegmentedControl } from "../ui/SegmentedControl";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { HueControl, SwitchControl } from "./SettingRow";
import {
  T3_CODE,
  T3_CODE_CANNOT_KEEP,
  T3CodeAllow,
  T3CodeAllowAgain,
  t3CodeAllowed,
  t3CodeAllowedUntil,
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
      Checking
    </span>
  ) : props.check?.status === "replied" ? (
    <span className="inline-flex items-center gap-1 text-success">
      <Check size={12} aria-hidden />
      {`Replied in ${props.check.seconds} s`}
    </span>
  ) : props.check?.status === "failed" ? (
    <span className="inline-flex items-center gap-1 text-danger">
      <CircleAlert size={12} aria-hidden />
      Didn't reply.
    </span>
  ) : (
    <span className="text-muted">Not checked</span>
  );
}

type PageError = (message: string, cause?: unknown, retry?: () => Promise<void>) => void;

const WHILE_BUSY = [
  { value: "line", label: "Wait in line" },
  { value: "steer", label: "Forward right away" },
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

// What a person changes about an agent with a thread: whether dohc forwards
// to it, whether T3 Code still allows dohc, what a message does while the
// thread works, and the note that goes with each one.
function ThreadAgentBoxes(props: {
  agent: Agent;
  onChange: (change: (agent: AgentSettings) => AgentSettings) => void;
  onError?: PageError | undefined;
}) {
  const { agent, onChange } = props;
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
  const whileBusy = agent.whileBusy ?? "line";
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
                <span title="The sign-in lasts 30 days. After that, allow dohc again here.">
                  {`Allowed until ${t3CodeAllowedUntil(state.signedInUntilMs!)}`}
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
              {whileBusy === "steer" ? (
                <span className="mt-1 block text-[12px] text-muted">
                  Only your own messages go right away. Other people's wait in line.
                </span>
              ) : null}
            </>
          }
        >
          <span className="ml-auto shrink-0">
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
 * forwards to it, whether its tool allows dohc, and what goes with a message.
 * An agent you run has its MCP config and the run that marks this workspace's
 * changes as its own. Each change saves at once.
 */
export function AgentPage(props: {
  agent: Agent;
  agents: DesktopUserSettings["agents"];
  workspaceId: string;
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
        <ThreadAgentBoxes agent={agent} onChange={onChange} onError={props.onError} />
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
                {`While a run is on, History shows changes in this workspace as ${agent.name}'s.`}
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
        ) : forwarded ? (
          <PageRow label="Forwards from">
            <span data-testid="agent-thread-workspace" className={VALUE}>
              {agent.workspaces?.includes(props.workspaceId)
                ? "This workspace"
                : "Another workspace"}
            </span>
          </PageRow>
        ) : (
          <PageRow label="Reaches">
            <span className={VALUE}>Every workspace dohc opens on this computer</span>
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
