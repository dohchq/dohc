import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, FilePenLine, ListCollapse, LoaderCircle, Pause, Pencil, Play, Plug, TriangleAlert } from "lucide-react";
import { MAX_PREFERRED_NAME_LENGTH, preferredNameFromInput } from "@dohc/workspace-contracts/chat-identity-values";
import type { AgentToolsResult } from "../../agents/agentToolCatalog";
import type { ActorPresentation, McpConfigResult } from "../../ipc/bridgeContract";
import { withErrorWords } from "../../ipc/errorWords";
import {
  agentNameTaken,
  listAgents,
  withAgent,
  type Agent,
  type AgentProblem,
  type AgentSettings,
  type DesktopUserSettings,
} from "../../settings/userSettings";
import type { AgentHue } from "../tokens";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { CopyButton } from "../ui/CopyButton";
import { SecondaryButton } from "../ui/controls";
import { isComposingKey } from "../ui/keys";
import { Menu } from "../ui/Menu";
import { useChatDispatchPaused } from "../useChatDispatchPaused";
import { useRequestSequence } from "../useRequestSequence";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { AgentDetails } from "./AgentDetails";
import { SwitchControl } from "./SettingRow";

export type AgentListRow =
  | { kind: "agent"; agent: Agent }
  | { kind: "broken"; problem: AgentProblem };

/** Your agents and the entries dohc could not use, in the order the file lists them. */
export function agentListRows(settings: Pick<DesktopUserSettings, "agents">, problems: readonly AgentProblem[] = []): AgentListRow[] {
  const agents = listAgents(settings);
  const rows: AgentListRow[] = [];
  let next = 0;
  for (const problem of [...problems].sort((left, right) => left.position - right.position)) {
    while (rows.length < problem.position && next < agents.length) rows.push({ kind: "agent", agent: agents[next++]! });
    rows.push({ kind: "broken", problem });
  }
  return [...rows, ...agents.slice(next).map((agent) => ({ kind: "agent" as const, agent }))];
}

/** A problem sentence, with each key in backticks set in monospace. */
export function ProblemText(props: { text: string }) {
  return <>{props.text.split("`").map((part, index) =>
    index % 2 === 1 ? <code key={index} className="font-mono">{part}</code> : part)}</>;
}

// Why Check cannot run in this session, or null when it can. A session
// without a recorder can only refuse a check until dohc restarts.
export function runnerEngineNote(sharedView: boolean, sessionRecorderOn: boolean | undefined): string | null {
  if (sharedView) return "This workspace is a shared view. dohc records nothing here, so there is no chat to test.";
  return sessionRecorderOn === false
    ? "The workspace engine starts when dohc starts. Restart dohc to check an agent."
    : null;
}

function configSnippet(config: Extract<McpConfigResult, { command: string }>): string {
  return JSON.stringify({ mcpServers: { dohc: { command: config.command, args: config.args } } }, null, 2);
}

function presentationFor(hue: AgentHue | undefined): ActorPresentation {
  return { group: "", hue: hue === undefined || hue === "olive" ? null : hue, self: false };
}

type CheckState = { status: "replied"; seconds: number } | { status: "failed" };

const ROW = "border-b border-line last:border-b-0";
const ROW_LINE = "flex items-center gap-3 py-4";
const STATE = "m-0 mt-1 flex items-center gap-1 text-[12px]";
const ROW_BUTTON = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-hover disabled:cursor-default disabled:text-subtle disabled:hover:bg-bg";
// Holds the place of a control the row does not have, so every row's controls line up.
const switchSpace = <span aria-hidden className="h-5 w-9 shrink-0" />;
const menuSpace = <span aria-hidden className="size-6 shrink-0" />;

function AgentNameField(props: {
  agent: Agent;
  agents: DesktopUserSettings["agents"];
  onSave: (name: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(props.agent.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  // Escape leaves the name as it was, so the blur that follows saves nothing.
  const cancelled = useRef(false);
  useEffect(() => input.current?.select(), []);
  const problem = (value: string): string | null => {
    try {
      const name = preferredNameFromInput(value);
      if (!name) return "Enter an agent name.";
      return agentNameTaken(props.agents, props.agent.id, name) ? "Another agent has this name." : null;
    } catch (cause) {
      return ipcErrorMessage(cause, "This name can't be used.");
    }
  };
  const save = async () => {
    if (cancelled.current) return;
    const found = problem(draft);
    setError(found);
    if (found) return;
    const name = draft.trim();
    if (name === props.agent.name) return props.onDone();
    setSaving(true);
    // A save that fails says why in Notices and keeps the field open.
    const saved = await props.onSave(name);
    setSaving(false);
    if (saved) props.onDone();
  };
  return <>
    <input
      ref={input}
      aria-label={`Name of ${props.agent.name}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `agent-name-error-${props.agent.id}` : undefined}
      data-testid="agent-name-input"
      value={draft}
      maxLength={MAX_PREFERRED_NAME_LENGTH}
      disabled={saving}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => {
        const value = event.currentTarget.value;
        setDraft(value);
        // Says at once when the name is taken, and clears once it is not.
        setError(problem(value) === "Another agent has this name." ? "Another agent has this name." : null);
      }}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (isComposingKey(event)) return;
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          props.onDone();
        }
      }}
      className={`h-8 w-56 max-w-full rounded-md border bg-bg px-2.5 text-[13px] font-medium text-ink ${error ? "border-danger" : "border-line focus:border-ink"}`}
    />
    {error ? (
      <p id={`agent-name-error-${props.agent.id}`} role="alert" className={`${STATE} mt-1.5 text-danger`}>
        <CircleAlert size={12} aria-hidden />{error}
      </p>
    ) : null}
  </>;
}

function AgentRow(props: {
  agent: Agent;
  agents: DesktopUserSettings["agents"];
  paused: boolean;
  checking: boolean;
  check: CheckState | undefined;
  canCheck: boolean;
  checkNote: string | null;
  tools: AgentToolsResult | null;
  onCheck: () => void;
  onRename: (name: string) => Promise<boolean>;
  onChange: (change: (agent: AgentSettings) => AgentSettings) => void;
}) {
  const { agent } = props;
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const launched = agent.launch !== undefined;
  const state = !launched ? (
    <p className={`${STATE} text-muted`}><Plug size={12} aria-hidden />Through MCP</p>
  ) : props.checking ? (
    <p className={`${STATE} text-muted`}><LoaderCircle size={12} aria-hidden className="animate-spin" />Checking</p>
  ) : props.paused ? (
    <p className={`${STATE} text-muted`}><Pause size={12} aria-hidden />Paused</p>
  ) : props.check?.status === "replied" ? (
    <p className={`${STATE} text-success`}><Check size={12} aria-hidden />Replied in {props.check.seconds} s</p>
  ) : props.check?.status === "failed" ? (
    <p className={`${STATE} text-danger`}><CircleAlert size={12} aria-hidden />Didn't reply.</p>
  ) : null;
  return (
    <div data-testid="agent-row" data-agent-id={agent.id} className={ROW}>
      <div className={ROW_LINE}>
        <ChatAvatar name={agent.name} kind="agent" presentation={presentationFor(agent.hue)} size="comment" />
        <div className="min-w-0 flex-1">
          {editing ? (
            <AgentNameField agent={agent} agents={props.agents} onSave={props.onRename} onDone={() => setEditing(false)} />
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                title="Rename"
                aria-label={`Rename ${agent.name}`}
                onClick={() => setEditing(true)}
                className="min-w-0 truncate rounded text-left text-[13px] font-medium text-ink"
              >
                {agent.name}
              </button>
            </div>
          )}
          {editing ? null : state}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {launched ? (
            <button
              type="button"
              data-testid="agent-check"
              disabled={!props.canCheck}
              title={props.checkNote ?? undefined}
              onClick={props.onCheck}
              className={ROW_BUTTON}
            >
              {props.check?.status === "failed" && !props.checking ? "Try again" : "Check"}
            </button>
          ) : null}
          {launched ? (
            <SwitchControl label={`Turn on ${agent.name}`} checked={agent.enabled}
              onChange={(enabled) => props.onChange((current) => ({ ...current, enabled }))} />
          ) : switchSpace}
          <Menu
            label={`${agent.name} actions`}
            testId="agent-menu"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={[
              { id: "rename", label: "Rename", icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(true) },
              { id: "details", label: detailsOpen ? "Hide details" : "Details", icon: <ListCollapse size={14} aria-hidden />, onSelect: () => setDetailsOpen((open) => !open) },
            ]}
          />
        </div>
      </div>
      {detailsOpen ? (
        <AgentDetails agent={agent} tools={props.tools} onChange={props.onChange} onClose={() => setDetailsOpen(false)} />
      ) : null}
    </div>
  );
}

function BrokenAgentRow(props: { problem: AgentProblem; onOpenSettingsFile: () => void }) {
  const { problem } = props;
  const name = problem.name ?? problem.id;
  return (
    <div data-testid="agent-row-broken" data-agent-id={problem.id} className={`${ROW} ${ROW_LINE}`}>
      <ChatAvatar name={name} kind="agent" presentation={presentationFor(problem.hue)} size="comment" />
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-[13px] font-medium text-ink">{name}</p>
        <p data-testid="agent-problem" className={`${STATE} text-warning`}>
          <TriangleAlert size={12} aria-hidden className="shrink-0" />
          <span className="min-w-0"><ProblemText text={problem.problem} /></span>
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button type="button" onClick={props.onOpenSettingsFile} className={ROW_BUTTON}>
          <FilePenLine size={14} aria-hidden />Open settings file
        </button>
        <SwitchControl label={`Turn on ${name}`} checked={false} disabled onChange={() => undefined} />
        {menuSpace}
      </div>
    </div>
  );
}

/**
 * Settings › Agents: every agent in the order the file lists them, each with
 * its state and its controls, and the entries dohc could not use in their
 * place. Pause all holds every agent on this computer until Resume or quit.
 */
export function AgentList(props: {
  workspaceId: string;
  settings: DesktopUserSettings;
  agentProblems?: readonly AgentProblem[];
  config: McpConfigResult | null;
  sharedView?: boolean;
  sessionRecorderOn: boolean | undefined;
  // Answers whether the settings saved; a failed save says why in Notices.
  onSave: (settings: DesktopUserSettings) => Promise<boolean>;
  onOpenSettingsFile: () => void;
  onError?: (message: string, cause?: unknown) => void;
}) {
  const { workspaceId, settings, onSave, onError } = props;
  const paused = useChatDispatchPaused((cause) =>
    onError?.(withErrorWords("dohc could not read whether agent dispatch is paused.", cause), cause));
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  // A check's answer belongs to the workspace that asked for it.
  const requests = useRequestSequence([workspaceId]);
  useEffect(() => {
    setChecking(null);
    setChecks({});
  }, [workspaceId]);
  // The tools installed on this computer, for each agent's details.
  const [tools, setTools] = useState<AgentToolsResult | null>(null);
  const toolRequests = useRequestSequence([workspaceId]);
  const reportError = useRef(onError);
  reportError.current = onError;
  useEffect(() => {
    const token = toolRequests.next();
    setTools(null);
    void bridge().detectAgentTools({ workspaceId }).then((found) => {
      if (toolRequests.isCurrent(token)) setTools(found);
    }, (cause: unknown) => {
      if (toolRequests.isCurrent(token)) reportError.current?.(ipcErrorMessage(cause, "dohc could not detect agent tools. Try again."), cause);
    });
  }, [toolRequests, workspaceId]);

  const rows = agentListRows(settings, props.agentProblems);
  const anyLaunch = rows.some((row) => row.kind === "agent" && row.agent.launch !== undefined);
  const checkNote = runnerEngineNote(Boolean(props.sharedView), props.sessionRecorderOn);
  const config = props.config;

  const check = useCallback(async (agent: Agent) => {
    const token = requests.current();
    setChecking(agent.id);
    const started = performance.now();
    let next: CheckState;
    try {
      const result = await bridge().runnerSelfTest({ workspaceId, agentId: agent.id });
      if (!requests.isCurrent(token)) return;
      if (!result.ok) onError?.(result.detail);
      next = result.ok
        ? { status: "replied", seconds: Math.max(1, Math.round((performance.now() - started) / 1000)) }
        : { status: "failed" };
    } catch (cause) {
      if (!requests.isCurrent(token)) return;
      onError?.(ipcErrorMessage(cause, "dohc could not check this agent."), cause);
      next = { status: "failed" };
    }
    setChecks((current) => ({ ...current, [agent.id]: next }));
    setChecking(null);
  }, [onError, requests, workspaceId]);

  const setPaused = (next: boolean) => {
    void bridge().setChatDispatchPaused({ paused: next }).catch((cause: unknown) => onError?.(
      withErrorWords(next ? "dohc could not pause agent dispatch." : "dohc could not resume agent dispatch.", cause),
      cause,
    ));
  };

  return (
    <section data-testid="agent-list" aria-labelledby="agents-title">
      <div className="mb-6 flex min-h-8 items-center gap-2">
        <h3 id="agents-title" className="m-0 mr-auto text-sm font-semibold text-ink">Agents</h3>
        <CopyButton
          key={workspaceId}
          label="Copy MCP config"
          size="header"
          testId="mcp-config-copy"
          disabled={!config || "unavailable" in config}
          getText={() => (config && !("unavailable" in config) ? configSnippet(config) : null)}
        />
        {anyLaunch ? (
          <SecondaryButton
            size="compact"
            data-testid="agents-pause"
            onClick={() => setPaused(!paused)}
            className="inline-flex items-center gap-1"
          >
            {paused ? <Play size={12} aria-hidden /> : <Pause size={12} aria-hidden />}
            {paused ? "Resume" : "Pause all"}
          </SecondaryButton>
        ) : null}
      </div>
      {paused && anyLaunch ? (
        <p data-testid="agents-paused" className="-mt-4 mb-6 flex items-center gap-1.5 text-[12px] text-muted">
          <Pause size={13} aria-hidden />Paused until you resume or quit dohc.
        </p>
      ) : null}
      {config && "unavailable" in config ? (
        <p data-testid="mcp-unavailable" className="-mt-4 mb-6 text-[12px] text-danger">{config.message}</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="rounded-lg border border-line bg-panel px-4">
          {rows.map((row) => row.kind === "broken" ? (
            <BrokenAgentRow key={`broken:${row.problem.id}`} problem={row.problem} onOpenSettingsFile={props.onOpenSettingsFile} />
          ) : (
            <AgentRow
              key={row.agent.id}
              agent={row.agent}
              agents={settings.agents}
              paused={paused}
              checking={checking === row.agent.id}
              check={checks[row.agent.id]}
              // One check at a time: main runs one runner per workspace.
              canCheck={!paused && checking === null && checkNote === null}
              checkNote={checkNote}
              tools={tools}
              onCheck={() => void check(row.agent)}
              onRename={(name) => onSave(withAgent(settings, row.agent.id, (agent) => ({ ...agent, name })))}
              onChange={(change) => void onSave(withAgent(settings, row.agent.id, change))}
            />
          ))}
        </div>
      ) : null}
      {checkNote ? (
        <p data-testid="agents-check-note" className="m-0 mt-2 text-[12px] text-muted">{checkNote}</p>
      ) : null}
    </section>
  );
}
