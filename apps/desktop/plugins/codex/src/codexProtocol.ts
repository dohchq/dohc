import type { PluginAgentEvent, PluginPermissionDecision, PluginPermissionOption } from "@dohc/sdk/node";

/**
 * What `codex app-server` says, as dohc's agent events.
 *
 * Nothing here touches a process, so every rule below is readable on its own:
 * which sandbox a dohc mode asks Codex for, which notification becomes which
 * event, and which of Codex's own fields never leave this file.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return asString(value.text) ?? asString(value.content) ?? "";
  if (Array.isArray(value)) return value.map(textFromContent).join("");
  return "";
}

export type CodexMode = "approval-required" | "auto-accept-edits" | "full-access";

/** `SandboxMode` in the app-server protocol: `codex --sandbox`'s own values. */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** `SandboxPolicy` in the app-server protocol, which a turn may override. */
export type CodexSandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    }
  | { type: "dangerFullAccess" };

export interface CodexRuntimePolicy {
  approvalPolicy: "untrusted" | "on-request" | "never";
  threadSandbox: CodexSandboxMode;
  turnSandbox: CodexSandboxPolicy;
}

/**
 * dohc's three modes as Codex's approval policy and sandbox.
 *
 * The pairs are Codex's own: `codex --sandbox` accepts exactly the three
 * `threadSandbox` values and `codex --ask-for-approval` exactly the three
 * `approvalPolicy` values (verified against codex-cli 0.146.0). The weakest
 * mode is the default, so a mode this driver does not know asks for the
 * read-only sandbox rather than a permissive one.
 */
export function codexRuntimePolicy(mode: CodexMode, workspaceRoot: string): CodexRuntimePolicy {
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

export function codexThreadId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const thread = isRecord(value.thread) ? value.thread : undefined;
  return asString(value.threadId) ?? asString(thread?.id);
}

export function defaultPermissionOptions(): PluginPermissionOption[] {
  return [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow for session", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
}

export function codexDecision(
  decision: PluginPermissionDecision,
): "accept" | "acceptForSession" | "decline" | "cancel" {
  if (decision === "allow_once") return "accept";
  if (decision === "allow_always") return "acceptForSession";
  if (decision === "cancel") return "cancel";
  return "decline";
}

export function turnStatus(status: unknown): "completed" | "failed" | "cancelled" {
  if (status === "interrupted" || status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  return "completed";
}

/** The approval requests this driver answers. Anything else is refused. */
export const CODEX_APPROVAL_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
] as const;

export function isApprovalMethod(method: string): boolean {
  return (CODEX_APPROVAL_METHODS as readonly string[]).includes(method);
}

/**
 * Which of Codex's stderr lines ends the session rather than annotating it.
 *
 * A lost websocket is the one line Codex writes that its own process never
 * recovers from, so it is the one that arrives fatal.
 */
export function isFatalStderr(line: string): boolean {
  return /failed to connect to websocket/i.test(line);
}

export function approvalRequest(
  method: string,
  params: unknown,
  requestId: string,
): Extract<PluginAgentEvent, { kind: "permission-request" }> {
  const record = isRecord(params) ? params : {};
  const fileChange = method.includes("fileChange");
  return {
    kind: "permission-request",
    requestId,
    requestType: fileChange ? "file-change" : "command",
    title: asString(record.command) ?? (fileChange ? "File change" : "Command"),
    detail: asString(record.reason),
    locations: asStringArray(record.locations),
    options: defaultPermissionOptions(),
  };
}

/** The id Codex gave this approval, or nothing when it named none. */
export function approvalRequestId(params: unknown): string | undefined {
  const record = isRecord(params) ? params : {};
  return asString(record.approvalId) ?? asString(record.itemId) ?? asString(record.requestId);
}

/**
 * One app-server notification as one dohc event, or nothing.
 *
 * `mapNotification` returns the event rather than reporting it, so what Codex
 * says and what dohc shows can be compared without a session, a process, or a
 * harness. A notification with no dohc meaning returns null: dohc shows what
 * it understands and drops the rest, including every provider payload.
 */
export function mapNotification(
  method: string,
  params: unknown,
  newId: () => string,
): PluginAgentEvent | null {
  const record = isRecord(params) ? params : {};
  if (method === "item/agentMessage/delta") {
    return {
      kind: "text-delta",
      itemId: asString(record.itemId) ?? "assistant",
      stream: "assistant",
      text: textFromContent(record.delta ?? record.text),
    };
  }
  if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
    return {
      kind: "text-delta",
      itemId: asString(record.itemId) ?? "reasoning",
      stream: "reasoning",
      text: textFromContent(record.delta ?? record.text),
    };
  }
  if (method === "item/started" || method === "item/completed") {
    const item = isRecord(record.item) ? record.item : record;
    const type = asString(item.type);
    return {
      kind: "item",
      phase: method === "item/started" ? "started" : "completed",
      item: {
        id: asString(item.id) ?? asString(record.itemId) ?? newId(),
        type: type === "file_change" ? "file_change" : type === "command" ? "command" : "other",
        title: asString(item.title) ?? asString(item.command) ?? asString(item.type) ?? "Agent item",
        detail: asString(item.detail),
        status: method === "item/completed" ? "completed" : "in_progress",
        locations: asStringArray(item.locations),
      },
    };
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = isRecord(record.usage) && isRecord(record.usage.total) ? record.usage.total : record;
    const total = Number(usage.totalTokens);
    return {
      kind: "token-usage",
      used: Number.isFinite(total) ? total : 0,
      input: Number(usage.inputTokens) || undefined,
      output: Number(usage.outputTokens) || undefined,
    };
  }
  if (method === "turn/completed") {
    const turn = isRecord(record.turn) ? record.turn : record;
    return {
      kind: "turn-completed",
      turnId: asString(turn.id) ?? asString(record.turnId) ?? newId(),
      status: turnStatus(turn.status),
      errorMessage: asString(turn.error),
    };
  }
  if (method === "account/rateLimits/updated") {
    return { kind: "auth", event: "rate-limits", detail: "Rate limits updated." };
  }
  if (method === "mcpServer/oauthLogin/completed") {
    return { kind: "auth", event: "mcp-oauth-completed", detail: "MCP OAuth completed." };
  }
  if (method === "error") {
    const error = isRecord(record.error) ? record.error : record;
    return {
      kind: "error",
      message: asString(error.message) ?? "Codex app-server error.",
      fatal: record.willRetry !== true,
    };
  }
  return null;
}
