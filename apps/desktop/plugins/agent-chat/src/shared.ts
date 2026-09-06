import type { PluginAgentProbe } from "@dohc/sdk/node";

/** What both drivers need and neither owns: line framing, the command
 * override, and the shape of a probe that found nothing. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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

export interface CommandSpec {
  command: string;
  args: string[];
}

/**
 * Where a harness command is, and what to pass it.
 *
 * `DOHC_AGENT_<prefix>_COMMAND` replaces the command and
 * `DOHC_AGENT_<prefix>_ARGS_JSON` puts arguments before the driver's own, so
 * a test or a machine can point a driver at another build or a stand-in
 * without changing the plugin. Arguments that are not JSON split on spaces.
 */
export function commandSpec(
  env: Record<string, string | undefined>,
  prefix: string,
  defaultCommand: string,
): CommandSpec {
  const command = env[`DOHC_AGENT_${prefix}_COMMAND`]?.trim() || defaultCommand;
  const raw = env[`DOHC_AGENT_${prefix}_ARGS_JSON`]?.trim();
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

/** What a probe reports when the harness is not on this machine. */
export function absent(errorMessage: string): PluginAgentProbe {
  return {
    installed: false,
    auth: { status: "unknown", loginHint: "Install and log in with the provider CLI." },
    models: [],
    errorMessage,
  };
}
