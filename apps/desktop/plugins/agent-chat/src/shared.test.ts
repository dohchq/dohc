import { describe, expect, it } from "vitest";
import { LineReader, commandSpec } from "./shared.ts";

/**
 * The framing, on its own.
 *
 * A child's output arrives in whatever pieces the pipe hands over: a message
 * split across two chunks, two messages in one chunk, a line ending that
 * carries a carriage return. Treating a chunk as a message loses all three.
 */

function linesFrom(chunks: string[]): string[] {
  const reader = new LineReader();
  const lines: string[] = [];
  for (const chunk of chunks) reader.read(chunk, (line) => lines.push(line));
  return lines;
}

describe("reading whole lines out of a stream", () => {
  it("joins a message that arrived in pieces", () => {
    expect(linesFrom(['{"type":"res', 'ult","is_er', 'ror":false}\n'])).toEqual([
      '{"type":"result","is_error":false}',
    ]);
  });

  it("splits two messages that arrived together", () => {
    expect(linesFrom(['{"a":1}\n{"b":2}\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("holds a line back until it is whole", () => {
    const reader = new LineReader();
    const lines: string[] = [];
    reader.read('{"a":1}', (line) => lines.push(line));
    expect(lines).toEqual([]);
    reader.read("\n", (line) => lines.push(line));
    expect(lines).toEqual(['{"a":1}']);
  });

  it("drops the carriage return a Windows pipe adds", () => {
    expect(linesFrom(['{"a":1}\r\n'])).toEqual(['{"a":1}']);
  });

  it("reports nothing for the blank lines between messages", () => {
    expect(linesFrom(["\n\n", '{"a":1}\n', "\n"])).toEqual(['{"a":1}']);
  });

  it("keeps one reader's buffer to itself", () => {
    const first = new LineReader();
    const second = new LineReader();
    const lines: string[] = [];
    first.read('{"a":', (line) => lines.push(line));
    second.read('{"b":2}\n', (line) => lines.push(line));
    first.read('1}\n', (line) => lines.push(line));
    expect(lines).toEqual(['{"b":2}', '{"a":1}']);
  });
});

describe("the command a driver runs", () => {
  it("runs the default command with no arguments when nothing overrides it", () => {
    expect(commandSpec({}, "CODEX", "codex")).toEqual({ command: "codex", args: [] });
  });

  it("reads the override for its own prefix, not another driver's", () => {
    const env = {
      DOHC_AGENT_CODEX_COMMAND: "node",
      DOHC_AGENT_CODEX_ARGS_JSON: '["fake.mjs", "ok"]',
    };
    expect(commandSpec(env, "CODEX", "codex")).toEqual({
      command: "node",
      args: ["fake.mjs", "ok"],
    });
    expect(commandSpec(env, "CLAUDE_CODE", "claude")).toEqual({ command: "claude", args: [] });
  });

  it("splits arguments that are not JSON on spaces", () => {
    expect(
      commandSpec({ DOHC_AGENT_CODEX_ARGS_JSON: "--flag  value" }, "CODEX", "codex"),
    ).toEqual({ command: "codex", args: ["--flag", "value"] });
  });
});
