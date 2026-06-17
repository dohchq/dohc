import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AgentDriver,
  AgentEvent,
  AgentModel,
  AgentProbe,
  AgentSession,
  AgentSessionStartInput,
  PermissionDecision,
  PermissionOption,
} from "./AgentDriver";
import { selectPermissionOption } from "./AgentDriver";
import { JsonRpcError, JsonRpcTransport, resolveSpawnCommand } from "./JsonRpcTransport";

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

function mcpServers(input: AgentSessionStartInput): Array<{ name: string; command: string; args: string[] }> {
  return [{ name: "dohc", command: input.mcp.command, args: input.mcp.args }];
}

type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexSandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    }
  | { type: "dangerFullAccess" };

function codexRuntimePolicy(mode: AgentSessionStartInput["mode"], workspaceRoot: string): {
  approvalPolicy: "untrusted" | "on-request" | "never";
  threadSandbox: CodexSandboxMode;
  turnSandbox: CodexSandboxPolicy;
} {
  if (mode === "full-access") {
    return {
      approvalPolicy: "never",
      threadSandbox: "danger-full-access",
      turnSandbox: { type: "dangerFullAccess" },
    };
  }
  if (mode === "auto-accept-edits") {
    return {
      approvalPolicy: "on-request",
      threadSandbox: "workspace-write",
      turnSandbox: {
        type: "workspaceWrite",
        writableRoots: [workspaceRoot],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    };
  }
  return {
    approvalPolicy: "untrusted",
    threadSandbox: "read-only",
    turnSandbox: { type: "readOnly", networkAccess: false },
  };
}

function codexThreadId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const thread = isRecord(value.thread) ? value.thread : undefined;
  return asString(value.threadId) ?? asString(thread?.id);
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

function defaultPermissionOptions(): PermissionOption[] {
  return [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow for session", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
}

function eventMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function codexDecision(decision: PermissionDecision): "accept" | "acceptForSession" | "decline" | "cancel" {
  if (decision === "allow_once") return "accept";
  if (decision === "allow_always") return "acceptForSession";
  if (decision === "cancel") return "cancel";
  return "decline";
}

function turnStatus(status: unknown): "completed" | "failed" | "cancelled" {
  if (status === "interrupted" || status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  return "completed";
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
    this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.transport.dispose();
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
      transport.dispose();
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

class CodexSession implements AgentSession {
  readonly sessionId: string;
  readonly resumeCursor: unknown;
  private readonly pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  private activeTurnId: string | null = null;
  private disposed = false;

  constructor(
    private readonly transport: JsonRpcTransport,
    threadId: string,
    private readonly input: AgentSessionStartInput,
  ) {
    this.sessionId = threadId;
    this.resumeCursor = threadId;
  }

  async prompt(input: { text: string }): Promise<{ turnId: string }> {
    this.input.onEvent({ kind: "session-state", state: "running" });
    const policy = codexRuntimePolicy(this.input.mode, this.input.workspaceRoot);
    const response = await this.transport.request("turn/start", {
      threadId: this.sessionId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.turnSandbox,
    });
    const turn = isRecord(response) && isRecord(response.turn) ? response.turn : response;
    const turnId = isRecord(turn) ? asString(turn.id) ?? randomUUID() : randomUUID();
    this.activeTurnId = turnId;
    return { turnId };
  }

  async cancel(): Promise<void> {
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    if (turnId) {
      await this.transport
        .request("turn/interrupt", { threadId: this.sessionId, turnId })
        .catch(() => undefined);
    }
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
    this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.transport.dispose();
  }

  requestApproval(method: string, params: unknown): Promise<unknown> {
    const record = isRecord(params) ? params : {};
    const requestId =
      asString(record.approvalId) ??
      asString(record.itemId) ??
      asString(record.requestId) ??
      randomUUID();
    const event: Extract<AgentEvent, { kind: "permission-request" }> = {
      kind: "permission-request",
      requestId,
      requestType: method.includes("fileChange") ? "file-change" : "command",
      title: asString(record.command) ?? (method.includes("fileChange") ? "File change" : "Command"),
      detail: asString(record.reason),
      locations: asStringArray(record.locations),
      options: defaultPermissionOptions(),
    };
    const policyDecision = this.input.permissionPolicy?.(event);
    this.input.onEvent(event);
    return new Promise((resolve) => {
      const settle = (decision: PermissionDecision) => {
        this.input.onEvent({ kind: "permission-resolved", requestId, decision });
        resolve({ decision: codexDecision(decision) });
      };
      if (policyDecision) {
        settle(policyDecision);
        return;
      }
      this.pendingPermissions.set(requestId, settle);
    });
  }
}

class CodexAppServerDriver implements AgentDriver {
  readonly id = "codex-app-server";
  readonly displayName = "Codex";

  constructor(private readonly spec: ProcessSpec) {}

  async probe(): Promise<AgentProbe> {
    const result = await probeCommand(this.spec);
    return {
      ...probeResult(result.installed, result.version, result.errorMessage),
      models: result.installed ? [{ id: "default", name: "Default", planIncluded: true }] : [],
    };
  }

  async startSession(input: AgentSessionStartInput): Promise<AgentSession> {
    input.onEvent({ kind: "session-state", state: "starting" });
    let session: CodexSession | null = null;
    let threadId: string | null = null;
    const transport = JsonRpcTransport.spawn({
      command: this.spec.command,
      args: [...this.spec.args, ...this.spec.launchArgs],
      cwd: input.workspaceRoot,
      label: this.displayName,
      onNotification: (method, params) => {
        if (method === "thread/started") threadId = codexThreadId(params) ?? threadId;
        this.mapNotification(method, params, input.onEvent);
      },
      onRequest: (method, params) => {
        if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval" ||
          method === "applyPatchApproval" ||
          method === "execCommandApproval"
        ) {
          if (!session) throw new Error("Codex session is not ready.");
          return session.requestApproval(method, params);
        }
        if (method === "item/tool/requestUserInput") {
          input.onEvent({
            kind: "error",
            message: "Codex requested user input, which dohc does not support yet; the request was cancelled.",
            fatal: false,
          });
          throw new JsonRpcError(-32000, "Codex user input requests are not supported by dohc yet.");
        }
        if (method === "account/chatgptAuthTokens/refresh") {
          input.onEvent({
            kind: "auth",
            event: "login-required",
            detail: "Codex CLI manages ChatGPT token refresh.",
          });
          throw new JsonRpcError(-32601, "ChatGPT token refresh is managed by the Codex CLI login.");
        }
        throw new JsonRpcError(-32601, `Method not found: ${method}`);
      },
      onStderr: (line) => {
        const fatal = /failed to connect to websocket/i.test(line);
        input.onEvent({ kind: "error", message: line, fatal });
      },
      onExit: () => input.onEvent({ kind: "session-state", state: "closed" }),
    });
    try {
      await transport.request("initialize", {
        clientInfo: { name: "dohc", title: "dohc", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      transport.notify("initialized", {});
      const policy = codexRuntimePolicy(input.mode, input.workspaceRoot);
      const started = await transport.request("thread/start", {
        cwd: input.workspaceRoot,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.threadSandbox,
        config: {
          mcp_servers: {
            dohc: { command: input.mcp.command, args: input.mcp.args },
          },
        },
      });
      threadId = codexThreadId(started) ?? threadId;
      session = new CodexSession(transport, threadId ?? randomUUID(), input);
      input.onEvent({ kind: "session-state", state: "ready" });
      return session;
    } catch (error) {
      transport.dispose();
      throw error;
    }
  }

  private mapNotification(method: string, params: unknown, onEvent: (event: AgentEvent) => void): void {
    const record = isRecord(params) ? params : {};
    if (method === "item/agentMessage/delta") {
      onEvent({
        kind: "text-delta",
        itemId: asString(record.itemId) ?? "assistant",
        stream: "assistant",
        text: textFromContent(record.delta ?? record.text),
      });
      return;
    }
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      onEvent({
        kind: "text-delta",
        itemId: asString(record.itemId) ?? "reasoning",
        stream: "reasoning",
        text: textFromContent(record.delta ?? record.text),
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = isRecord(record.item) ? record.item : record;
      onEvent({
        kind: "item",
        phase: method === "item/started" ? "started" : "completed",
        item: {
          id: asString(item.id) ?? asString(record.itemId) ?? randomUUID(),
          type: asString(item.type) === "file_change" ? "file_change" : asString(item.type) === "command" ? "command" : "other",
          title: asString(item.title) ?? asString(item.command) ?? asString(item.type) ?? "Agent item",
          detail: asString(item.detail),
          status: method === "item/completed" ? "completed" : "in_progress",
          locations: asStringArray(item.locations),
        },
      });
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = isRecord(record.usage) && isRecord(record.usage.total) ? record.usage.total : record;
      const total = Number(usage.totalTokens);
      onEvent({
        kind: "token-usage",
        used: Number.isFinite(total) ? total : 0,
        input: Number(usage.inputTokens) || undefined,
        output: Number(usage.outputTokens) || undefined,
      });
      return;
    }
    if (method === "turn/completed") {
      const turn = isRecord(record.turn) ? record.turn : record;
      onEvent({
        kind: "turn-completed",
        turnId: asString(turn.id) ?? asString(record.turnId) ?? randomUUID(),
        status: turnStatus(turn.status),
        errorMessage: asString(turn.error),
      });
      return;
    }
    if (method === "account/rateLimits/updated") {
      onEvent({ kind: "auth", event: "rate-limits", detail: "Rate limits updated." });
      return;
    }
    if (method === "mcpServer/oauthLogin/completed") {
      onEvent({ kind: "auth", event: "mcp-oauth-completed", detail: "MCP OAuth completed." });
      return;
    }
    if (method === "error") {
      const error = isRecord(record.error) ? record.error : record;
      onEvent({
        kind: "error",
        message: asString(error.message) ?? "Codex app-server error.",
        fatal: record.willRetry !== true,
      });
    }
  }
}

export function createDesktopAgentDrivers(env: Record<string, string | undefined> = process.env): AgentDriver[] {
  return [
    new CodexAppServerDriver(processSpec(env, "CODEX", "codex", ["app-server"])),
    new AcpAgentDriver("claude-acp", "Claude", processSpec(env, "CLAUDE_ACP", "claude-code-acp")),
    new AcpAgentDriver("generic-acp", "Generic ACP", processSpec(env, "GENERIC_ACP", "agent")),
  ];
}
