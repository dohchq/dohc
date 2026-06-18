import type {
  AgentDriverId,
  AgentDriverRegistry,
  AgentEvent,
  AgentProbe,
  AgentSession,
  PermissionDecision,
  PermissionOption,
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
}

export interface AgentPanelSnapshot {
  drivers: AgentDriverProbeSummary[];
  session: AgentSessionSnapshot | null;
}

export interface AgentSessionManagerOptions {
  registry: AgentDriverRegistry;
  integration: AgentIntegration;
  rootFor(workspaceId: string): string | null;
  mcpFor(rootPath: string): { command: string; args: string[]; env?: Record<string, string> };
  now?: () => number;
}

interface ManagedSession extends AgentSessionSnapshot {
  session: AgentSession | null;
  ended: boolean;
}

const MAX_SNAPSHOT_MESSAGES = 200;
const MAX_SNAPSHOT_ITEMS = 200;
const MAX_SNAPSHOT_PERMISSIONS = 20;

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

export function createAgentSessionManager(options: AgentSessionManagerOptions) {
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, ManagedSession>();
  let cachedDrivers: AgentDriverProbeSummary[] | null = null;

  function endRunAfterSettle(
    workspaceId: string,
    runId: string,
    status: "complete" | "failed",
  ): void {
    const timer = setTimeout(() => {
      void options.integration.endAgentRun(workspaceId, runId, status);
    }, 750);
    timer.unref?.();
  }

  async function probeDrivers(): Promise<AgentDriverProbeSummary[]> {
    const probes = await options.registry.probeAll(process.env);
    cachedDrivers = probes.map(({ driver, probe }) => summarizeProbe(driver.id, driver.displayName, probe));
    return cachedDrivers;
  }

  function panelSnapshot(workspaceId: string): AgentPanelSnapshot {
    return {
      drivers:
        cachedDrivers ??
        options.registry.list().map((driver) => ({
          id: driver.id,
          displayName: driver.displayName,
          installed: false,
          auth: { status: "unknown" },
          models: [],
        })),
      session: snapshot(sessions.get(workspaceId) ?? null),
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
          void options.integration.endAgentRun(workspaceId, state.runId, "failed");
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
          void options.integration.endAgentRun(workspaceId, state.runId, "failed");
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
    const driver = options.registry.get(input.driverId);
    if (!driver) throw new Error(`Unknown agent driver: ${input.driverId}`);
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
      session: null,
      ended: false,
    };
    sessions.set(input.workspaceId, state);
    try {
      const session = await driver.startSession({
        workspaceRoot: root,
        mode: "approval-required",
        model: input.model,
        mcp: options.mcpFor(root),
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
      state.status = "failed";
      state.ended = true;
      state.endedAt = now();
      state.lastError = bounded(error instanceof Error ? error.message : "Agent session failed.");
      if (state.runId) {
        await options.integration.endAgentRun(input.workspaceId, state.runId, "failed");
      }
      await state.session?.dispose();
    }
    return panelSnapshot(input.workspaceId);
  }

  async function stopSession(workspaceId: string): Promise<AgentPanelSnapshot> {
    const state = sessions.get(workspaceId);
    if (!state) return panelSnapshot(workspaceId);
    state.ended = true;
    state.endedAt = now();
    state.status = "stopped";
    state.pendingPermissions = [];
    if (state.session) {
      await state.session.stop().catch(() => undefined);
      await state.session.dispose().catch(() => undefined);
    }
    if (state.runId) {
      await options.integration.endAgentRun(workspaceId, state.runId, "complete");
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

  function stopAll(): void {
    for (const [workspaceId, state] of sessions) {
      state.session?.dispose().catch(() => undefined);
      if (state.runId) {
        void options.integration.endAgentRun(workspaceId, state.runId, "complete");
      }
    }
    sessions.clear();
  }

  return { probeDrivers, panelSnapshot, startSession, stopSession, answerPermission, stopAll };
}

export type AgentSessionManager = ReturnType<typeof createAgentSessionManager>;
