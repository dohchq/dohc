import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, CircleAlert, Ear, FilePenLine, History, Pause, Play, Plug, Plus, TriangleAlert, Workflow } from "lucide-react";
import { MAX_PREFERRED_NAME_LENGTH, preferredNameFromInput } from "@dohc/workspace-contracts/chat-identity-values";
import { AGENT_TOOLS, AGENTS_RESTRICTED_MESSAGE, supportsAgentProfile, type AgentToolsResult } from "../../agents/agentToolCatalog";
import type { ActorPresentation, McpConfigResult } from "../../ipc/bridgeContract";
import { isAgentIdTaken, withErrorWords } from "../../ipc/errorWords";
import {
  agentNameTaken,
  automationAgent,
  DEFAULT_AGENT_ID,
  listAgents,
  newAgentDefaults,
  newAgentId,
  withAgent,
  type Agent,
  type AgentProblem,
  type AgentSettings,
  type DesktopUserSettings,
  type DesktopUserSettingsResult,
} from "../../settings/userSettings";
import type { AgentHue } from "@dohc/workspace-contracts/agent-hues";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { RestrictedAgentsBand } from "../RestrictedMode";
import type { ErrorDetailField } from "../shell/copyDetails";
import { IconButton, SecondaryButton } from "../ui/controls";
import { isComposingKey } from "../ui/keys";
import { useAgentsListening } from "../useAgentsListening";
import { useChatDispatchPaused } from "../useChatDispatchPaused";
import { useRequestSequence } from "../useRequestSequence";
import { ownPresentation } from "../workbench/actorPresentation";
import { ChatAvatar, useAgentInk } from "../workbench/ChatAvatar";
import { AddAgentSheet, type NewAgent, type ToolTileState } from "./AddAgentSheet";
import { AgentPage, checkStatus, type AgentRunControl, type CheckState } from "./AgentPage";

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

const rowId = (row: AgentListRow) => (row.kind === "agent" ? row.agent.id : row.problem.id);

/**
 * `order` with `id` back where it was: after the entry it followed, or in
 * front of the one after it when that entry is gone, or first. It never goes
 * ahead of `keep`, an agent chosen since that should go on waking automations.
 */
function placeBack(order: readonly string[], id: string, before: string | undefined, after: string | undefined, keep?: string): string[] {
  const rest = order.filter((entry) => entry !== id);
  let at = before !== undefined && rest.includes(before) ? rest.indexOf(before) + 1
    : after !== undefined && rest.includes(after) ? rest.indexOf(after) : 0;
  if (keep !== undefined && rest.includes(keep)) at = Math.max(at, rest.indexOf(keep) + 1);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** A problem sentence, with each key in backticks set in monospace. */
export function ProblemText(props: { text: string }) {
  return <>{props.text.split("`").map((part, index) =>
    index % 2 === 1 ? <code key={index} className="font-mono">{part}</code> : part)}</>;
}

// Why Check cannot run in this session, or null when it can. A session
// without a recorder can only refuse a check until dohc restarts.
export function runnerEngineNote(sharedView: boolean, sessionRecorderOn: boolean | undefined, restricted = false): string | null {
  if (sharedView) return "This workspace is a shared view. dohc records nothing here, so there is no chat to test.";
  if (restricted) return AGENTS_RESTRICTED_MESSAGE;
  return sessionRecorderOn === false
    ? "The workspace engine starts when dohc starts. Restart dohc to check an agent."
    : null;
}

function checkIdentity(workspaceId: string, agentId: string): string {
  return `agent-check:${workspaceId}:${agentId}`;
}

const PAUSED_CHECK_REASON = "Agents are paused. Resume them, then try again.";

// Why a check from a closed panel can't start: main's trust and pause, read
// now. Main still refuses what else holds it back.
async function closedPanelBlock(workspaceId: string): Promise<string | null> {
  const [trust, pause] = await Promise.all([
    bridge().readWorkspaceTrust({ workspaceId }).catch(() => null),
    bridge().readChatDispatchPaused({}).catch(() => null),
  ]);
  if (trust?.trusted === false) return AGENTS_RESTRICTED_MESSAGE;
  return pause?.paused ? PAUSED_CHECK_REASON : null;
}

// A failed check reports only while the settings file lists its agent, so a
// Remove during the check, in this panel or a later one, leaves no notice.
// When the file can't be read, it reports.
async function stillListed(agentId: string): Promise<boolean> {
  try {
    const file = await bridge().getUserSettings();
    return file.source === "recovered"
      || Object.hasOwn(file.settings.agents, agentId)
      || (file.agentProblems ?? []).some((problem) => problem.id === agentId);
  } catch {
    return true;
  }
}

// The MCP config that runs dohc's MCP server as this agent you run.
function configSnippet(config: Extract<McpConfigResult, { command: string }>, agentId: string): string {
  return JSON.stringify({ mcpServers: { dohc: { command: config.command, args: [...config.args, "--agent-id", agentId] } } }, null, 2);
}

function presentationFor(hue: AgentHue | undefined): ActorPresentation {
  return { group: "", hue: hue === undefined || hue === "olive" ? null : hue, self: false };
}


const ROW = "border-b border-line last:border-b-0";
const ROW_LINE = "flex items-center gap-3 px-4 py-3";
const STATE = "m-0 mt-0.5 flex items-center gap-1 text-[12px]";

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
      data-unsaved={draft.trim() !== props.agent.name ? true : undefined}
      data-edit-in-place
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
      className={`h-8 w-56 max-w-full rounded-md border bg-bg px-2.5 text-[14px] font-semibold text-ink ${error ? "border-danger" : "border-line focus:border-ink"}`}
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

// One agent in the list: who it is and where it stands. It opens the agent's page.
function AgentRow(props: {
  agent: Agent;
  listening: boolean;
  paused: boolean;
  checking: boolean;
  check: CheckState | undefined;
  marking: boolean;
  forAutomations: boolean;
  onOpen: () => void;
}) {
  const { agent } = props;
  const launched = agent.launch !== undefined;
  // Only a switch turns an agent off, so only an agent with one dims.
  const off = launched && !agent.enabled;
  // Under the name: what starts the agent, then where it stands. A check
  // reports even when the agent is off.
  const launch = agent.launch;
  const toolId = launch && "tool" in launch ? launch.tool : null;
  const tool = !launch ? null : toolId ? AGENT_TOOLS.find((entry) => entry.id === toolId)!.name : "Your command";
  const status = !launched ? (props.listening ? (
    <span className="inline-flex items-center gap-1 text-success"><Ear size={12} aria-hidden />Listening</span>
  ) : props.marking ? (
    <span className="inline-flex items-center gap-1 text-success"><History size={12} aria-hidden />Marking changes</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted"><Plug size={12} aria-hidden />Through MCP</span>
  )) : props.checking || props.check ? checkStatus(props)
    : off ? <span className="text-muted">Off</span>
    : props.paused ? <span className="inline-flex items-center gap-1 text-muted"><Pause size={12} aria-hidden />Paused</span>
    : <span className="text-muted">On</span>;
  return (
    <button
      type="button"
      data-testid="agent-row"
      data-agent-id={agent.id}
      aria-label={agent.name}
      onClick={props.onOpen}
      className={`${ROW} ${ROW_LINE} w-full text-left transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-hover`}
    >
      <ChatAvatar name={agent.name} kind="agent" presentation={presentationFor(agent.hue)} size="row" className={off ? "opacity-50" : undefined} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 truncate text-[13px] font-medium ${off ? "text-muted" : "text-ink"}`}>{agent.name}</span>
          {props.forAutomations ? <AutomationChip hue={agent.hue} /> : null}
        </span>
        <span data-testid="agent-state" className={STATE}>
          {tool ? <span className="text-muted">{tool}</span> : null}
          {tool ? <span aria-hidden className="text-subtle">·</span> : null}
          {status}
        </span>
      </span>
      <ChevronRight size={16} aria-hidden className="shrink-0 text-subtle" />
    </button>
  );
}

// What Add agent says about a tool: Ready, Sign in first, Update first or
// Not found. Null while dohc looks, or when it could not look.
function toolTileState(tool: "claude" | "codex", tools: AgentToolsResult | null): ToolTileState | null {
  if (!tools) return null;
  const found = tools.tools.find((entry) => entry.tool === tool);
  if (!found?.executable || found.probe === "not-found") return { status: "not-found" };
  if (found.probe !== "detected" || !supportsAgentProfile(tool, found.version)) return { status: "update" };
  return found.auth === "signed-out" ? { status: "sign-in" } : { status: "ready", executable: found.executable };
}

function BrokenAgentRow(props: { problem: AgentProblem; onOpenSettingsFile: () => void }) {
  const { problem } = props;
  const name = problem.name ?? problem.id;
  return (
    <div data-testid="agent-row-broken" data-agent-id={problem.id} className={`${ROW} ${ROW_LINE}`}>
      <ChatAvatar name={name} kind="agent" presentation={presentationFor(problem.hue)} size="row" />
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-[13px] font-medium text-ink">{name}</p>
        <p data-testid="agent-problem" className={`${STATE} text-warning`}>
          <TriangleAlert size={12} aria-hidden className="shrink-0" />
          <span className="min-w-0"><ProblemText text={problem.problem} /></span>
        </p>
      </div>
      <SecondaryButton onClick={props.onOpenSettingsFile} className="inline-flex shrink-0 items-center gap-1.5">
        <FilePenLine size={14} aria-hidden />Open settings file
      </SecondaryButton>
    </div>
  );
}

/**
 * Settings › Agents: every agent in the order the file lists them, with the
 * entries dohc could not use in their place. A row opens that agent's page.
 * Add agent opens one sheet for any agent. Pause holds every agent dohc
 * starts on this computer until Resume or quit.
 */
export function AgentList(props: {
  workspaceId: string;
  settings: DesktopUserSettings;
  agentProblems?: readonly AgentProblem[];
  config: McpConfigResult | null;
  sharedView?: boolean;
  sessionRecorderOn: boolean | undefined;
  // The run that marks this workspace's changes as one agent's, absent where there is none to start.
  run?: AgentRunControl;
  // Answers with the settings main saved, or null when a failed save said why in Notices.
  onSave: (settings: DesktopUserSettings) => Promise<DesktopUserSettingsResult | null>;
  // Moves these entries to the front of the file; answers whether it saved.
  // A failed move says `failure` when given, with why.
  onOrder: (order: readonly string[], failure?: string) => Promise<boolean>;
  onOpenSettingsFile: () => void;
  // Workspace trust: false holds every agent back. null is still reading and holds nothing back.
  trust?: { trusted: boolean | null; asking: boolean; onTrust: () => void };
  // A report with an identity replaces the row of that identity in Notices.
  onError?: (message: string, cause?: unknown, retry?: () => Promise<void>, details?: ReadonlyArray<ErrorDetailField>, identity?: string) => void;
  // Takes back the toast and Notices row of this identity.
  onClearError?: (identity: string) => void;
  onNotice?: (message: string, undo?: () => void) => void;
}) {
  const { workspaceId, settings, onSave, onOrder, onError, onClearError, onNotice } = props;
  const paused = useChatDispatchPaused((cause) =>
    onError?.(withErrorWords("dohc could not read whether agent replies are paused.", cause), cause));
  const listening = useAgentsListening();
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  // A check's answer belongs to the workspace that asked for it.
  const requests = useRequestSequence([workspaceId]);
  // The agent whose page shows, or null for the list.
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    setChecking(null);
    setChecks({});
  }, [workspaceId]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  // The tools installed on this computer, for Add agent and each agent's page.
  const [detection, setDetection] = useState<AgentToolsResult | "failed" | null>(null);
  const tools = detection === "failed" ? null : detection;
  const toolRequests = useRequestSequence([workspaceId]);
  const reportError = useRef(onError);
  reportError.current = onError;
  // Try again on a failed look's toast looks again.
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
  const fileOrder = rows.map(rowId);
  const restricted = props.trust?.trusted === false;
  const asking = props.trust?.asking ?? false;
  const page = opened === null ? null : rows.find((row): row is Extract<AgentListRow, { kind: "agent" }> => row.kind === "agent" && row.agent.id === opened)?.agent ?? null;

  // Opening a page focuses its back button; going back focuses the agent's row.
  const card = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<{ row: string } | "page" | "heading" | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    if (target === "page" || target === "heading") {
      focusAfter.current = null;
      (target === "page" ? back.current : heading.current)?.focus();
      return;
    }
    const element = card.current?.querySelector<HTMLElement>(`[data-testid="agent-row"][data-agent-id="${CSS.escape(target.row)}"]`);
    // A row for an agent just added waits for the settings that list it.
    if (!element && !Object.hasOwn(settings.agents, target.row)) return;
    focusAfter.current = null;
    (element ?? heading.current)?.focus();
  });
  const openPage = (id: string) => {
    focusAfter.current = "page";
    setOpened(id);
  };
  const closePage = () => {
    if (opened !== null) focusAfter.current = { row: opened };
    setRenaming(null);
    setOpened(null);
  };
  // A page whose agent left the file, such as after Remove, goes back to the list.
  useEffect(() => {
    if (opened !== null && page === null) {
      focusAfter.current = "heading";
      setOpened(null);
    }
  }, [opened, page]);

  // Set while main's dialog answers the band's Trust workspace. When it
  // answers, focus that was on the band goes to the page's Send test, or the
  // list's first agent, or the Agents heading when there is neither. It goes
  // back to Trust workspace when the person stayed in Restricted Mode.
  const trustPressed = useRef(false);
  useEffect(() => {
    if (!trustPressed.current || asking) return;
    trustPressed.current = false;
    const band = card.current?.querySelector(`[data-testid="restricted-agents-state"]`);
    const active = document.activeElement;
    if (active !== null && active !== document.body && !band?.contains(active)) return;
    (restricted
      ? card.current?.querySelector<HTMLElement>(`[data-testid="restricted-agents-state"] button`)
      : card.current?.querySelector<HTMLElement>(`[data-testid="agent-check"]:not(:disabled), [data-testid="agent-row"]`) ?? heading.current)?.focus();
  }, [asking, restricted]);
  const checkNote = runnerEngineNote(Boolean(props.sharedView), props.sessionRecorderOn, restricted);
  // Why a check can't start now. Try again on a toast can come at such a time.
  const checkBlocked = useRef<string | null>(null);
  checkBlocked.current = checkNote
    ?? (paused ? PAUSED_CHECK_REASON : null)
    ?? (checking !== null ? "A check is already running. Try again when it finishes." : null);
  // A Try again kept in Notices can run after this panel closes. It doesn't
  // read the reason the panel can no longer update; it asks main instead.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => { open.current = false; };
  }, []);
  const config = props.config;

  // One row in Notices per agent's failed check, which its next pass takes back.
  // It reports after the panel closes too; only this panel's state waits on it being open.
  const check = useCallback(async (agent: Agent) => {
    const identity = checkIdentity(workspaceId, agent.id);
    const blocked = open.current ? checkBlocked.current : await closedPanelBlock(workspaceId);
    if (blocked !== null) {
      onError?.(`dohc could not check ${agent.name}.`, undefined, () => check(agent), [["Cause", blocked]], identity);
      return;
    }
    const token = requests.current();
    const shows = () => open.current && requests.isCurrent(token);
    setChecking(agent.id);
    const started = performance.now();
    let next: CheckState;
    try {
      const result = await bridge().runnerSelfTest({ workspaceId, agentId: agent.id });
      if (result.ok) onClearError?.(identity);
      // The toast names the agent and checks it again; why, and its log, go in the details.
      else if (await stillListed(agent.id)) {
        onError?.(result.unconfirmed ? `${agent.name} replied as Agent.` : `${agent.name} didn't reply to the check.`, undefined, () => check(agent), [
          ["Cause", result.detail],
          ...(result.logPath ? [["Log", result.logPath] as const] : []),
        ], identity);
      }
      next = result.ok
        ? { status: "replied", seconds: Math.max(1, Math.round((performance.now() - started) / 1000)) }
        : { status: "failed" };
    } catch (cause) {
      if (await stillListed(agent.id)) {
        onError?.(ipcErrorMessage(cause, `dohc could not check ${agent.name}.`), cause, () => check(agent), undefined, identity);
      }
      next = { status: "failed" };
    }
    if (!shows()) return;
    setChecks((current) => ({ ...current, [agent.id]: next }));
    setChecking(null);
  }, [onClearError, onError, requests, workspaceId]);

  // The ids an added agent can't take. An agent you run never takes the
  // default id, which Chats would set up as one dohc starts.
  const taken = [...Object.keys(settings.agents), ...(props.agentProblems ?? []).map((problem) => problem.id)];
  const idFor = (launched: boolean, base: string) => newAgentId(launched ? taken : [...taken, DEFAULT_AGENT_ID], base);
  const newHue = newAgentDefaults(settings, settings.appearance.yourColor ?? ownPresentation.hue).hue;

  // A new agent dohc starts is checked at once when it is on; one you run has nothing to check.
  const add = async (fields: NewAgent) => {
    const id = idFor(fields.launch !== undefined, fields.idBase);
    const agent: AgentSettings = {
      ...newAgentDefaults(settings, settings.appearance.yourColor ?? ownPresentation.hue),
      name: fields.name,
      hue: fields.hue,
      enabled: fields.enabled,
      ...(fields.launch ? { launch: fields.launch } : {}),
    };
    // The agent is saved for every workspace; its check belongs to this one.
    const token = requests.current();
    setAdding(true);
    const saved = await onSave({ ...settings, agents: { ...settings.agents, [id]: agent } });
    setAdding(false);
    if (!saved) return;
    setSheetOpen(false);
    if (!requests.isCurrent(token)) return;
    focusAfter.current = { row: id };
    if (agent.launch && agent.enabled && !paused && checkNote === null) void check({ id, ...agent });
  };

  const neighbours = (id: string) => {
    const at = fileOrder.indexOf(id);
    return [fileOrder[at - 1], fileOrder[at + 1]] as const;
  };

  // Automations wake the first agent dohc can start, so this one moves to the
  // top. Undo moves only this agent back, in the order the file has then.
  const wakeForAutomations = async (agent: Agent) => {
    const [before, after] = neighbours(agent.id);
    if (!(await onOrder([agent.id]))) return;
    onNotice?.(`Automations now wake ${agent.name}.`, () => void (async () => {
      let file: DesktopUserSettingsResult;
      try {
        file = await bridge().getUserSettings();
      } catch (cause) {
        onError?.(ipcErrorMessage(cause, `dohc could not move ${agent.name} back.`), cause);
        return;
      }
      const order = agentListRows(file.settings, file.agentProblems).map(rowId);
      if (!order.includes(agent.id)) {
        onError?.(`Undo didn't move ${agent.name} because it isn't in your settings anymore.`);
        return;
      }
      // Unless it still wakes automations, it goes back behind the agent that does.
      const waking = automationAgent(file.settings)?.id;
      await onOrder(placeBack(order, agent.id, before, after, waking), `dohc could not move ${agent.name} back.`);
    })());
  };

  // Undo puts the agent back under the name and settings it had, where it
  // was (`placeBack`). Every other entry keeps its place in the file as it is
  // then. An agent in the file with its id by then stays.
  const remove = async (agent: Agent) => {
    const [before, after] = neighbours(agent.id);
    const { [agent.id]: entry, ...agents } = settings.agents;
    if (!entry) return;
    const saved = await onSave({ ...settings, agents });
    if (!saved) return;
    // The file can hold the agent again by the time main saves.
    if (Object.hasOwn(saved.settings.agents, agent.id) || saved.agentProblems?.some((problem) => problem.id === agent.id)) {
      onError?.(`dohc didn't remove ${agent.name} because the settings file still lists it.`);
      return;
    }
    const left = agentListRows(saved.settings, saved.agentProblems).map(rowId);
    setRenaming((current) => (current === agent.id ? null : current));
    // Its page goes with it, and focus goes to the Agents heading.
    setOpened((current) => {
      if (current !== agent.id) return current;
      focusAfter.current = "heading";
      return null;
    });
    // Its failed check goes with it, and Undo doesn't bring that back.
    onClearError?.(checkIdentity(workspaceId, agent.id));
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
      const keep = (name: string) => onError?.(`Undo didn't replace the new ${name}, so the one you removed stays removed.`);
      if (holder !== null) {
        keep(holder);
        return;
      }
      // If the agents are in the order this Remove left them, it goes back
      // exactly where it was. Otherwise it doesn't go ahead of the agent that
      // wakes automations now.
      const now = agentListRows(current, file.agentProblems).map(rowId);
      const unchanged = now.length === left.length && now.every((id, at) => id === left[at]);
      const order = placeBack(now, agent.id, before, after, unchanged ? undefined : automationAgent(current)?.id);
      // Saved from the file just read, so main refuses it if the agent came back since.
      try {
        await bridge().setUserSettings({ settings: { ...current, agents: { ...current.agents, [agent.id]: entry } }, base: current });
      } catch (cause) {
        if (isAgentIdTaken(cause)) keep(agent.name);
        else onError?.(ipcErrorMessage(cause, `dohc could not bring back ${agent.name}.`), cause);
        return;
      }
      await onOrder(order, `dohc brought back ${agent.name} but could not put it back in its place.`);
    })());
  };

  const setPaused = (next: boolean) => {
    void bridge().setChatDispatchPaused({ paused: next }).catch((cause: unknown) => onError?.(
      withErrorWords(next ? "dohc could not pause agent replies." : "dohc could not resume agent replies.", cause),
      cause,
    ));
  };

  const mcpConfig = (agentId: string) => (config && !("unavailable" in config) ? configSnippet(config, agentId) : null);
  const mcpUnavailable = config && "unavailable" in config ? config.message : null;
  const activeRun = props.run?.activeRun ?? null;
  const restrictedBand = restricted && props.trust ? (
    <div className="mb-4 overflow-hidden rounded-lg border border-line">
      <RestrictedAgentsBand asking={asking} onTrust={() => {
        trustPressed.current = true;
        props.trust?.onTrust();
      }} />
    </div>
  ) : null;

  if (page) {
    const agent = page;
    return (
      <section data-testid="agent-list" aria-labelledby="agents-title">
        <h3 ref={heading} tabIndex={-1} id="agents-title" className="sr-only">Agents</h3>
        <div ref={card}>
          {restrictedBand}
          <AgentPage
            agent={agent}
            agents={settings.agents}
            workspaceId={workspaceId}
            tools={tools}
            mcpConfig={mcpConfig(agent.id)}
            mcpUnavailable={mcpUnavailable}
            listening={listening.has(agent.id)}
            paused={paused}
            checking={checking === agent.id}
            check={checks[agent.id]}
            // One check at a time: main runs one runner per workspace.
            canCheck={!paused && checking === null && checkNote === null}
            checkReason={checkNote ?? (paused ? PAUSED_CHECK_REASON : null)}
            // The band already says why in Restricted Mode.
            checkNote={restricted ? null : checkNote ?? (paused ? PAUSED_CHECK_REASON : null)}
            agentName={(id) => settings.agents[id]?.name ?? "another agent"}
            run={props.run}
            nameField={renaming === agent.id ? (
              <AgentNameField agent={agent} agents={settings.agents}
                onSave={async (name) => (await onSave(withAgent(settings, agent.id, (current) => ({ ...current, name })))) !== null}
                onDone={() => setRenaming(null)} />
            ) : null}
            automationChip={choosing && automation?.id === agent.id ? <AutomationChip hue={agent.hue} /> : null}
            {...(agent.launch && automation?.id !== agent.id
              ? { onUseForAutomations: () => void wakeForAutomations(agent) }
              : {})}
            onRename={() => setRenaming(agent.id)}
            onRemove={() => void remove(agent)}
            onCheck={() => void check(agent)}
            onChange={(change) => void onSave(withAgent(settings, agent.id, change))}
            onBack={closePage}
            backRef={back}
          />
        </div>
      </section>
    );
  }

  return (
    <section data-testid="agent-list" aria-labelledby="agents-title">
      {/* The title sits where every Settings page title sits. */}
      <div className="-mt-1 mb-5 flex min-h-8 items-center gap-2">
        <h3 ref={heading} tabIndex={-1} id="agents-title" className="m-0 mr-auto text-base font-semibold text-ink">Agents</h3>
        {anyLaunch ? (
          <IconButton
            data-testid="agents-pause"
            aria-label={paused ? "Resume agents" : "Pause all agents"}
            aria-pressed={paused}
            title={paused ? "Resume agents" : "Pause all agents"}
            onClick={() => setPaused(!paused)}
            className="size-8"
          >
            {paused ? <Play size={15} aria-hidden /> : <Pause size={15} aria-hidden />}
          </IconButton>
        ) : null}
        <SecondaryButton
          data-testid="agent-add"
          disabled={adding}
          onClick={() => setSheetOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5"
        >
          <Plus size={14} aria-hidden />Add agent
        </SecondaryButton>
      </div>
      <div ref={card}>
        {restrictedBand}
        {paused && anyLaunch ? (
          <p data-testid="agents-paused" className="m-0 mb-3 flex items-center gap-1.5 text-[12px] text-muted">
            <Pause size={13} aria-hidden />Paused until you resume or quit dohc.
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p data-testid="agents-empty" className="m-0 rounded-lg border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
            No agents yet.
          </p>
        ) : (
          <div data-testid="agents" className="rounded-lg border border-line bg-panel">
            {rows.map((row) => row.kind === "broken" ? (
              <BrokenAgentRow key={`broken:${row.problem.id}`} problem={row.problem} onOpenSettingsFile={props.onOpenSettingsFile} />
            ) : (
              <AgentRow
                key={row.agent.id}
                agent={row.agent}
                listening={listening.has(row.agent.id)}
                paused={paused}
                checking={checking === row.agent.id}
                check={checks[row.agent.id]}
                marking={activeRun?.agentId === row.agent.id}
                forAutomations={choosing && automation?.id === row.agent.id}
                onOpen={() => openPage(row.agent.id)}
              />
            ))}
          </div>
        )}
        {checkNote && !restricted ? (
          <p data-testid="agents-check-note" className="m-0 mt-2 text-[12px] text-muted">{checkNote}</p>
        ) : null}
        {/* A run for an agent this list doesn't show still needs a way to stop it. */}
        {activeRun && !rows.some((entry) => entry.kind === "agent" && entry.agent.id === activeRun.agentId) ? (
          <div data-testid="agent-run-unlisted" className="mt-3 flex items-center gap-3 text-[12px] text-muted">
            <span className="min-w-0">A run is marking this workspace's changes as another agent's.</span>
            <SecondaryButton data-testid="mcp-enable-toggle" size="row" disabled={props.run?.busy}
              onClick={() => props.run?.onToggle(activeRun.agentId)} className="ml-auto shrink-0">
              Stop run
            </SecondaryButton>
          </div>
        ) : null}
      </div>
      {sheetOpen ? (
        <AddAgentSheet
          agents={settings.agents}
          toolState={(tool) => toolTileState(tool, tools)}
          detectionFailed={detection === "failed"}
          hue={newHue}
          mcpConfig={mcpConfig}
          mcpUnavailable={mcpUnavailable}
          mcpAgentId={idFor(false, "agent")}
          adding={adding}
          onAdd={(agent) => void add(agent)}
          onCancel={() => {
            focusAfter.current = null;
            setSheetOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}
