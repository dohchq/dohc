import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, FilePenLine, ListCollapse, LoaderCircle, Monitor, Pause, Pencil, Play, Plug, Plus, Trash2, TriangleAlert, Workflow } from "lucide-react";
import { MAX_PREFERRED_NAME_LENGTH, preferredNameFromInput } from "@dohc/workspace-contracts/chat-identity-values";
import { AGENT_TOOLS, supportsAgentProfile, type AgentToolsResult } from "../../agents/agentToolCatalog";
import type { ActorPresentation, McpConfigResult } from "../../ipc/bridgeContract";
import { withErrorWords } from "../../ipc/errorWords";
import {
  agentNameTaken,
  automationAgent,
  listAgents,
  newAgentDefaults,
  newAgentId,
  newAgentName,
  withAgent,
  type Agent,
  type AgentProblem,
  type AgentSettings,
  type DesktopUserSettings,
  type DesktopUserSettingsResult,
} from "../../settings/userSettings";
import type { AgentHue } from "../tokens";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import type { ErrorDetailField } from "../shell/copyDetails";
import { CopyButton } from "../ui/CopyButton";
import { SecondaryButton } from "../ui/controls";
import { isComposingKey } from "../ui/keys";
import { Menu, MENU_SEPARATOR } from "../ui/Menu";
import { useChatDispatchPaused } from "../useChatDispatchPaused";
import { useRequestSequence } from "../useRequestSequence";
import { ownPresentation } from "../workbench/actorPresentation";
import { ChatAvatar, useAgentInk } from "../workbench/ChatAvatar";
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
const TILE_LINE = "mt-0.5 flex items-center gap-1 text-[12px]";
const BUTTON_ICON = "inline-flex shrink-0 items-center gap-1.5";
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

// The agent automations wake, in its hue on a 14% tint.
function AutomationChip(props: { hue: AgentHue | undefined }) {
  const ink = useAgentInk(presentationFor(props.hue));
  return (
    <span data-testid="agent-for-automations" className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-current/14 pl-[5px] pr-[7px] text-[11px] font-medium ${ink}`}>
      <Workflow size={12} aria-hidden />For automations
    </span>
  );
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
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  forAutomations: boolean;
  // Absent on the agent automations already wake, and on one dohc cannot start.
  onUseForAutomations?: () => void;
  onRemove: () => void;
  onCheck: () => void;
  onRename: (name: string) => Promise<boolean>;
  onChange: (change: (agent: AgentSettings) => AgentSettings) => void;
}) {
  const { agent, editing, onEditingChange: setEditing } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const launched = agent.launch !== undefined;
  const state = !launched ? (
    <p className={`${STATE} text-muted`}><Plug size={12} aria-hidden />Through MCP</p>
  ) : props.checking ? (
    <p className={`${STATE} text-muted`}><LoaderCircle size={12} aria-hidden className="animate-spin" />Checking</p>
  ) : props.paused && agent.enabled ? (
    <p className={`${STATE} text-muted`}><Pause size={12} aria-hidden />Paused</p>
  ) : props.check?.status === "replied" ? (
    <p className={`${STATE} text-success`}><Check size={12} aria-hidden />Replied in {props.check.seconds} s</p>
  ) : props.check?.status === "failed" ? (
    <p className={`${STATE} text-danger`}><CircleAlert size={12} aria-hidden />Didn't reply.</p>
  ) : (
    // Every row keeps its second line, so a state showing up moves nothing.
    <p aria-hidden className={`${STATE} invisible`}>{"\u00a0"}</p>
  );
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
              {props.forAutomations ? <AutomationChip hue={agent.hue} /> : null}
            </div>
          )}
          {editing ? null : state}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {launched ? (
            <SecondaryButton
              data-testid="agent-check"
              disabled={!props.canCheck}
              title={props.checkNote ?? undefined}
              onClick={props.onCheck}
              className={BUTTON_ICON}
            >
              {props.check?.status === "failed" && !props.checking ? "Try again" : "Check"}
            </SecondaryButton>
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
            width={200}
            items={[
              ...(props.onUseForAutomations
                ? [{ id: "automations", label: "Use for automations", icon: <Workflow size={14} aria-hidden />, onSelect: props.onUseForAutomations }]
                : []),
              { id: "rename", label: "Rename", icon: <Pencil size={14} aria-hidden />, onSelect: () => setEditing(true) },
              { id: "details", label: detailsOpen ? "Hide details" : "Details", icon: <ListCollapse size={14} aria-hidden />, onSelect: () => setDetailsOpen((open) => !open) },
              MENU_SEPARATOR,
              { id: "remove", label: "Remove", icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: props.onRemove },
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

type ToolTileState =
  | { status: "ready"; executable: string }
  | { status: "sign-in" | "update" | "not-found" };

// What an Add tile says about a tool: Ready, Sign in first, Update first or
// Not found. Null while dohc looks, or when it could not look.
function toolTileState(tool: "claude" | "codex", tools: AgentToolsResult | null): ToolTileState | null {
  if (!tools) return null;
  const found = tools.tools.find((entry) => entry.tool === tool);
  if (!found?.executable || found.probe === "not-found") return { status: "not-found" };
  if (found.probe !== "detected" || !supportsAgentProfile(tool, found.version)) return { status: "update" };
  return found.auth === "signed-out" ? { status: "sign-in" } : { status: "ready", executable: found.executable };
}

const TILE_STATE: Record<ToolTileState["status"], { text: string; className: string }> = {
  ready: { text: "Ready", className: "text-success" },
  "sign-in": { text: "Sign in first", className: "text-warning" },
  update: { text: "Update first", className: "text-warning" },
  "not-found": { text: "Not found", className: "text-muted" },
};

function AddTile(props: { title: string; state: ReactNode; disabled: boolean; hint?: string; onAdd: () => void }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      title={props.hint}
      onClick={props.onAdd}
      className="flex h-[52px] min-w-0 items-center gap-3 rounded-lg border border-line bg-bg px-3 text-left transition-colors hover:bg-hover disabled:cursor-default disabled:hover:bg-bg"
    >
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium text-ink">{props.title}</span>
        {props.state}
      </span>
      <Plus size={16} aria-hidden className="ml-auto shrink-0 text-muted" />
    </button>
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
        <SecondaryButton onClick={props.onOpenSettingsFile} className={BUTTON_ICON}>
          <FilePenLine size={14} aria-hidden />Open settings file
        </SecondaryButton>
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
  // Moves these entries to the front of the file; answers whether it saved.
  onOrder: (order: readonly string[]) => Promise<boolean>;
  onOpenSettingsFile: () => void;
  onError?: (message: string, cause?: unknown, retry?: () => Promise<void>, details?: ReadonlyArray<ErrorDetailField>) => void;
  onNotice?: (message: string, undo?: () => void) => void;
}) {
  const { workspaceId, settings, onSave, onOrder, onError, onNotice } = props;
  // An Undo can come after later changes, so it saves through the dialog's
  // latest save, which diffs against the settings as they are then.
  const latestSave = useRef(onSave);
  latestSave.current = onSave;
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
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The tools installed on this computer, for the Add tiles and each agent's details.
  const [detection, setDetection] = useState<AgentToolsResult | "failed" | null>(null);
  const tools = detection === "failed" ? null : detection;
  const toolRequests = useRequestSequence([workspaceId]);
  const reportError = useRef(onError);
  reportError.current = onError;
  // Try again on a failed look's toast looks again and refills the tiles.
  const detectTools = useCallback(async (): Promise<void> => {
    const token = toolRequests.next();
    setDetection(null);
    try {
      const found = await bridge().detectAgentTools({ workspaceId });
      if (toolRequests.isCurrent(token)) setDetection(found);
    } catch (cause) {
      if (!toolRequests.isCurrent(token)) return;
      setDetection("failed");
      reportError.current?.(ipcErrorMessage(cause, "dohc could not detect agent tools."), cause, detectTools);
    }
  }, [toolRequests, workspaceId]);
  useEffect(() => {
    void detectTools();
  }, [detectTools]);

  const rows = agentListRows(settings, props.agentProblems);
  const anyLaunch = rows.some((row) => row.kind === "agent" && row.agent.launch !== undefined);
  // The chip shows only when there is more than one agent to choose from.
  const automation = automationAgent(settings);
  const choosing = rows.filter((row) => row.kind === "agent" && row.agent.launch !== undefined).length > 1;
  const fileOrder = rows.map((row) => (row.kind === "agent" ? row.agent.id : row.problem.id));
  const checkNote = runnerEngineNote(Boolean(props.sharedView), props.sessionRecorderOn);
  // Why Check can't start now. Try again on a toast can come at such a time.
  const checkBlocked = useRef<string | null>(null);
  checkBlocked.current = checkNote
    ?? (paused ? "Agents are paused. Resume them, then try again." : null)
    ?? (checking !== null ? "A check is already running. Try again when it finishes." : null);
  const config = props.config;

  const check = useCallback(async (agent: Agent) => {
    const blocked = checkBlocked.current;
    if (blocked !== null) {
      onError?.(`dohc could not check ${agent.name}.`, undefined, () => check(agent), [["Cause", blocked]]);
      return;
    }
    const token = requests.current();
    setChecking(agent.id);
    const started = performance.now();
    let next: CheckState;
    try {
      const result = await bridge().runnerSelfTest({ workspaceId, agentId: agent.id });
      if (!requests.isCurrent(token)) return;
      // The toast names the agent and checks it again; why, and its log, go in the details.
      if (!result.ok) {
        onError?.(`${agent.name} didn't reply to the check.`, undefined, () => check(agent), [
          ["Cause", result.detail],
          ...(result.logPath ? [["Log", result.logPath] as const] : []),
        ]);
      }
      next = result.ok
        ? { status: "replied", seconds: Math.max(1, Math.round((performance.now() - started) / 1000)) }
        : { status: "failed" };
    } catch (cause) {
      if (!requests.isCurrent(token)) return;
      onError?.(ipcErrorMessage(cause, `dohc could not check ${agent.name}.`), cause, () => check(agent));
      next = { status: "failed" };
    }
    setChecks((current) => ({ ...current, [agent.id]: next }));
    setChecking(null);
  }, [onError, requests, workspaceId]);

  // A new agent takes the first free id and name. One dohc starts is on and
  // is checked at once; one you run opens on its name.
  const add = async (fields: Pick<AgentSettings, "name" | "launch" | "enabled">, idBase: string) => {
    const id = newAgentId([...Object.keys(settings.agents), ...(props.agentProblems ?? []).map((problem) => problem.id)], idBase);
    const agent: AgentSettings = { ...newAgentDefaults(settings, settings.appearance.yourColor ?? ownPresentation.hue), ...fields };
    if (!agent.launch) setRenaming(id);
    setAdding(true);
    const saved = await onSave({ ...settings, agents: { ...settings.agents, [id]: agent } });
    setAdding(false);
    if (saved && agent.launch && !paused && checkNote === null) void check({ id, ...agent });
  };

  // Automations wake the first agent dohc can start, so this one moves to the top.
  const wakeForAutomations = async (agent: Agent) => {
    const previous = fileOrder;
    if (await onOrder([agent.id])) onNotice?.(`Automations now wake ${agent.name}.`, () => void onOrder(previous));
  };

  // Undo puts the agent back where it was, under the name and settings it had,
  // unless an agent in the file has its id by then.
  const remove = async (agent: Agent) => {
    const previous = fileOrder;
    const { [agent.id]: entry, ...agents } = settings.agents;
    if (!entry || !(await onSave({ ...settings, agents }))) return;
    setRenaming((current) => (current === agent.id ? null : current));
    onNotice?.(`Removed ${agent.name}.`, () => void (async () => {
      let file: DesktopUserSettingsResult;
      try {
        file = await bridge().getUserSettings();
      } catch (cause) {
        onError?.(ipcErrorMessage(cause, `dohc could not bring back ${agent.name}.`), cause);
        return;
      }
      const current = file.settings;
      const problem = file.agentProblems?.find((entry) => entry.id === agent.id);
      const holder = current.agents[agent.id]?.name ?? (problem ? problem.name ?? problem.id : null);
      if (holder !== null) {
        onError?.(`Undo didn't replace the new ${holder}, so the one you removed stays removed.`);
        return;
      }
      if (await latestSave.current({ ...current, agents: { ...current.agents, [agent.id]: entry } })) await onOrder(previous);
    })());
  };

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
          size="button"
          testId="mcp-config-copy"
          disabled={!config || "unavailable" in config}
          getText={() => (config && !("unavailable" in config) ? configSnippet(config) : null)}
        />
        {anyLaunch ? (
          <SecondaryButton
            data-testid="agents-pause"
            onClick={() => setPaused(!paused)}
            className={BUTTON_ICON}
          >
            {paused ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
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
            editing={renaming === row.agent.id}
            onEditingChange={(editing) => setRenaming(editing ? row.agent.id : null)}
            forAutomations={choosing && automation?.id === row.agent.id}
            {...(row.agent.launch && automation?.id !== row.agent.id
              ? { onUseForAutomations: () => void wakeForAutomations(row.agent) }
              : {})}
            onRemove={() => void remove(row.agent)}
            onCheck={() => void check(row.agent)}
            onRename={(name) => onSave(withAgent(settings, row.agent.id, (agent) => ({ ...agent, name })))}
            onChange={(change) => void onSave(withAgent(settings, row.agent.id, change))}
          />
        ))}
        <div data-testid="agent-add" className="grid grid-cols-3 gap-2 py-4 max-[640px]:grid-cols-1">
          {(["claude", "codex"] as const).map((tool) => {
            const name = AGENT_TOOLS.find((entry) => entry.id === tool)!.name;
            const found = toolTileState(tool, tools);
            return (
              <AddTile
                key={tool}
                title={`Add ${name}`}
                disabled={found?.status !== "ready" || adding || checking !== null}
                hint={found?.status === "update" ? `Update ${name} to use it here.` : undefined}
                state={found ? (
                  <span className={`${TILE_LINE} ${TILE_STATE[found.status].className}`}>
                    {found.status === "ready" ? <Check size={12} aria-hidden /> : null}{TILE_STATE[found.status].text}
                  </span>
                ) : detection === "failed" ? (
                  <span className={`${TILE_LINE} text-muted`}>Couldn't check</span>
                ) : (
                  <span className={`${TILE_LINE} text-muted`}><LoaderCircle size={12} aria-label={`Looking for ${name}`} className="animate-spin" /></span>
                )}
                onAdd={() => {
                  if (found?.status === "ready") {
                    void add({ name: newAgentName(settings.agents, name), launch: { tool, executable: found.executable }, enabled: true }, tool);
                  }
                }}
              />
            );
          })}
          <AddTile
            title="Add one you run"
            disabled={adding}
            state={<span className={`${TILE_LINE} text-muted`}>Through MCP</span>}
            onAdd={() => void add({ name: newAgentName(settings.agents, "Agent"), enabled: false }, "agent")}
          />
        </div>
      </div>
      <p className="m-0 mt-2 flex items-center gap-1.5 text-[12px] text-muted">
        <Monitor size={14} aria-hidden />Runs on this computer. Turn an agent on for one computer per workspace.
      </p>
      {checkNote ? (
        <p data-testid="agents-check-note" className="m-0 mt-2 text-[12px] text-muted">{checkNote}</p>
      ) : null}
    </section>
  );
}
