import type {
  PluginAgentEvent,
  PluginAgentProbe,
  PluginPermissionDecision,
  PluginPermissionOption,
} from "@dohc/sdk/node";

/**
 * What the `claude` CLI says, as dohc's agent events.
 *
 * Nothing here touches a process, so every rule below is readable on its own:
 * which arguments dohc starts Claude with, which stream message becomes which
 * event, and which of Claude's own fields never leave this file.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export type ClaudeMode = "approval-required" | "auto-accept-edits" | "full-access";

/**
 * dohc's three modes as `claude --permission-mode` values.
 *
 * The values are Claude's own: `--permission-mode` accepts exactly
 * `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, and `plan`
 * (verified against claude 2.1.233). `manual` is the one that asks a person
 * about every tool it is not already allowed to run, which is what dohc's
 * `approval-required` means. It is also the default here, so a mode this
 * driver does not know asks rather than proceeds.
 */
export function claudePermissionMode(mode: ClaudeMode): string {
  if (mode === "full-access") return "bypassPermissions";
  if (mode === "auto-accept-edits") return "acceptEdits";
  return "manual";
}

export interface ClaudeMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** dohc's MCP server as the object `--mcp-config` takes inline. */
export function mcpConfigJson(mcp: ClaudeMcpServer): string {
  return JSON.stringify({
    mcpServers: {
      dohc: {
        command: mcp.command,
        args: mcp.args,
        ...(mcp.env ? { env: mcp.env } : {}),
      },
    },
  });
}

export interface ClaudeSessionSpec {
  /** A UUID dohc minted for a new session, or the cursor of one to continue. */
  sessionId: string;
  resume: boolean;
  mode: ClaudeMode;
  model?: string;
  mcp: ClaudeMcpServer;
}

/**
 * How dohc starts Claude Code: one long-lived duplex session on standard
 * streams.
 *
 * Every argument here was verified live against claude 2.1.233 on 2026-08-17:
 *
 * - `-p` with the two `stream-json` formats is a session, not one answer. It
 *   accepts a user message per turn on standard input and keeps the
 *   conversation: a second prompt to the same process read the first turn's
 *   context back out of the prompt cache.
 * - `--permission-prompt-tool stdio` is what routes a tool permission to dohc
 *   as a `can_use_tool` control request. Without it Claude answers its own
 *   permission prompt — it denies, reports `system/permission_denied`, and
 *   dohc never hears the question. This one argument is the whole permission
 *   seam.
 * - `--session-id` names a new session; `--resume` continues one this driver
 *   started before. They are alternatives, never both: `--resume` with an
 *   unknown id fails the process rather than starting a fresh session.
 * - `--verbose` is what the streaming output format requires.
 *
 * dohc's MCP server arrives additively. Claude keeps the MCP servers the user
 * configured for themselves, because `--strict-mcp-config` — which would drop
 * them — is not passed. That matches how the Codex driver injects dohc.
 */
export function claudeSessionArgs(spec: ClaudeSessionSpec): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    spec.resume ? "--resume" : "--session-id",
    spec.sessionId,
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    claudePermissionMode(spec.mode),
    ...(spec.model ? ["--model", spec.model] : []),
    "--mcp-config",
    mcpConfigJson(spec.mcp),
  ];
}

/**
 * What `claude auth status` says about the login, as a dohc probe's auth.
 *
 * dohc never reads Claude's credential files; this is the CLI's own answer to
 * the question. The account's email address is in that answer and stays here:
 * dohc has no surface that shows it, so the driver reports only whether a
 * login exists.
 */
export function claudeAuth(exitCode: number, stdout: string): PluginAgentProbe["auth"] {
  if (exitCode !== 0) {
    return {
      status: "unknown",
      label: "CLI login",
      loginHint: "Run `claude auth status` to check the Claude Code login.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return { status: "unknown", label: "CLI login" };
  }
  if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean") {
    return { status: "unknown", label: "CLI login" };
  }
  if (!parsed.loggedIn) {
    return {
      status: "unauthenticated",
      label: "CLI login",
      loginHint: "Run `claude` and log in to Claude Code.",
    };
  }
  return { status: "authenticated", label: asString(parsed.authMethod) ?? "CLI login" };
}

export function defaultPermissionOptions(): PluginPermissionOption[] {
  return [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow for session", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
}

const FILE_CHANGE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);
const PLAN_TOOLS = new Set(["TodoWrite", "ExitPlanMode"]);

type ItemType = Extract<PluginAgentEvent, { kind: "item" }>["item"]["type"];

export function itemTypeForTool(toolName: string): ItemType {
  if (toolName.startsWith("mcp__")) return "mcp_tool_call";
  if (FILE_CHANGE_TOOLS.has(toolName)) return "file_change";
  if (COMMAND_TOOLS.has(toolName)) return "command";
  if (WEB_TOOLS.has(toolName)) return "web_search";
  if (PLAN_TOOLS.has(toolName)) return "plan";
  return "tool_call";
}

type RequestType = Extract<PluginAgentEvent, { kind: "permission-request" }>["requestType"];

export function permissionTypeForTool(toolName: string): RequestType {
  if (toolName.startsWith("mcp__")) return "tool";
  if (FILE_CHANGE_TOOLS.has(toolName)) return "file-change";
  if (COMMAND_TOOLS.has(toolName)) return "command";
  if (READ_TOOLS.has(toolName)) return "file-read";
  return "tool";
}

/** The paths a tool call names, for dohc to show beside the request. */
export function toolLocations(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const path = asString(input.file_path) ?? asString(input.path) ?? asString(input.notebook_path);
  return path ? [path] : [];
}

/**
 * One `can_use_tool` control request as dohc's permission request.
 *
 * What crosses to dohc is the tool, what it says it will do, and where. The
 * rest of Claude's `input` — a file's whole new contents, a tool's arguments —
 * stays in the driver, which needs it to answer.
 *
 * A command is the exception, and it has to be: a person approving a command
 * they cannot read is not approving anything. The Codex driver shows the
 * command for the same reason.
 */
export function permissionRequestEvent(
  request: unknown,
  requestId: string,
): Extract<PluginAgentEvent, { kind: "permission-request" }> {
  const record = isRecord(request) ? request : {};
  const toolName = asString(record.tool_name) ?? "Tool";
  const requestType = permissionTypeForTool(toolName);
  const command = isRecord(record.input) ? asString(record.input.command) : undefined;
  return {
    kind: "permission-request",
    requestId,
    requestType,
    title:
      (requestType === "command" ? command : undefined) ??
      asString(record.display_name) ??
      toolName,
    detail: asString(record.description),
    locations: toolLocations(record.input),
    options: defaultPermissionOptions(),
  };
}

/**
 * The rules "Allow for session" carries back to Claude.
 *
 * Claude offers its own suggestions beside a permission request. Only the ones
 * that add an allow rule are forwarded, and only for this session: a
 * `setMode` suggestion would widen every later tool call, and a suggestion
 * bound for `localSettings` would write the user's own Claude configuration —
 * a durable change to a file dohc does not own, made from a click that said
 * "for session".
 */
export function sessionAllowRules(request: unknown): unknown[] {
  const record = isRecord(request) ? request : {};
  const suggestions = Array.isArray(record.permission_suggestions)
    ? record.permission_suggestions
    : [];
  return suggestions
    .filter(
      (suggestion): suggestion is Record<string, unknown> =>
        isRecord(suggestion) && suggestion.type === "addRules" && suggestion.behavior === "allow",
    )
    .map((suggestion) => ({ ...suggestion, destination: "session" }));
}

export interface ClaudeControlResponse {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response: Record<string, unknown>;
  };
}

/**
 * dohc's decision as the control response Claude waits for.
 *
 * An allowed tool runs with the input Claude asked about and nothing else:
 * `updatedInput` is the request's own input, never a rewrite. dohc decides
 * whether the tool runs; it does not decide what the tool does.
 */
export function permissionControlResponse(
  requestId: string,
  decision: PluginPermissionDecision,
  request: unknown,
): ClaudeControlResponse {
  const record = isRecord(request) ? request : {};
  const allow = decision === "allow_once" || decision === "allow_always";
  if (!allow) {
    return {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "deny",
          message:
            decision === "cancel" ? "dohc cancelled this request." : "dohc denied this request.",
        },
      },
    };
  }
  const rules = decision === "allow_always" ? sessionAllowRules(request) : [];
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "allow",
        updatedInput: isRecord(record.input) ? record.input : {},
        ...(rules.length > 0 ? { updatedPermissions: rules } : {}),
      },
    },
  };
}

export interface StreamMapContext {
  /** The turn dohc is waiting on, which Claude's own stream never names. */
  turnId: string;
  cancelled: boolean;
  newId(): string;
}

/**
 * One stream-json message as dohc events, or none.
 *
 * `mapStreamMessage` returns the events rather than reporting them, so what
 * Claude says and what dohc shows can be compared without a session, a
 * process, or a harness. A message with no dohc meaning returns nothing: dohc
 * shows what it understands and drops the rest, including every provider
 * payload.
 */
export function mapStreamMessage(
  message: unknown,
  ctx: StreamMapContext,
): PluginAgentEvent[] {
  if (!isRecord(message)) return [];
  const type = asString(message.type);
  if (type === "assistant") return assistantEvents(message, ctx);
  if (type === "user") return toolResultEvents(message);
  if (type === "result") return resultEvents(message, ctx);
  if (type === "rate_limit_event") {
    return [{ kind: "auth", event: "rate-limits", detail: "Claude reported its rate limits." }];
  }
  if (type === "system" && message.subtype === "permission_denied") {
    // Claude answered a permission itself, which means dohc was never asked.
    return [
      {
        kind: "error",
        message: `Claude denied ${asString(message.tool_name) ?? "a tool"} without asking dohc.`,
        fatal: false,
      },
    ];
  }
  return [];
}

function assistantEvents(message: Record<string, unknown>, ctx: StreamMapContext): PluginAgentEvent[] {
  const inner = isRecord(message.message) ? message.message : {};
  const content = Array.isArray(inner.content) ? inner.content : [];
  const messageId = asString(inner.id) ?? "assistant";
  const events: PluginAgentEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const blockType = asString(block.type);
    if (blockType === "text") {
      const text = asString(block.text);
      if (text) events.push({ kind: "text-delta", itemId: messageId, stream: "assistant", text });
      continue;
    }
    if (blockType === "thinking") {
      const text = asString(block.thinking);
      if (text) events.push({ kind: "text-delta", itemId: messageId, stream: "reasoning", text });
      continue;
    }
    if (blockType === "tool_use") {
      const toolName = asString(block.name) ?? "Tool";
      events.push({
        kind: "item",
        phase: "started",
        item: {
          id: asString(block.id) ?? ctx.newId(),
          type: itemTypeForTool(toolName),
          title: toolName,
          status: "in_progress",
          locations: toolLocations(block.input),
        },
      });
    }
  }
  return events;
}

function toolResultEvents(message: Record<string, unknown>): PluginAgentEvent[] {
  const inner = isRecord(message.message) ? message.message : {};
  const content = Array.isArray(inner.content) ? inner.content : [];
  const events: PluginAgentEvent[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const id = asString(block.tool_use_id);
    if (!id) continue;
    const failed = block.is_error === true;
    events.push({
      kind: "item",
      phase: "completed",
      item: {
        id,
        type: "tool_call",
        title: failed ? "Tool failed" : "Tool finished",
        status: failed ? "failed" : "completed",
      },
    });
  }
  return events;
}

function resultEvents(message: Record<string, unknown>, ctx: StreamMapContext): PluginAgentEvent[] {
  const events: PluginAgentEvent[] = [];
  const usage = isRecord(message.usage) ? message.usage : undefined;
  if (usage) {
    const input = Number(usage.input_tokens);
    const output = Number(usage.output_tokens);
    const used = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
    events.push({
      kind: "token-usage",
      used,
      input: Number.isFinite(input) ? input : undefined,
      output: Number.isFinite(output) ? output : undefined,
    });
  }
  const failed = message.is_error === true;
  events.push({
    kind: "turn-completed",
    turnId: ctx.turnId,
    status: ctx.cancelled ? "cancelled" : failed ? "failed" : "completed",
    errorMessage: failed ? asString(message.result) ?? asString(message.subtype) : undefined,
  });
  return events;
}

/**
 * Which of Claude's stderr lines ends the session rather than annotating it.
 *
 * A session that cannot be found is the one line the process never recovers
 * from: `--resume` with an id Claude does not know exits immediately, and
 * every later write goes to a process that is already gone.
 */
export function isFatalStderr(line: string): boolean {
  return /no conversation found with session id/i.test(line);
}
