import { randomUUID } from "node:crypto";
import type {
  PluginActivateContext,
  PluginAgentDriver,
  PluginAgentProbe,
  PluginAgentSession,
  PluginAgentSessionStartInput,
  PluginPermissionDecision,
} from "@dohc/sdk/node";
import {
  approvalRequest,
  approvalRequestId,
  codexDecision,
  codexRuntimePolicy,
  codexThreadId,
  isApprovalMethod,
  isFatalStderr,
  isRecord,
  asString,
  mapNotification,
} from "./codexProtocol.ts";
import { CommandJsonRpc, JsonRpcError } from "./jsonRpc.ts";

/** How long `codex --version` has to answer before the probe calls it absent. */
export const PROBE_TIMEOUT_MS = 3000;

/** What a failed probe reports back, cut to what the driver list shows. */
const MAX_PROBE_ERROR_CHARS = 300;

export interface CodexCommandSpec {
  command: string;
  args: string[];
}

/**
 * Where the `codex` command is, and what to pass it.
 *
 * The two overrides are the same ones dohc's built-in driver read before this
 * plugin existed: they point the driver at another build of Codex, or at a
 * stand-in, without changing the plugin.
 */
export function codexCommandSpec(env: Record<string, string | undefined>): CodexCommandSpec {
  const command = env.DOHC_AGENT_CODEX_COMMAND?.trim() || "codex";
  const raw = env.DOHC_AGENT_CODEX_ARGS_JSON?.trim();
  if (!raw) return { command, args: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    const args = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
    return { command, args };
  } catch {
    return { command, args: raw.split(" ").filter(Boolean) };
  }
}

type SpawnCommand = PluginActivateContext["childProcesses"]["spawnCommand"];

class CodexSession implements PluginAgentSession {
  readonly sessionId: string;
  readonly resumeCursor: string;
  private readonly pendingPermissions = new Map<string, (decision: PluginPermissionDecision) => void>();
  private activeTurnId: string | null = null;
  private disposed = false;

  constructor(
    private readonly transport: CommandJsonRpc,
    threadId: string,
    private readonly input: PluginAgentSessionStartInput,
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

  async answerPermission(requestId: string, decision: PluginPermissionDecision): Promise<void> {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) throw new Error(`Unknown permission request: ${requestId}`);
    this.pendingPermissions.delete(requestId);
    resolve(decision);
  }

  async stop(): Promise<void> {
    await this.cancel();
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.transport.dispose();
  }

  /**
   * Codex asked to run something. dohc decides, and Codex waits for the
   * answer: this promise settles when a policy answers straight away, or when
   * a person answers through `answerPermission`.
   */
  requestApproval(method: string, params: unknown): Promise<unknown> {
    const requestId = approvalRequestId(params) ?? randomUUID();
    const event = approvalRequest(method, params, requestId);
    this.input.onEvent(event);
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, (decision) => {
        this.input.onEvent({ kind: "permission-resolved", requestId, decision });
        resolve({ decision: codexDecision(decision) });
      });
    });
  }
}

export function createCodexDriver(
  spawnCommand: SpawnCommand,
  spec: CodexCommandSpec,
): PluginAgentDriver {
  async function probe(): Promise<PluginAgentProbe> {
    let child: Awaited<ReturnType<SpawnCommand>>;
    try {
      child = await spawnCommand({
        command: spec.command,
        args: [...spec.args, "--version"],
        cwd: { workspaceRoot: true },
      });
    } catch (error) {
      return absent(error instanceof Error ? error.message : "Probe failed.");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([child.wait(), timedOut]);
      if (result === "timeout") return absent("Probe timed out.");
      const logs = await child.logs();
      const stdout = logs.filter((line) => line.stream === "stdout").map((line) => line.text).join("");
      const stderr = logs.filter((line) => line.stream === "stderr").map((line) => line.text).join("");
      if (result.code !== 0) {
        return absent((stderr || stdout).trim().slice(0, MAX_PROBE_ERROR_CHARS) || "Probe failed.");
      }
      return {
        installed: true,
        version: (stdout || stderr).trim().split(/\r?\n/)[0] || undefined,
        auth: { status: "unknown", label: "CLI login" },
        models: [{ id: "default", name: "Default", planIncluded: true }],
      };
    } finally {
      if (timer) clearTimeout(timer);
      await child.terminate().catch(() => undefined);
    }
  }

  async function startSession(input: PluginAgentSessionStartInput): Promise<PluginAgentSession> {
    input.onEvent({ kind: "session-state", state: "starting" });
    let session: CodexSession | null = null;
    let threadId: string | null = null;
    let child: Awaited<ReturnType<SpawnCommand>>;
    try {
      child = await spawnCommand({
        command: spec.command,
        args: [...spec.args, "app-server"],
        cwd: { workspaceRoot: true },
      });
    } catch (error) {
      // This session reported "starting"; a session that never started has to
      // report an end, or a surface waits on it forever.
      input.onEvent({ kind: "session-state", state: "closed" });
      throw error;
    }
    const transport = await CommandJsonRpc.attach(child, {
      label: "Codex",
      onNotification: (method, params) => {
        if (method === "thread/started") threadId = codexThreadId(params) ?? threadId;
        const event = mapNotification(method, params, randomUUID);
        if (event) input.onEvent(event);
      },
      onRequest: (method, params) => {
        if (isApprovalMethod(method)) {
          if (!session) throw new Error("Codex session is not ready.");
          return session.requestApproval(method, params);
        }
        if (method === "item/tool/requestUserInput") {
          input.onEvent({
            kind: "error",
            message:
              "Codex requested user input, which dohc does not support yet; the request was cancelled.",
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
      onStderr: (line) => input.onEvent({ kind: "error", message: line, fatal: isFatalStderr(line) }),
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
            dohc: {
              command: input.mcp.command,
              args: input.mcp.args,
              ...(input.mcp.env ? { env: input.mcp.env } : {}),
            },
          },
        },
      });
      threadId = codexThreadId(started) ?? threadId;
      session = new CodexSession(transport, threadId ?? randomUUID(), input);
      input.onEvent({ kind: "session-state", state: "ready" });
      return session;
    } catch (error) {
      await transport.dispose();
      throw error;
    }
  }

  return { probe, startSession };
}

function absent(errorMessage: string): PluginAgentProbe {
  return {
    installed: false,
    auth: { status: "unknown", loginHint: "Install and log in with the provider CLI." },
    models: [],
    errorMessage,
  };
}
