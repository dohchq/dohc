import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleAlert, Ear, FilePenLine, History, Link, Pause, Play, Plug, Plus, TriangleAlert, Workflow } from "lucide-react";
import { MAX_PREFERRED_NAME_LENGTH, preferredNameFromInput } from "@dohc/workspace-contracts/chat-identity-values";
import { AGENT_TOOLS, AGENTS_RESTRICTED_MESSAGE, supportsAgentProfile, type AgentToolsResult } from "../../agents/agentToolCatalog";
import type { ActorPresentation, McpConfigResult, PersonalAgentChange, PersonalAgentsAccount } from "../../ipc/bridgeContract";
import { withErrorWords } from "../../ipc/errorWords";
import {
  agentNameKey,
  agentNameTaken,
  automationAgent,
  DEFAULT_AGENT_ID,
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
import { relativeTime } from "../relativeTime";
import { RestrictedAgentsBand } from "../RestrictedMode";
import type { ErrorDetailField } from "../shell/copyDetails";
import { IconButton, RetryRow, SecondaryButton } from "../ui/controls";
import { isComposingKey } from "../ui/keys";
import { useAgentsListening } from "../useAgentsListening";
import { useChatDispatchPaused } from "../useChatDispatchPaused";
import { usePersonalAgents, type PersonalAgentsState } from "../usePersonalAgents";
import { useRequestSequence } from "../useRequestSequence";
import { ownPresentation } from "../workbench/actorPresentation";
import { ChatAvatar, useAgentInk } from "../workbench/ChatAvatar";
import { AddAgentSheet, type AgentLinkChoice, type NewAgent, type ToolTileState } from "./AddAgentSheet";
import { AgentPage, checkStatus, type AgentRunControl, type CheckState } from "./AgentPage";
import {
  agentLink,
  changePersonalAgent,
  NAME_TAKEN,
  PersonalAgentPage,
  personalEntries,
  personalNameProblem,
  syncsTo,
  type PersonalEntry,
} from "./PersonalAgentPage";
import { agentListRows, checkIdentity, placeBack, removeAgentWithUndo, rowId, type AgentListRow } from "./agentRemoval";
import { RemoveAgentDialog } from "./agentDialogs";
import { ArchivedAgents, archivedAgentChats, useAgentChats } from "./ArchivedAgents";
import { isPersonalAgentId } from "../workbench/chosenColors";

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

// Why an agent in the settings file can't take this name, or null when it
// can. `takenElsewhere` names your personal agents, which answer to the same @.
function localNameProblem(agents: DesktopUserSettings["agents"], agentId: string, takenElsewhere: (name: string) => boolean) {
  return (value: string): string | null => {
    try {
      const name = preferredNameFromInput(value);
      if (!name) return "Enter an agent name.";
      return agentNameTaken(agents, agentId, name) || takenElsewhere(name) ? NAME_TAKEN : null;
    } catch (cause) {
      return ipcErrorMessage(cause, "This name can't be used.");
    }
  };
}

function AgentNameField(props: {
  agentId: string;
  name: string;
  maxLength?: number;
  // Why the field can't save this name, or null when it can.
  problem: (value: string) => string | null;
  onSave: (name: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const { problem } = props;
  const [draft, setDraft] = useState(props.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  // Escape leaves the name as it was, so the blur that follows saves nothing.
  const cancelled = useRef(false);
  useEffect(() => input.current?.select(), []);
  const save = async () => {
    if (cancelled.current) return;
    const found = problem(draft);
    setError(found);
    if (found) return;
    const name = draft.trim();
    if (name === props.name) return props.onDone();
    setSaving(true);
    // A save that fails says why in Notices and keeps the field open.
    const saved = await props.onSave(name);
    setSaving(false);
    if (saved) props.onDone();
  };
  return <>
    <input
      ref={input}
      aria-label={`Name of ${props.name}`}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `agent-name-error-${props.agentId}` : undefined}
      data-testid="agent-name-input"
      data-unsaved={draft.trim() !== props.name ? true : undefined}
      data-edit-in-place
      value={draft}
      maxLength={props.maxLength}
      disabled={saving}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => {
        const value = event.currentTarget.value;
        setDraft(value);
        // Says at once when the name is taken, and clears once it is not.
        setError(problem(value) === NAME_TAKEN ? NAME_TAKEN : null);
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
      <p id={`agent-name-error-${props.agentId}`} role="alert" className={`${STATE} mt-1.5 text-danger`}>
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
  // One of your personal agents has this agent's name, so @ can't tell them apart.
  nameClash: boolean;
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
        {props.nameClash ? (
          <span data-testid="agent-problem" className={`${STATE} text-warning`}>
            <TriangleAlert size={12} aria-hidden className="shrink-0" />{NAME_TAKEN}
          </span>
        ) : (
          <span data-testid="agent-state" className={STATE}>
            {tool ? <span className="text-muted">{tool}</span> : null}
            {tool ? <span aria-hidden className="text-subtle">·</span> : null}
            {status}
          </span>
        )}
      </span>
      <ChevronRight size={16} aria-hidden className="shrink-0 text-subtle" />
    </button>
  );
}

// One of your personal agents: it signed in through an agent link, and the
// server's host takes the place of a tool. A signed-out agent dims.
function PersonalAgentRow(props: { entry: PersonalEntry; onOpen: () => void }) {
  const { agent, account } = props.entry;
  const signedOut = agent.status === "signed_out";
  const dim = signedOut ? "opacity-50" : undefined;
  return (
    <button
      type="button"
      data-testid="agent-row"
      data-agent-id={agent.agentId}
      data-personal=""
      aria-label={agent.name}
      onClick={props.onOpen}
      className={`${ROW} ${ROW_LINE} w-full text-left transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-hover`}
    >
      <ChatAvatar name={agent.name} kind="agent" presentation={presentationFor(agent.hue)} size="row" className={dim} />
      <span className={`min-w-0 flex-1 ${dim ?? ""}`}>
        <span className="block min-w-0 truncate text-[13px] font-medium text-ink">{agent.name}</span>
        <span data-testid="agent-state" className={`${STATE} min-w-0 text-muted`}>
          <span className="inline-flex shrink-0 items-center gap-1"><Link size={12} aria-hidden />Through agent link</span>
          <span aria-hidden className="text-subtle">·</span>
          <span className="min-w-0 truncate">{account.host}</span>
          <span aria-hidden className="text-subtle">·</span>
          <span className="shrink-0">
            {signedOut ? "Signed out" : agent.lastActionAtMs === null ? "Signed in" : `Active ${relativeTime(agent.lastActionAtMs)}`}
          </span>
        </span>
      </span>
      <ChevronRight size={16} aria-hidden className="shrink-0 text-subtle" />
    </button>
  );
}

// A report with an identity replaces the row of that identity in Notices.
type ReportError = (message: string, cause?: unknown, retry?: () => Promise<void>, details?: ReadonlyArray<ErrorDetailField>, identity?: string) => void;

// An account whose agents dohc could not list: the toast once, a Try again in
// the list while no roster is cached, and a later good read takes both back.
// The shell takes the toast's row back as its Try again starts, so a read
// that fails again reports again, in the same words too. A push from main
// reports only new words. `reported` holds the words Notices has for each
// account, and the list keeps it while one of its pages is open, so coming
// back to the list doesn't report the same failure again.
function AccountReadFailure(props: { account: PersonalAgentsAccount; reported: Map<string, string>; onReload: () => Promise<PersonalAgentsState>; onError?: ReportError; onClearError?: (identity: string) => void }) {
  const { accountKey, failure } = props.account;
  const report = useRef(props.onError);
  report.current = props.onError;
  const clear = useRef(props.onClearError);
  clear.current = props.onClearError;
  const reload = useRef(props.onReload);
  reload.current = props.onReload;
  // A failure reports once, whether a push or a Try again brings it first.
  const { reported } = props;
  useEffect(() => {
    const identity = `personal-agents:${accountKey}`;
    function tell(words: string) {
      reported.set(accountKey, words);
      report.current?.(words, undefined, retry, undefined, identity);
    }
    async function retry(): Promise<void> {
      reported.delete(accountKey);
      const after = await reload.current();
      const words = after.status === "ready" ? after.accounts.find((entry) => entry.accountKey === accountKey)?.failure ?? null : null;
      if (words !== null && words !== reported.get(accountKey)) tell(words);
    }
    if (failure === null) {
      reported.delete(accountKey);
      clear.current?.(identity);
    } else if (failure !== reported.get(accountKey)) tell(failure);
  }, [accountKey, failure, reported]);
  if (props.account.roster !== null || failure === null) return null;
  return (
    <div className="mt-2">
      <RetryRow testId="personal-agents-retry" onRetry={props.onReload}>
        dohc could not list your agents on {props.account.host}.
      </RetryRow>
    </div>
  );
}

const PERSONAL_READ_FAILED = "dohc could not read your personal agents.";

// The read of your personal agents failed before any account answered. A
// Try again on its toast that fails again reports again. `reported` says
// whether Notices holds this failure, and the list keeps it as
// AccountReadFailure's is kept.
function PersonalReadFailure(props: { state: PersonalAgentsState; reported: { current: boolean }; onReload: () => Promise<PersonalAgentsState>; onError?: ReportError }) {
  const report = useRef(props.onError);
  report.current = props.onError;
  const reload = useRef(props.onReload);
  reload.current = props.onReload;
  const failed = props.state.status === "failed";
  // It reports once, whether the state or a Try again brings it first.
  const { reported } = props;
  useEffect(() => {
    function tell() {
      reported.current = true;
      report.current?.(PERSONAL_READ_FAILED, undefined, retry);
    }
    async function retry(): Promise<void> {
      reported.current = false;
      if ((await reload.current()).status === "failed" && !reported.current) tell();
    }
    if (!failed) reported.current = false;
    else if (!reported.current) tell();
  }, [failed, reported]);
  if (!failed) return null;
  return (
    <div className="mt-2">
      <RetryRow testId="personal-agents-retry" onRetry={props.onReload}>{PERSONAL_READ_FAILED}</RetryRow>
    </div>
  );
}

// Agent link on Add agent: the account this workspace syncs to, else the
// first account, with its link once the workspace syncs there.
function agentLinkChoice(state: PersonalAgentsState, workspaceId: string, workspaceName: string): AgentLinkChoice {
  if (state.status === "loading") return { status: "loading" };
  if (state.status === "failed") return { status: "failed" };
  const account = state.accounts.find((entry) => syncsTo(entry.roster, workspaceId)) ?? state.accounts[0];
  if (!account) return { status: "no-server" };
  if (account.roster === null) return account.failure === null ? { status: "loading" } : { status: "failed" };
  return {
    status: "ready",
    host: account.host,
    workspaceName,
    link: syncsTo(account.roster, workspaceId) ? agentLink(account, workspaceId) : null,
  };
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
  // What the open workspace goes by, for its agent link.
  workspaceName: string;
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
  // The personal agent whose page opens once the roster answers, by id, such
  // as the one a sign-in notice names. The list shows when the roster no
  // longer holds it. Each request is a new object, so the same agent can be
  // asked for again.
  openAgent?: { agentId: string };
}) {
  const { workspaceId, settings, onSave, onOrder, onError, onClearError, onNotice } = props;
  const paused = useChatDispatchPaused((cause) =>
    onError?.(withErrorWords("dohc could not read whether agent replies are paused.", cause), cause));
  const listening = useAgentsListening();
  // Opening Settings › Agents reads the relay again.
  const personal = usePersonalAgents(workspaceId, true);
  // What the read failures below have told this workspace's Notices. It
  // outlives the list while a page is open.
  const reportedAccounts = useMemo(() => new Map<string, string>(), [workspaceId]);
  const reportedRead = useMemo(() => ({ current: false }), [workspaceId]);
  // While a page is open the failures aren't shown, so forget each one that
  // ended: a later failure in the same words is a new one.
  useEffect(() => {
    if (personal.state.status !== "ready") return;
    reportedRead.current = false;
    const failures = new Map(personal.state.accounts.map((account) => [account.accountKey, account.failure]));
    for (const key of [...reportedAccounts.keys()]) if ((failures.get(key) ?? null) === null) reportedAccounts.delete(key);
  }, [personal.state, reportedAccounts, reportedRead]);
  const entries = personal.state.status === "ready" ? personalEntries(personal.state.accounts) : [];
  // A personal agent answers to the same @ as an agent here, so neither takes the other's name.
  const personalKeys = new Set(entries.map((entry) => agentNameKey(entry.agent.name)));
  const takenByPersonal = (name: string) => personalKeys.has(agentNameKey(name));
  // "No agents yet." waits until every account's agents are known.
  const personalKnown = personal.state.status === "ready" && personal.state.accounts.every((account) => account.roster !== null);
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
  // Agents whose chat is archived here list under Archived, as in Chats,
  // with removed agents' chats that are still there.
  const agentChats = useAgentChats(workspaceId, onError);
  const archivedChats = archivedAgentChats(workspaceId, settings, agentChats, (agentId) =>
    isPersonalAgentId(agentId)
      ? personalKnown ? entries.some((entry) => entry.agent.agentId === agentId) : null
      : (props.agentProblems ?? []).some((problem) => problem.id === agentId));
  const listed = rows.filter((row) => row.kind === "broken" || !archivedChats.archived.has(row.agent.id));
  // The agent Remove asks about. A dialog opened in one workspace closes in the next.
  const [removing, setRemoving] = useState<{ workspaceId: string; agent: Agent } | null>(null);
  if (removing && removing.workspaceId !== workspaceId) setRemoving(null);
  const anyLaunch = rows.some((row) => row.kind === "agent" && row.agent.launch !== undefined);
  // The chip shows only when there is more than one agent to choose from.
  const automation = automationAgent(settings);
  const choosing = rows.filter((row) => row.kind === "agent" && row.agent.launch !== undefined).length > 1;
  const fileOrder = rows.map(rowId);
  const restricted = props.trust?.trusted === false;
  const asking = props.trust?.asking ?? false;
  const page = opened === null ? null : rows.find((row): row is Extract<AgentListRow, { kind: "agent" }> => row.kind === "agent" && row.agent.id === opened)?.agent ?? null;
  const personalPage = opened === null || page !== null ? null : entries.find((entry) => entry.agent.agentId === opened) ?? null;

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
    const id = CSS.escape(target.row);
    const element = card.current?.querySelector<HTMLElement>(
      `[data-testid="agent-row"][data-agent-id="${id}"], [data-testid="agent-row-archived"][data-agent-id="${id}"] > button`,
    );
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
  // A page whose agent left the file or the roster, such as after Remove, goes back to the list.
  useEffect(() => {
    if (opened !== null && page === null && personalPage === null) {
      focusAfter.current = "heading";
      setOpened(null);
    }
  }, [opened, page, personalPage]);
  // The page asked for opens once the roster says whether it still holds
  // that agent, so it waits until every account has its agents or a failure.
  // When the roster doesn't hold it, the list shows, as after Remove.
  const [wanted, setWanted] = useState<string | null>(null);
  useEffect(() => {
    if (props.openAgent) setWanted(props.openAgent.agentId);
  }, [props.openAgent]);
  useEffect(() => {
    if (wanted === null || personal.state.status === "loading") return;
    if (personal.state.status === "ready" && personal.state.accounts.some((account) => account.roster === null && account.failure === null)) return;
    setWanted(null);
    const held = personal.state.status === "ready"
      && personalEntries(personal.state.accounts).some((entry) => entry.agent.agentId === wanted);
    if (held) {
      focusAfter.current = "page";
      setRenaming((current) => (current === wanted ? current : null));
      setOpened(wanted);
      return;
    }
    setRenaming(null);
    setOpened((current) => {
      if (current !== null) focusAfter.current = "heading";
      return null;
    });
  }, [personal.state, wanted]);

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

  const remove = async (agent: Agent) => {
    const removed = await removeAgentWithUndo({
      workspaceId, settings, agentProblems: props.agentProblems, agent, save: onSave,
      chatId: agentChats?.find((chat) => chat.agentId === agent.id)?.id, order: onOrder, onError, onClearError, onNotice,
    });
    if (!removed) return;
    setRenaming((current) => (current === agent.id ? null : current));
    // Its page or Archived row goes with it, and focus goes to the Agents heading.
    focusAfter.current = "heading";
    setOpened((current) => (current === agent.id ? null : current));
  };

  const changePersonal = async (entry: PersonalEntry, next: PersonalAgentChange, failure: string): Promise<boolean> => {
    const result = await changePersonalAgent(entry.account, entry.agent, next, failure);
    if (!result.ok) onError?.(result.error, undefined, async () => { await changePersonal(entry, next, failure); });
    return result.ok;
  };
  // Remove hides a signed-out agent. Undo brings it back signed out.
  const removePersonal = async (entry: PersonalEntry) => {
    const { agent } = entry;
    if (!(await changePersonal(entry, { kind: "remove" }, `dohc could not remove ${agent.name}.`))) return;
    setRenaming((current) => (current === agent.agentId ? null : current));
    onNotice?.(`Removed ${agent.name}.`, () => void changePersonal(entry, { kind: "restore" }, `dohc could not bring back ${agent.name}.`));
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

  const removeDialog = removing ? (
    <RemoveAgentDialog
      agent={removing.agent}
      settings={settings}
      onCancel={() => setRemoving(null)}
      onConfirm={() => {
        setRemoving(null);
        void remove(removing.agent);
      }}
    />
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
              <AgentNameField agentId={agent.id} name={agent.name} maxLength={MAX_PREFERRED_NAME_LENGTH}
                problem={localNameProblem(settings.agents, agent.id, takenByPersonal)}
                onSave={async (name) => (await onSave(withAgent(settings, agent.id, (current) => ({ ...current, name })))) !== null}
                onDone={() => setRenaming((current) => (current === agent.id ? null : current))} />
            ) : null}
            automationChip={choosing && automation?.id === agent.id ? <AutomationChip hue={agent.hue} /> : null}
            {...(agent.launch && automation?.id !== agent.id
              ? { onUseForAutomations: () => void wakeForAutomations(agent) }
              : {})}
            onRename={() => setRenaming(agent.id)}
            onRemove={() => setRemoving({ workspaceId, agent })}
            onCheck={() => void check(agent)}
            onChange={(change) => void onSave(withAgent(settings, agent.id, change))}
            onBack={closePage}
            backRef={back}
          />
        </div>
        {removeDialog}
      </section>
    );
  }

  if (personalPage) {
    const { agent } = personalPage;
    // Its name can't be one an agent here or another personal agent has.
    const takenByOthers = (name: string) => agentNameTaken(settings.agents, "", name)
      || entries.some((entry) => entry.agent.agentId !== agent.agentId && agentNameKey(entry.agent.name) === agentNameKey(name));
    return (
      <section data-testid="agent-list" aria-labelledby="agents-title">
        <h3 ref={heading} tabIndex={-1} id="agents-title" className="sr-only">Agents</h3>
        <div ref={card}>
          {/* Each agent gets a page of its own. A notice that opens another agent closes this one's sheets and menu, and their answers stay off the new page. */}
          <PersonalAgentPage
            key={`${personalPage.account.accountKey}:${agent.agentId}`}
            entry={personalPage}
            workspaceId={workspaceId}
            nameField={renaming === agent.agentId ? (
              <AgentNameField agentId={agent.agentId} name={agent.name}
                problem={(value) => personalNameProblem(value, takenByOthers)}
                onSave={(name) => changePersonal(personalPage, { kind: "name", name }, `dohc could not rename ${agent.name}.`)}
                onDone={() => setRenaming((current) => (current === agent.agentId ? null : current))} />
            ) : null}
            onRename={() => setRenaming(agent.agentId)}
            onRemove={() => void removePersonal(personalPage)}
            onChange={(next, failure) => changePersonal(personalPage, next, failure)}
            onError={(message) => onError?.(message)}
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
        {rows.length === 0 && entries.length === 0 ? (personalKnown ? (
          <p data-testid="agents-empty" className="m-0 rounded-lg border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
            No agents yet.
          </p>
        ) : null) : listed.length === 0 && entries.length === 0 ? null : (
          <div data-testid="agents" className="rounded-lg border border-line bg-panel">
            {listed.map((row) => row.kind === "broken" ? (
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
                nameClash={takenByPersonal(row.agent.name)}
                onOpen={() => openPage(row.agent.id)}
              />
            ))}
            {entries.map((entry) => (
              <PersonalAgentRow key={entry.agent.agentId} entry={entry} onOpen={() => openPage(entry.agent.agentId)} />
            ))}
          </div>
        )}
        <ArchivedAgents
          workspaceId={workspaceId}
          agents={rows.flatMap((row) => {
            const chat = row.kind === "agent" ? archivedChats.archived.get(row.agent.id) : undefined;
            return row.kind === "agent" && chat ? [{ agent: row.agent, chat }] : [];
          })}
          removed={archivedChats.removed}
          onOpen={openPage}
          onRemove={(agent) => setRemoving({ workspaceId, agent })}
          onError={(message, cause, retry) => onError?.(message, cause, retry)}
          onNotice={onNotice}
        />
        <PersonalReadFailure state={personal.state} reported={reportedRead} onReload={personal.reload} onError={onError} />
        {personal.state.status === "ready" ? personal.state.accounts.map((account) => (
          <AccountReadFailure key={account.accountKey} account={account} reported={reportedAccounts} onReload={personal.reload} onError={onError} onClearError={onClearError} />
        )) : null}
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
          agentLink={agentLinkChoice(personal.state, workspaceId, props.workspaceName)}
          takenElsewhere={takenByPersonal}
          adding={adding}
          onAdd={(agent) => void add(agent)}
          onCancel={() => {
            focusAfter.current = null;
            setSheetOpen(false);
          }}
        />
      ) : null}
      {removeDialog}
    </section>
  );
}
