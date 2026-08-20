import {
  createAgentDriverRegistry,
  type AgentDriver,
  type AgentDriverId,
  type AgentDriverRegistry,
  type AgentEvent,
  type AgentProbe,
  type AgentSession,
  type AgentSessionStartInput,
  type PermissionDecision,
  type PermissionOption,
} from "./AgentDriver";
import type { AgentIntegration } from "./AgentIntegration";

export type AgentSessionStatus =
  | "idle"
  | "starting"
  | "ready"
  | "running"
  | "waiting-permission"
  | "completed"
  | "failed"
  | "stopped";

export interface AgentDriverProbeSummary {
  id: AgentDriverId;
  displayName: string;
  installed: boolean;
  version?: string;
  auth: { status: AgentProbe["auth"]["status"]; label?: string };
  models: Array<{ id: string; name: string; planIncluded: boolean }>;
  errorMessage?: string;
}

export interface AgentSessionMessage {
  id: string;
  role: "assistant" | "reasoning";
  text: string;
}

export interface AgentSessionItem {
  id: string;
  type: "tool_call" | "command" | "file_change" | "mcp_tool_call" | "web_search" | "plan" | "other";
  title: string;
  detail?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  locations: string[];
}

export interface AgentPermissionRequestSnapshot {
  requestId: string;
  requestType: "command" | "file-change" | "file-read" | "tool" | "other";
  title: string;
  detail?: string;
  locations: string[];
  options: PermissionOption[];
}

export interface AgentSessionSnapshot {
  driverId: AgentDriverId;
  driverName: string;
  status: AgentSessionStatus;
  startedAt: number;
  endedAt?: number;
  runId?: string;
  lastError?: string;
  messages: AgentSessionMessage[];
  items: AgentSessionItem[];
  pendingPermissions: AgentPermissionRequestSnapshot[];
  usage?: { used: number; max?: number; input?: number; output?: number };
  authNotices: string[];
  /** The harness asked for a login part-way through this session. Without
   * this, an expired login reads as a run that failed for no stated reason. */
  loginRequired: boolean;
}

export interface AgentPanelSnapshot {
  drivers: AgentDriverProbeSummary[];
  session: AgentSessionSnapshot | null;
  /**
   * The driver dohc uses for this workspace when a caller does not name one:
   * the workspace's `agents.defaultDriverId` when that driver is installed
   * here, and otherwise the first installed driver. Null until a probe has
   * run, and when nothing is installed. The setting is a preference, so a
   * configured driver that is not installed falls back rather than blocks.
   */
  selectedDriverId: AgentDriverId | null;
}

/** The workspace's `agents.*` settings, read when they are needed. */
export interface AgentWorkspaceDefaults {
  defaultDriverId: string | null;
  defaultModel: string | null;
}

export interface AgentSessionManagerOptions {
  /** The drivers dohc ships. */
  registry: AgentDriverRegistry;
  /** The drivers this workspace's plugins contribute, if any. */
  pluginDriversFor?: (workspaceId: string) => AgentDriver[];
  agentDefaultsFor?: (
    workspaceId: string,
  ) => AgentWorkspaceDefaults | Promise<AgentWorkspaceDefaults>;
  integration: AgentIntegration;
  rootFor(workspaceId: string): string | null;
  mcpFor(
    rootPath: string,
  ): AgentSessionStartInput["mcp"] | Promise<AgentSessionStartInput["mcp"]>;
  now?: () => number;
}

interface ManagedSession extends AgentSessionSnapshot {
  session: AgentSession | null;
  ended: boolean;
}

const MAX_SNAPSHOT_MESSAGES = 200;
const MAX_SNAPSHOT_ITEMS = 200;
const MAX_SNAPSHOT_PERMISSIONS = 20;
const AGENT_PROBE_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "SystemRoot",
  "WINDIR",
] as const;

function bounded(value: string | undefined, max = 500): string | undefined {
  if (!value) return undefined;
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}

function cleanLocations(locations: string[] | undefined): string[] {
  return (locations ?? []).filter((location) => location.length > 0 && location.length <= 1000).slice(0, 20);
}

function snapshot(session: ManagedSession | null): AgentSessionSnapshot | null {
  if (!session) return null;
  const messages = session.messages.slice(-MAX_SNAPSHOT_MESSAGES);
  const items = session.items.slice(-MAX_SNAPSHOT_ITEMS);
  const pendingPermissions = session.pendingPermissions.slice(-MAX_SNAPSHOT_PERMISSIONS);
  return {
    driverId: session.driverId,
    driverName: session.driverName,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    runId: session.runId,
    lastError: session.lastError,
    messages: messages.map((message) => ({ ...message })),
    items: items.map((item) => ({ ...item, locations: [...item.locations] })),
    pendingPermissions: pendingPermissions.map((request) => ({
      ...request,
      locations: [...request.locations],
      options: request.options.map((option) => ({ ...option })),
    })),
    usage: session.usage ? { ...session.usage } : undefined,
    authNotices: [...session.authNotices],
    loginRequired: session.loginRequired,
  };
}

function summarizeProbe(id: AgentDriverId, displayName: string, probe: AgentProbe): AgentDriverProbeSummary {
  return {
    id,
    displayName,
    installed: probe.installed,
    version: probe.version,
    auth: {
      status: probe.auth.status,
      label: probe.auth.label,
    },
    models: probe.models.map((model) => ({
      id: model.id,
      name: model.name,
      planIncluded: model.planIncluded,
    })),
    errorMessage: probe.errorMessage,
  };
}

function terminalRunStatus(state: ManagedSession): "complete" | "failed" {
  return state.status === "failed" ? "failed" : "complete";
}

function agentProbeEnvironment(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const probeEnv: Record<string, string | undefined> = {};
  for (const key of AGENT_PROBE_ENV_KEYS) {
    if (env[key] !== undefined) probeEnv[key] = env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("DOHC_AGENT_")) probeEnv[key] = value;
  }
  return probeEnv;
}

export function createAgentSessionManager(options: AgentSessionManagerOptions) {
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, ManagedSession>();
  const finalizedRuns = new Set<string>();
  // Per-workspace start mutex. startSession does stop-then-create, so two
  // CONCURRENT starts for the same workspace would race into duplicate sessions
  // (each stopping the other's half-built session). This set marks a workspace
  // whose start is in flight; a second concurrent start is rejected outright.
  const startingWorkspaces = new Set<string>();
  // Per workspace, because a workspace's plugins decide which drivers it has.
  const cachedDrivers = new Map<string, AgentDriverProbeSummary[]>();
  const selectedDrivers = new Map<string, AgentDriverId | null>();

  /**
   * The drivers this workspace can use: the ones dohc ships plus the ones its
   * plugins contribute. Built through the same registry constructor the
   * built-in list uses, so a duplicate id is refused the same way here as it
   * is there.
   */
  function registryFor(workspaceId: string): AgentDriverRegistry {
    const contributed = options.pluginDriversFor?.(workspaceId) ?? [];
    if (contributed.length === 0) return options.registry;
    return createAgentDriverRegistry([
      ...options.registry.list(),
      ...contributed,
    ]);
  }

  function selectDriver(
    workspaceId: string,
    drivers: AgentDriverProbeSummary[],
    defaultDriverId: string | null,
  ): AgentDriverId | null {
    const configured = defaultDriverId === null
      ? undefined
      : drivers.find((driver) => driver.id === defaultDriverId && driver.installed);
    const selected = configured ?? drivers.find((driver) => driver.installed);
    const selectedId = selected?.id ?? null;
    selectedDrivers.set(workspaceId, selectedId);
    return selectedId;
  }

  async function finalizeRun(
    workspaceId: string,
    runId: string,
    status: "complete" | "failed",
  ): Promise<void> {
    const key = `${workspaceId}\0${runId}`;
    if (finalizedRuns.has(key)) return;
    finalizedRuns.add(key);
    try {
      await options.integration.endAgentRun(workspaceId, runId, status);
    } catch (error) {
      console.error("[desktop] failed to finalize agent run", error);
    }
  }

  function endRunAfterSettle(
    workspaceId: string,
    runId: string,
    status: "complete" | "failed",
  ): void {
    const timer = setTimeout(() => {
      void finalizeRun(workspaceId, runId, status);
    }, 750);
    timer.unref?.();
  }

  async function probeDrivers(workspaceId: string): Promise<AgentDriverProbeSummary[]> {
    const probes = await registryFor(workspaceId).probeAll(
      agentProbeEnvironment(process.env),
    );
    const summaries = probes.map(({ driver, probe }) =>
      summarizeProbe(driver.id, driver.displayName, probe));
    cachedDrivers.set(workspaceId, summaries);
    const defaults = await options.agentDefaultsFor?.(workspaceId);
    selectDriver(workspaceId, summaries, defaults?.defaultDriverId ?? null);
    return summaries;
  }

  function panelSnapshot(workspaceId: string): AgentPanelSnapshot {
    return {
      drivers:
        cachedDrivers.get(workspaceId) ??
        registryFor(workspaceId).list().map((driver) => ({
          id: driver.id,
          displayName: driver.displayName,
          installed: false,
          auth: { status: "unknown" },
          models: [],
        })),
      session: snapshot(sessions.get(workspaceId) ?? null),
      selectedDriverId: selectedDrivers.get(workspaceId) ?? null,
    };
  }

  function applyEvent(workspaceId: string, expectedState: ManagedSession, event: AgentEvent): void {
    const state = sessions.get(workspaceId);
    if (!state || state !== expectedState || state.ended) return;
    if (event.kind === "session-state") {
      if (event.state === "running") state.status = "running";
      if (event.state === "ready" && state.status !== "running") state.status = "ready";
      if (event.state === "error") {
        state.status = "failed";
        state.lastError = bounded(event.reason);
      }
      if (event.state === "closed" && !state.ended) {
        state.ended = true;
        state.endedAt = now();
        state.status = "failed";
        state.pendingPermissions = [];
        if (state.runId) {
          void finalizeRun(workspaceId, state.runId, "failed");
        }
      }
      return;
    }
    if (event.kind === "text-delta") {
      const id = `${event.stream}:${event.itemId}`;
      const existing = state.messages.find((message) => message.id === id);
      if (existing) existing.text = bounded(`${existing.text}${event.text}`, 10_000) ?? existing.text;
      else state.messages.push({ id, role: event.stream, text: bounded(event.text, 10_000) ?? "" });
      if (state.messages.length > MAX_SNAPSHOT_MESSAGES) {
        state.messages.splice(0, state.messages.length - MAX_SNAPSHOT_MESSAGES);
      }
      return;
    }
    if (event.kind === "item") {
      const item: AgentSessionItem = {
        id: event.item.id,
        type: event.item.type,
        title: bounded(event.item.title, 200) ?? "Agent item",
        detail: bounded(event.item.detail),
        status: event.item.status,
        locations: cleanLocations(event.item.locations),
      };
      const index = state.items.findIndex((entry) => entry.id === item.id);
      if (index >= 0) state.items[index] = item;
      else state.items.push(item);
      if (state.items.length > MAX_SNAPSHOT_ITEMS) {
        state.items.splice(0, state.items.length - MAX_SNAPSHOT_ITEMS);
      }
      return;
    }
    if (event.kind === "permission-request") {
      state.status = "waiting-permission";
      state.pendingPermissions = [
        ...state.pendingPermissions.filter((request) => request.requestId !== event.requestId),
        {
          requestId: event.requestId,
          requestType: event.requestType,
          title: bounded(event.title, 200) ?? "Permission request",
          detail: bounded(event.detail),
          locations: cleanLocations(event.locations),
          options: event.options.map((option) => ({ ...option })),
        },
      ].slice(-MAX_SNAPSHOT_PERMISSIONS);
      return;
    }
    if (event.kind === "permission-resolved") {
      state.pendingPermissions = state.pendingPermissions.filter((request) => request.requestId !== event.requestId);
      if (state.status === "waiting-permission") state.status = "running";
      return;
    }
    if (event.kind === "token-usage") {
      state.usage = {
        used: event.used,
        max: event.max,
        input: event.input,
        output: event.output,
      };
      return;
    }
    if (event.kind === "auth") {
      const notice = typeof event.detail === "string" ? event.detail : event.event;
      state.authNotices = [...state.authNotices, bounded(notice, 300) ?? event.event].slice(-5);
      // A login that expires part-way through a run ends the run. Recording
      // it here is what lets the surface say so, instead of reporting the
      // silence that follows as an ordinary failure.
      if (event.event === "login-required") state.loginRequired = true;
      return;
    }
    if (event.kind === "error") {
      state.lastError = bounded(event.message);
      if (event.fatal) {
        state.ended = true;
        state.endedAt = now();
        state.status = "failed";
        state.pendingPermissions = [];
        void state.session?.dispose().catch(() => undefined);
        if (state.runId) {
          void finalizeRun(workspaceId, state.runId, "failed");
        }
      }
      return;
    }
    if (event.kind === "turn-completed") {
      state.ended = true;
      state.endedAt = now();
      state.status = event.status === "failed" ? "failed" : event.status === "cancelled" ? "stopped" : "completed";
      state.lastError = bounded(event.errorMessage);
      state.pendingPermissions = [];
      if (state.runId) {
        endRunAfterSettle(workspaceId, state.runId, event.status === "failed" ? "failed" : "complete");
      }
    }
  }

  async function startSession(input: {
    workspaceId: string;
    driverId: AgentDriverId;
    prompt: string;
    model?: string;
  }): Promise<AgentPanelSnapshot> {
    const root = options.rootFor(input.workspaceId);
    if (!root) throw new Error(`Unknown workspace: ${input.workspaceId}`);
    const driver = registryFor(input.workspaceId).get(input.driverId);
    if (!driver) throw new Error(`Unknown agent driver: ${input.driverId}`);
    // Reject a concurrent start for the same workspace (checked + claimed
    // synchronously, before the first await, so the race window is closed).
    if (startingWorkspaces.has(input.workspaceId)) {
      throw new Error(
        `An agent session is already starting for workspace ${input.workspaceId}.`,
      );
    }
    startingWorkspaces.add(input.workspaceId);
    try {
      return await startSessionLocked(input, root, driver);
    } finally {
      startingWorkspaces.delete(input.workspaceId);
    }
  }

  async function startSessionLocked(
    input: { workspaceId: string; driverId: AgentDriverId; prompt: string; model?: string },
    root: string,
    driver: AgentDriver,
  ): Promise<AgentPanelSnapshot> {
    await stopSession(input.workspaceId);
    const state: ManagedSession = {
      driverId: driver.id,
      driverName: driver.displayName,
      status: "starting",
      startedAt: now(),
      messages: [],
      items: [],
      pendingPermissions: [],
      authNotices: [],
      loginRequired: false,
      session: null,
      ended: false,
    };
    sessions.set(input.workspaceId, state);
    try {
      const mcp = await options.mcpFor(root);
      // The workspace's own default model, for a caller that names none.
      const model = input.model ??
        (await options.agentDefaultsFor?.(input.workspaceId))?.defaultModel ??
        undefined;
      // A stop can end or remove this provisional state while MCP setup waits.
      if (state.ended || sessions.get(input.workspaceId) !== state) {
        return panelSnapshot(input.workspaceId);
      }
      const session = await driver.startSession({
        workspaceRoot: root,
        mode: "approval-required",
        model,
        mcp,
        onEvent: (event) => applyEvent(input.workspaceId, state, event),
      });
      state.session = session;
      if (state.ended) {
        await session.dispose().catch(() => undefined);
        return panelSnapshot(input.workspaceId);
      }
      state.status = "ready";
      const run = await options.integration.startAgentRun(input.workspaceId);
      state.runId = run.id;
      if (state.ended) {
        await options.integration.endAgentRun(
          input.workspaceId,
          run.id,
          terminalRunStatus(state),
        );
        await session.dispose().catch(() => undefined);
        return panelSnapshot(input.workspaceId);
      }
      await session.prompt({ text: input.prompt });
      if (!state.ended && state.status === "ready") state.status = "running";
    } catch (error) {
      if (state.ended || sessions.get(input.workspaceId) !== state) {
        return panelSnapshot(input.workspaceId);
      }
      state.status = "failed";
      state.ended = true;
      state.endedAt = now();
      state.lastError = bounded(error instanceof Error ? error.message : "Agent session failed.");
      if (state.runId) {
        await finalizeRun(input.workspaceId, state.runId, "failed");
      }
      await state.session?.dispose().catch((disposeError) => {
        console.error("[desktop] failed to dispose failed agent session", disposeError);
      });
    }
    return panelSnapshot(input.workspaceId);
  }

  // `runStatus` lets a caller that is ending the run with an explicit
  // outcome (endAgentRun IPC with status "failed") keep that outcome on the
  // record; omitted = derive from the session as before.
  async function stopSession(
    workspaceId: string,
    runStatus?: "complete" | "failed",
  ): Promise<AgentPanelSnapshot> {
    const state = sessions.get(workspaceId);
    if (!state) return panelSnapshot(workspaceId);
    const finalStatus = runStatus ?? terminalRunStatus(state);
    state.ended = true;
    state.endedAt = now();
    if (state.status !== "failed") state.status = "stopped";
    state.pendingPermissions = [];
    if (state.session) {
      await state.session.stop().catch(() => undefined);
      await state.session.dispose().catch(() => undefined);
    }
    if (state.runId) {
      await finalizeRun(workspaceId, state.runId, finalStatus);
    }
    return panelSnapshot(workspaceId);
  }

  async function answerPermission(input: {
    workspaceId: string;
    requestId: string;
    decision: PermissionDecision;
  }): Promise<AgentPanelSnapshot> {
    const state = sessions.get(input.workspaceId);
    if (!state?.session) throw new Error("No active agent session.");
    await state.session.answerPermission(input.requestId, input.decision);
    return panelSnapshot(input.workspaceId);
  }

  async function stopAll(): Promise<void> {
    const cleanup: Array<Promise<unknown>> = [];
    for (const [workspaceId, state] of sessions) {
      const finalStatus = terminalRunStatus(state);
      state.ended = true;
      state.endedAt ??= now();
      if (state.status !== "failed" && state.status !== "completed") state.status = "stopped";
      state.pendingPermissions = [];
      if (state.session) {
        cleanup.push(
          state.session.dispose().catch((error) => {
            console.error("[desktop] failed to dispose agent session during shutdown", error);
          }),
        );
      }
      if (state.runId) {
        cleanup.push(finalizeRun(workspaceId, state.runId, finalStatus));
      }
    }
    await Promise.all(cleanup);
    sessions.clear();
  }

  return { probeDrivers, panelSnapshot, startSession, stopSession, answerPermission, stopAll };
}

export type AgentSessionManager = ReturnType<typeof createAgentSessionManager>;
