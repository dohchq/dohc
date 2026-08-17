import type { PluginChildProcessCommandHandle } from "@dohc/sdk/node";

/**
 * JSON-RPC over a brokered command child's standard streams.
 *
 * dohc's broker owns the process — it starts it, resolves the command on
 * Windows, and takes its whole tree down with the plugin. This class owns only
 * the conversation: one JSON message per line out, one per line in, and the
 * pending requests waiting for a reply.
 */

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export interface CommandJsonRpcOptions {
  /** Names the harness in the error a closed transport rejects with. */
  label: string;
  onNotification?(method: string, params: unknown): void;
  onRequest?(method: string, params: unknown): Promise<unknown> | unknown;
  onStderr?(line: string): void;
  onExit?(): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function normalizeError(error: unknown): JsonRpcError {
  if (error instanceof JsonRpcError) return error;
  if (error instanceof Error) return new JsonRpcError(-32603, error.message);
  return new JsonRpcError(-32603, "JSON-RPC handler failed.");
}

/** Splits a stream's chunks into whole lines, keeping the partial tail. */
class LineReader {
  private buffered = "";

  read(chunk: string, onLine: (line: string) => void): void {
    this.buffered += chunk;
    let breakAt = this.buffered.indexOf("\n");
    while (breakAt >= 0) {
      const line = this.buffered.slice(0, breakAt).replace(/\r$/, "");
      this.buffered = this.buffered.slice(breakAt + 1);
      if (line.length > 0) onLine(line);
      breakAt = this.buffered.indexOf("\n");
    }
  }
}

export class CommandJsonRpc {
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly stdout = new LineReader();
  private readonly stderr = new LineReader();
  private nextId = 1;
  private closed = false;

  private constructor(
    private readonly child: PluginChildProcessCommandHandle,
    private readonly options: CommandJsonRpcOptions,
  ) {}

  /**
   * Starts reading a spawned child. The broker replays whatever the child
   * already wrote, so a harness that speaks before this returns is still
   * heard.
   */
  static async attach(
    child: PluginChildProcessCommandHandle,
    options: CommandJsonRpcOptions,
  ): Promise<CommandJsonRpc> {
    const transport = new CommandJsonRpc(child, options);
    await child.onOutput((output) => {
      if (output.stream === "stdout") {
        transport.stdout.read(output.text, (line) => transport.handleLine(line));
        return;
      }
      transport.stderr.read(output.text, (line) => options.onStderr?.(line));
    });
    // The harness exiting is terminal for every request still waiting: the
    // process that owed the reply is gone.
    void child
      .wait()
      .then(() => {
        options.onExit?.();
        transport.close(new Error(`${options.label} exited.`));
      })
      .catch(() => undefined);
    return transport;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${this.options.label} is closed.`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      void this.send({ jsonrpc: "2.0", id, method, params }).then((sent) => {
        if (sent) return;
        this.pending.delete(id);
        reject(new Error(`${this.options.label} is closed.`));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    void this.send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Stops the harness. The broker takes the process tree down; this only ends
   * the conversation and fails whatever was still waiting on it.
   */
  async dispose(): Promise<void> {
    this.close(new Error(`${this.options.label} was disposed.`));
    await this.child.terminate().catch(() => undefined);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.options.onStderr?.(`Invalid JSON-RPC line: ${line.slice(0, 200)}`);
      return;
    }
    if (!isRecord(parsed)) return;
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    if (method !== undefined && isRpcId(parsed.id)) {
      void this.handleIncomingRequest(parsed.id, method, parsed.params);
      return;
    }
    if (method !== undefined) {
      this.options.onNotification?.(method, parsed.params);
      return;
    }
    if (!isRpcId(parsed.id)) return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    const error = isRecord(parsed.error) ? parsed.error : undefined;
    if (error) {
      pending.reject(
        new JsonRpcError(
          typeof error.code === "number" ? error.code : -32603,
          typeof error.message === "string" ? error.message : "JSON-RPC request failed.",
          error.data,
        ),
      );
      return;
    }
    pending.resolve(parsed.result);
  }

  private async handleIncomingRequest(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      if (!this.options.onRequest) throw new JsonRpcError(-32601, `Method not found: ${method}`);
      const result = await this.options.onRequest(method, params);
      await this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (error) {
      const rpcError = normalizeError(error);
      await this.send({
        jsonrpc: "2.0",
        id,
        error: { code: rpcError.code, message: rpcError.message, data: rpcError.data },
      });
    }
  }

  private async send(message: unknown): Promise<boolean> {
    if (this.closed) return false;
    try {
      await this.child.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      this.close(error instanceof Error ? error : new Error("JSON-RPC write failed."));
      return false;
    }
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
