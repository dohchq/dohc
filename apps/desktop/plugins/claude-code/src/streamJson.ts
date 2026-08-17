import type { PluginChildProcessCommandHandle } from "@dohc/sdk/node";

/**
 * Claude Code's stream-json protocol over a brokered command child.
 *
 * dohc's broker owns the process — it starts it, resolves the command on
 * Windows, and takes its whole tree down with the plugin. This file owns only
 * the conversation: one JSON message per line out, one per line in.
 *
 * Unlike Codex's app-server, this is not JSON-RPC. There are no ids to match
 * and no replies to wait for: Claude streams messages, and dohc answers the
 * ones that are questions.
 */

/** Splits a stream's chunks into whole lines, keeping the partial tail. */
export class LineReader {
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

export interface ClaudeStreamOptions {
  onMessage(message: unknown): void;
  onStderr?(line: string): void;
  onExit?(): void;
}

export class ClaudeStream {
  private readonly stdout = new LineReader();
  private readonly stderr = new LineReader();
  private closed = false;

  private constructor(
    private readonly child: PluginChildProcessCommandHandle,
    private readonly options: ClaudeStreamOptions,
  ) {}

  /**
   * Starts reading a spawned child. The broker replays whatever the child
   * already wrote, so a harness that speaks before this returns is still
   * heard.
   */
  static async attach(
    child: PluginChildProcessCommandHandle,
    options: ClaudeStreamOptions,
  ): Promise<ClaudeStream> {
    const stream = new ClaudeStream(child, options);
    await child.onOutput((output) => {
      if (output.stream === "stdout") {
        stream.stdout.read(output.text, (line) => stream.handleLine(line));
        return;
      }
      stream.stderr.read(output.text, (line) => options.onStderr?.(line));
    });
    void child
      .wait()
      .then(() => {
        stream.closed = true;
        options.onExit?.();
      })
      .catch(() => undefined);
    return stream;
  }

  /** Writes one message to Claude. Returns false once the process is gone. */
  async send(message: unknown): Promise<boolean> {
    if (this.closed) return false;
    try {
      await this.child.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    await this.child.terminate().catch(() => undefined);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // Claude writes its diagnostics to standard error, so a line here that
      // is not JSON is not a message dohc lost — report it as one.
      this.options.onStderr?.(`Invalid stream-json line: ${line.slice(0, 200)}`);
      return;
    }
    this.options.onMessage(parsed);
  }
}
