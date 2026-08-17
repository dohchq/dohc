export type AgentDriverId = "claude-acp" | "generic-acp" | (string & {});

/**
 * The driver ids dohc ships. A plugin may not take one, and the plugin driver
 * registry refuses one that tries (pluginAgentDrivers.ts).
 *
 * Codex is not here: it left this process for `apps/desktop/plugins/codex`,
 * and the id it holds now is a plugin's to take like any other.
 */
export const BUILT_IN_AGENT_DRIVER_IDS = ["claude-acp", "generic-acp"] as const;

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type PermissionDecision = PermissionOption["kind"] | "cancel";

// In-process adapter events. `raw` and provider-shaped details may contain
// sensitive tool/provider payloads; future IPC/log/persistence consumers must
// drop or redact them and render only normalized fields by default.
export type AgentEvent =
  | {
      kind: "session-state";
      state: "starting" | "ready" | "running" | "error" | "closed";
      reason?: string;
    }
  | { kind: "text-delta"; itemId: string; stream: "assistant" | "reasoning"; text: string }
  | {
      kind: "item";
      phase: "started" | "updated" | "completed";
      item: {
        id: string;
        type: "tool_call" | "command" | "file_change" | "mcp_tool_call" | "web_search" | "plan" | "other";
        title: string;
        detail?: string;
        status: "pending" | "in_progress" | "completed" | "failed";
        locations?: string[];
        raw?: unknown;
      };
    }
  | { kind: "plan"; steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> }
  | {
      kind: "permission-request";
      requestId: string;
      requestType: "command" | "file-change" | "file-read" | "tool" | "other";
      title: string;
      detail?: string;
      locations?: string[];
      options: PermissionOption[];
      raw?: unknown;
    }
  | { kind: "permission-resolved"; requestId: string; decision: PermissionDecision }
  | { kind: "token-usage"; used: number; max?: number; input?: number; output?: number }
  | {
      kind: "turn-completed";
      turnId: string;
      status: "completed" | "failed" | "cancelled";
      errorMessage?: string;
    }
  | {
      kind: "auth";
      event: "account-updated" | "rate-limits" | "mcp-oauth-completed" | "login-required";
      detail?: unknown;
    }
  | { kind: "error"; message: string; fatal: boolean };

export interface AgentModel {
  id: string;
  name: string;
  planIncluded: boolean;
  options?: Array<{ id: "effort" | "contextWindow" | string; values: string[]; default?: string }>;
}

// In-process probe result. `auth.email`/`loginHint` are PII and must not cross
// into renderer IPC, logs, or persisted state without explicit redaction.
export interface AgentProbe {
  installed: boolean;
  version?: string;
  auth: {
    status: "authenticated" | "unauthenticated" | "unknown";
    label?: string;
    email?: string;
    loginHint?: string;
  };
  models: AgentModel[];
  errorMessage?: string;
}

// Main-owned session start contract. Renderer callers never supply these
// values directly: workspaceRoot/logDir must be canonical, containment-checked
// absolute paths, and mcp.command/args must come from trusted main-owned
// config/packaged adapter code. Drivers that spawn a process must pass
// command/args as argv without shell interpolation.
export interface AgentSessionStartInput {
  workspaceRoot: string;
  mode: "approval-required" | "auto-accept-edits" | "full-access";
  model?: string;
  resumeCursor?: unknown;
  mcp: { command: string; args: string[]; env?: Record<string, string> };
  onEvent: (event: AgentEvent) => void;
  permissionPolicy?: (event: Extract<AgentEvent, { kind: "permission-request" }>) => PermissionDecision | null;
  logDir?: string;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly resumeCursor: unknown;
  prompt(input: {
    text: string;
    attachments?: Array<{ type: "image"; pathOrUrl: string }>;
  }): Promise<{ turnId: string }>;
  cancel(): Promise<void>;
  answerPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  answerUserInput?(requestId: string, answers: Record<string, string | string[]>): Promise<void>;
  setModel?(modelId: string): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentDriver {
  readonly id: AgentDriverId;
  readonly displayName: string;
  probe(env?: Record<string, string | undefined>): Promise<AgentProbe>;
  startSession(input: AgentSessionStartInput): Promise<AgentSession>;
}

export function selectPermissionOption(
  options: PermissionOption[],
  decision: PermissionDecision,
): PermissionOption | null {
  if (decision === "cancel") return null;
  return options.find((option) => option.kind === decision) ?? null;
}

export function createAgentDriverRegistry(drivers: AgentDriver[]) {
  const byId = new Map<AgentDriverId, AgentDriver>();
  for (const driver of drivers) {
    if (byId.has(driver.id)) {
      throw new Error(`Duplicate agent driver id: ${driver.id}`);
    }
    byId.set(driver.id, driver);
  }

  return {
    list(): AgentDriver[] {
      return [...drivers];
    },
    get(id: AgentDriverId): AgentDriver | null {
      return byId.get(id) ?? null;
    },
    async probeAll(env?: Record<string, string | undefined>): Promise<
      Array<{ driver: AgentDriver; probe: AgentProbe }>
    > {
      return Promise.all(
        drivers.map(async (driver) => {
          try {
            return { driver, probe: await driver.probe(env) };
          } catch (error) {
            return {
              driver,
              probe: {
                installed: false,
                auth: { status: "unknown" },
                models: [],
                errorMessage: error instanceof Error ? error.message : "Agent probe failed.",
              },
            };
          }
        }),
      );
    },
  };
}

export type AgentDriverRegistry = ReturnType<typeof createAgentDriverRegistry>;
