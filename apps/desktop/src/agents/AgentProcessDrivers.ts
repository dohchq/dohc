import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AgentDriver,
  AgentEvent,
  AgentProbe,
  AgentSession,
  AgentSessionStartInput,
  PermissionDecision,
  PermissionOption,
} from "./AgentDriver";
import { selectPermissionOption } from "./AgentDriver";
import { JsonRpcError, JsonRpcTransport } from "./JsonRpcTransport";
import { resolveSpawnCommand } from "../process/windowsSpawn";

interface ProcessSpec {
  command: string;
  args: string[];
  versionArgs: string[];
  launchArgs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseArgs(env: Record<string, string | undefined>, key: string): string[] {
  const raw = env[key]?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asStringArray(parsed);
  } catch {
    return raw.split(" ").filter(Boolean);
  }
}

function processSpec(
  env: Record<string, string | undefined>,
  prefix: string,
  fallbackCommand: string,
  launchArgs: string[] = [],
): ProcessSpec {
  const command = env[`DOHC_AGENT_${prefix}_COMMAND`]?.trim() || fallbackCommand;
  const args = parseArgs(env, `DOHC_AGENT_${prefix}_ARGS_JSON`);
  return { command, args, versionArgs: ["--version"], launchArgs };
}

async function probeCommand(spec: ProcessSpec): Promise<{ installed: boolean; version?: string; errorMessage?: string }> {
  return new Promise((resolve) => {
    const resolved = resolveSpawnCommand(spec.command, [...spec.args, ...spec.versionArgs]);
    const child = spawn(resolved.command, resolved.args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ installed: false, errorMessage: "Probe timed out." });
    }, 3000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ installed: false, errorMessage: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ installed: true, version: (stdout || stderr).trim().split(/\r?\n/)[0] || undefined });
      } else {
        resolve({ installed: false, errorMessage: (stderr || stdout).trim().slice(0, 300) || "Probe failed." });
      }
    });
  });
}

function probeResult(installed: boolean, version?: string, errorMessage?: string): AgentProbe {
  return {
    installed,
    version,
    auth: installed
      ? { status: "unknown", label: "CLI login" }
      : { status: "unknown", loginHint: "Install and log in with the provider CLI." },
    models: [],
    errorMessage,
  };
}

function mcpServers(
  input: AgentSessionStartInput,
): Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }> {
  return [
    {
      name: "dohc",
      command: input.mcp.command,
      args: input.mcp.args,
      ...(input.mcp.env ? { env: input.mcp.env } : {}),
    },
  ];
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return asString(value.text) ?? asString(value.content) ?? "";
  if (Array.isArray(value)) return value.map(textFromContent).join("");
  return "";
}

function normalizePermissionOptions(options: unknown): PermissionOption[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option): PermissionOption[] => {
    if (!isRecord(option)) return [];
    const optionId = asString(option.optionId);
    const name = asString(option.name);
    const kind = asString(option.kind);
    if (
      !optionId ||
      !name ||
      (kind !== "allow_once" &&
        kind !== "allow_always" &&
        kind !== "reject_once" &&
        kind !== "reject_always")
    ) {
      return [];
    }
    return [{ optionId, name, kind }];
  });
}

function eventMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

class AcpSession implements AgentSession {
  readonly sessionId: string;
  readonly resumeCursor: unknown;
  private readonly pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  private disposed = false;

  constructor(
    private readonly transport: JsonRpcTransport,
    sessionId: string,
    private readonly input: AgentSessionStartInput,
  ) {
    this.sessionId = sessionId;
    this.resumeCursor = sessionId;
  }

  prompt(input: { text: string }): Promise<{ turnId: string }> {
    const turnId = randomUUID();
    this.input.onEvent({ kind: "session-state", state: "running" });
    void this.transport
      .request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: input.text }],
      })
      .then((result) => {
        const stopReason = isRecord(result) ? asString(result.stopReason) : undefined;
        this.input.onEvent({
          kind: "turn-completed",
          turnId,
          status: stopReason === "cancelled" ? "cancelled" : "completed",
        });
      })
      .catch((error) => {
        this.input.onEvent({
          kind: "turn-completed",
          turnId,
          status: "failed",
          errorMessage: eventMessage(error, "ACP prompt failed."),
        });
      });
    return Promise.resolve({ turnId });
  }

  async cancel(): Promise<void> {
    this.transport.notify("session/cancel", { sessionId: this.sessionId });
    for (const resolve of this.pendingPermissions.values()) resolve("cancel");
    this.pendingPermissions.clear();
  }

  async answerPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) throw new Error(`Unknown permission request: ${requestId}`);
    this.pendingPermissions.delete(requestId);
    resolve(decision);
  }

  async stop(): Promise<void> {
    await this.cancel();
    this.transport.notify("session/close", { sessionId: this.sessionId });
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.transport.dispose();
  }

  requestPermission(params: unknown): Promise<unknown> {
    const record = isRecord(params) ? params : {};
    const toolCall = isRecord(record.toolCall) ? record.toolCall : {};
    const requestId =
      asString(record.requestId) ??
      asString(toolCall.toolCallId) ??
      asString(toolCall.id) ??
      randomUUID();
    const options = normalizePermissionOptions(record.options);
    const event: Extract<AgentEvent, { kind: "permission-request" }> = {
      kind: "permission-request",
      requestId,
      requestType: "tool",
      title: asString(toolCall.title) ?? asString(toolCall.kind) ?? "Tool request",
      detail: asString(toolCall.kind),
      locations: asStringArray(toolCall.locations),
      options,
      raw: undefined,
    };
    const policyDecision = this.input.permissionPolicy?.(event);
    this.input.onEvent(event);
    return new Promise((resolve) => {
      const settle = (decision: PermissionDecision) => {
        this.input.onEvent({ kind: "permission-resolved", requestId, decision });
        const option = selectPermissionOption(options, decision);
        resolve(
          option
            ? { outcome: { outcome: "selected", optionId: option.optionId } }
            : { outcome: { outcome: "cancelled" } },
        );
      };
      if (policyDecision) {
        settle(policyDecision);
        return;
      }
      this.pendingPermissions.set(requestId, settle);
    });
  }
}

class AcpAgentDriver implements AgentDriver {
  constructor(
    readonly id: "claude-acp" | "generic-acp",
    readonly displayName: string,
    private readonly spec: ProcessSpec,
  ) {}

  async probe(): Promise<AgentProbe> {
    const result = await probeCommand(this.spec);
    return probeResult(result.installed, result.version, result.errorMessage);
  }

  async startSession(input: AgentSessionStartInput): Promise<AgentSession> {
    input.onEvent({ kind: "session-state", state: "starting" });
    let session: AcpSession | null = null;
    const transport = JsonRpcTransport.spawn({
      command: this.spec.command,
      args: [...this.spec.args, ...this.spec.launchArgs],
      cwd: input.workspaceRoot,
      label: this.displayName,
      onNotification: (method, params) => {
        if (method === "session/update") this.mapUpdate(params, input.onEvent);
      },
      onRequest: (method, params) => {
        if (method === "session/request_permission") {
          if (!session) throw new Error("ACP session is not ready.");
          return session.requestPermission(params);
        }
        throw new JsonRpcError(-32601, `Method not found: ${method}`);
      },
      onStderr: (line) => input.onEvent({ kind: "error", message: line, fatal: false }),
      onExit: () => input.onEvent({ kind: "session-state", state: "closed" }),
    });
    try {
      await transport.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "dohc", title: "dohc", version: "0.1.0" },
      });
      const opened = await transport.request("session/new", {
        cwd: input.workspaceRoot,
        mcpServers: mcpServers(input),
      });
      const sessionId = isRecord(opened) ? asString(opened.sessionId) ?? randomUUID() : randomUUID();
      session = new AcpSession(transport, sessionId, input);
      input.onEvent({ kind: "session-state", state: "ready" });
      return session;
    } catch (error) {
      await transport.dispose();
      throw error;
    }
  }

  private mapUpdate(params: unknown, onEvent: (event: AgentEvent) => void): void {
    const record = isRecord(params) ? params : {};
    const updateSource = isRecord(record.update) ? record.update : record;
    const update = isRecord(updateSource.sessionUpdate) ? updateSource.sessionUpdate : updateSource;
    const type = asString(update.type) ?? asString(update.kind);
    if (type === "agent_message_chunk" || type === "assistant_message_chunk") {
      onEvent({
        kind: "text-delta",
        itemId: asString(update.itemId) ?? "assistant",
        stream: "assistant",
        text: textFromContent(update.content ?? update.text),
      });
      return;
    }
    if (type === "agent_thought_chunk") {
      onEvent({
        kind: "text-delta",
        itemId: asString(update.itemId) ?? "reasoning",
        stream: "reasoning",
        text: textFromContent(update.content ?? update.text),
      });
      return;
    }
    if (type === "tool_call" || type === "tool_call_update") {
      const status = asString(update.status) === "completed" ? "completed" : asString(update.status) === "failed" ? "failed" : "in_progress";
      onEvent({
        kind: "item",
        phase: type === "tool_call" ? "started" : status === "completed" || status === "failed" ? "completed" : "updated",
        item: {
          id: asString(update.toolCallId) ?? asString(update.id) ?? randomUUID(),
          type: "tool_call",
          title: asString(update.title) ?? asString(update.kind) ?? "Tool call",
          detail: textFromContent(update.content),
          status,
          locations: asStringArray(update.locations),
        },
      });
      return;
    }
    if (type === "usage_update" && isRecord(update.usage)) {
      const total = Number(update.usage.totalTokens);
      onEvent({
        kind: "token-usage",
        used: Number.isFinite(total) ? total : 0,
        input: Number(update.usage.inputTokens) || undefined,
        output: Number(update.usage.outputTokens) || undefined,
      });
    }
  }
}

export function createDesktopAgentDrivers(env: Record<string, string | undefined> = process.env): AgentDriver[] {
  return [
    new AcpAgentDriver("claude-acp", "Claude", processSpec(env, "CLAUDE_ACP", "claude-code-acp")),
    new AcpAgentDriver("generic-acp", "Generic ACP", processSpec(env, "GENERIC_ACP", "agent")),
  ];
}
