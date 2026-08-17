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
  asString,
  claudeAuth,
  claudeSessionArgs,
  isFatalStderr,
  isRecord,
  mapStreamMessage,
  permissionControlResponse,
  permissionRequestEvent,
} from "./claudeProtocol.ts";
import { ClaudeStream } from "./streamJson.ts";

/** How long a one-shot `claude` command has to answer a probe. */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * How long Claude has to answer the handshake before the session gives up.
 *
 * Measured: the real `claude` answers in about one second on this machine,
 * cold, with no prompt sent. Twenty seconds leaves a slow start — a cold disk,
 * a machine under load, a long MCP server list — far more room than it needs,
 * and `DOHC_AGENT_CLAUDE_CODE_READY_TIMEOUT_MS` moves it for a machine where
 * that is still not enough.
 */
export const READY_TIMEOUT_MS = 20_000;

/** The handshake deadline this machine wants, in milliseconds. */
export function readyTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.DOHC_AGENT_CLAUDE_CODE_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : READY_TIMEOUT_MS;
}

/** What a failed probe reports back, cut to what the driver list shows. */
const MAX_PROBE_ERROR_CHARS = 300;

/** The id dohc's readiness handshake carries, which is never a Claude id. */
const HANDSHAKE_ID = "dohc-initialize";

export interface ClaudeCommandSpec {
  command: string;
  args: string[];
}

/**
 * Where the `claude` command is, and what to pass it.
 *
 * The two overrides point the driver at another build of Claude Code, or at a
 * stand-in, without changing the plugin.
 */
export function claudeCommandSpec(env: Record<string, string | undefined>): ClaudeCommandSpec {
  const command = env.DOHC_AGENT_CLAUDE_CODE_COMMAND?.trim() || "claude";
  const raw = env.DOHC_AGENT_CLAUDE_CODE_ARGS_JSON?.trim();
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

interface PendingPermission {
  request: unknown;
  settle(decision: PluginPermissionDecision): void;
}

class ClaudeSession implements PluginAgentSession {
  readonly resumeCursor: string;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private activeTurnId: string | null = null;
  private cancelled = false;
  private disposed = false;

  constructor(
    private readonly stream: ClaudeStream,
    readonly sessionId: string,
    private readonly input: PluginAgentSessionStartInput,
  ) {
    // What a later session needs to continue this one: `--resume` takes the
    // same id `--session-id` minted.
    this.resumeCursor = sessionId;
  }

  async prompt(input: { text: string }): Promise<{ turnId: string }> {
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.cancelled = false;
    this.input.onEvent({ kind: "session-state", state: "running" });
    const sent = await this.stream.send({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: input.text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    });
    if (!sent) throw new Error("Claude Code is closed.");
    return { turnId };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.stream.send({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    for (const requestId of [...this.pendingPermissions.keys()]) {
      await this.answerPermission(requestId, "cancel");
    }
  }

  async answerPermission(requestId: string, decision: PluginPermissionDecision): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`Unknown permission request: ${requestId}`);
    this.pendingPermissions.delete(requestId);
    pending.settle(decision);
  }

  async stop(): Promise<void> {
    await this.cancel();
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stream.dispose();
  }

  /** Everything Claude says, once the session is running. */
  handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    if (message.type === "control_request") {
      this.handleControlRequest(message);
      return;
    }
    const turnId = this.activeTurnId ?? randomUUID();
    const events = mapStreamMessage(message, {
      turnId,
      cancelled: this.cancelled,
      newId: randomUUID,
    });
    if (message.type === "result") this.activeTurnId = null;
    for (const event of events) this.input.onEvent(event);
  }

  /**
   * Claude asked to run something. dohc decides, and Claude waits for the
   * answer: the control response goes back when a policy answers straight
   * away, or when a person answers through `answerPermission`.
   */
  private handleControlRequest(message: Record<string, unknown>): void {
    const requestId = asString(message.request_id) ?? randomUUID();
    const request = isRecord(message.request) ? message.request : {};
    if (request.subtype !== "can_use_tool") {
      // A dialog or an elicitation. dohc has no surface to ask a person, so
      // the request is refused rather than answered on their behalf.
      this.input.onEvent({
        kind: "error",
        message: `Claude requested ${asString(request.subtype) ?? "input"}, which dohc does not support yet; the request was refused.`,
        fatal: false,
      });
      void this.stream.send({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: requestId,
          error: `dohc does not support ${asString(request.subtype) ?? "this request"}.`,
        },
      });
      return;
    }
    this.pendingPermissions.set(requestId, {
      request,
      settle: (decision) => {
        // dohc's own record of the answer. The plugin path depends on the
        // driver reporting this: nothing else can see a decision that was
        // made inside the harness conversation.
        this.input.onEvent({ kind: "permission-resolved", requestId, decision });
        void this.stream.send(permissionControlResponse(requestId, decision, request));
      },
    });
    this.input.onEvent(permissionRequestEvent(request, requestId));
  }
}

export function createClaudeDriver(
  spawnCommand: SpawnCommand,
  spec: ClaudeCommandSpec,
  readyTimeout: number = READY_TIMEOUT_MS,
): PluginAgentDriver {
  interface CommandResult {
    code: number | null;
    stdout: string;
    stderr: string;
  }

  /** Runs one short `claude` command and reads what it printed. */
  async function runCommand(args: string[]): Promise<CommandResult | { timedOut: true }> {
    const child = await spawnCommand({
      command: spec.command,
      args: [...spec.args, ...args],
      cwd: { workspaceRoot: true },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([child.wait(), timedOut]);
      if (result === "timeout") return { timedOut: true };
      const logs = await child.logs();
      const read = (stream: "stdout" | "stderr"): string =>
        logs.filter((line) => line.stream === stream).map((line) => line.text).join("");
      return { code: result.code, stdout: read("stdout"), stderr: read("stderr") };
    } finally {
      if (timer) clearTimeout(timer);
      await child.terminate().catch(() => undefined);
    }
  }

  async function probe(): Promise<PluginAgentProbe> {
    let version: CommandResult | { timedOut: true };
    try {
      version = await runCommand(["--version"]);
    } catch (error) {
      return absent(error instanceof Error ? error.message : "Probe failed.");
    }
    if ("timedOut" in version) return absent("Probe timed out.");
    if (version.code !== 0) {
      return absent(
        (version.stderr || version.stdout).trim().slice(0, MAX_PROBE_ERROR_CHARS) || "Probe failed.",
      );
    }
    // Claude Code is here. Whether anyone is logged in is a separate question,
    // and a login that is missing has to read as a missing login rather than
    // as a missing harness.
    let auth: PluginAgentProbe["auth"] = { status: "unknown", label: "CLI login" };
    try {
      const status = await runCommand(["auth", "status"]);
      if (!("timedOut" in status)) auth = claudeAuth(status.code ?? 1, status.stdout);
    } catch {
      // The version answered, so Claude Code is installed either way.
    }
    return {
      installed: true,
      version: (version.stdout || version.stderr).trim().split(/\r?\n/)[0] || undefined,
      auth,
      models: [{ id: "default", name: "Default", planIncluded: true }],
    };
  }

  async function startSession(input: PluginAgentSessionStartInput): Promise<PluginAgentSession> {
    input.onEvent({ kind: "session-state", state: "starting" });
    const resumeCursor = typeof input.resumeCursor === "string" ? input.resumeCursor : undefined;
    const sessionId = resumeCursor ?? randomUUID();
    let child: Awaited<ReturnType<SpawnCommand>>;
    try {
      child = await spawnCommand({
        command: spec.command,
        args: [
          ...spec.args,
          ...claudeSessionArgs({
            sessionId,
            resume: resumeCursor !== undefined,
            mode: input.mode,
            model: input.model,
            mcp: input.mcp,
          }),
        ],
        cwd: { workspaceRoot: true },
      });
    } catch (error) {
      // This session reported "starting"; a session that never started has to
      // report an end, or a surface waits on it forever.
      input.onEvent({ kind: "session-state", state: "closed" });
      throw error;
    }

    let session: ClaudeSession | null = null;
    let ready: (() => void) | null = null;
    let failed: ((error: Error) => void) | null = null;
    const handshake = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });

    const stream = await ClaudeStream.attach(child, {
      onMessage: (message) => {
        if (
          isRecord(message) &&
          message.type === "control_response" &&
          isRecord(message.response) &&
          message.response.request_id === HANDSHAKE_ID
        ) {
          ready?.();
          return;
        }
        if (!session) {
          // Claude sends nothing before it answers the handshake except that
          // answer, so anything else here is a message dohc cannot place. It
          // is dropped either way; saying so is the difference between a
          // protocol that changed under dohc and a silence nobody can explain.
          input.onEvent({
            kind: "error",
            message: "Claude spoke before the session was ready; the message was dropped.",
            fatal: false,
          });
          return;
        }
        session.handleMessage(message);
      },
      onStderr: (line) => {
        input.onEvent({ kind: "error", message: line, fatal: isFatalStderr(line) });
        if (isFatalStderr(line)) failed?.(new Error(line));
      },
      onExit: () => {
        failed?.(new Error("Claude Code exited before it was ready."));
        input.onEvent({ kind: "session-state", state: "closed" });
      },
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Claude answers this before any prompt, so a session dohc calls "ready"
      // is one that answered — not one that was merely spawned.
      await stream.send({
        type: "control_request",
        request_id: HANDSHAKE_ID,
        request: { subtype: "initialize" },
      });
      await Promise.race([
        handshake,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Claude Code did not answer dohc's handshake within ${readyTimeout}ms. Set DOHC_AGENT_CLAUDE_CODE_READY_TIMEOUT_MS to allow longer.`,
                ),
              ),
            readyTimeout,
          );
        }),
      ]);
    } catch (error) {
      await stream.dispose();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }

    session = new ClaudeSession(stream, sessionId, input);
    input.onEvent({ kind: "session-state", state: "ready" });
    return session;
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
