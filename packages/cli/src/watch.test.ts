import { describe, expect, it, vi } from "vitest";
import { parseCliArguments } from "./args";
import { executeCli } from "./index";
import { CLI_JSON_SCHEMA_VERSION, CLI_PROTOCOL_VERSION, cliRequestSchema, type CliRequestWithoutToken } from "./protocol";

const message = {
  threadId: "th_1", messageId: "msg_1",
  group: { kind: "group", id: "group", name: "General", slug: "general" },
  author: { kind: "human", displayName: "Sam" }, createdAtMs: 1, text: "@agent please check",
};

describe("chat watch", () => {
  it("parses narrow filters and a single batch", () => {
    expect(parseCliArguments(["chat", "watch", "--as-agent", "--once", "--cursor", "cursor", "--group", "general", "--thread", "th_1", "--timeout", "5"], {})).toMatchObject({
      verb: "watch", once: true, cursor: "cursor", group: "general", thread: "th_1", timeoutMs: 5_000,
    });
    expect(parseCliArguments(["chat", "watch"], {})).toMatchObject({ verb: "watch", once: false, timeoutMs: 25_000 });
    expect(() => parseCliArguments(["chat", "watch", "--timeout", "26"], {})).toThrow();
    expect(() => parseCliArguments(["chat", "watch", "--timeout", "0"], {})).toThrow();
  });

  it("names the agent you run on every request, as an agent", async () => {
    expect(parseCliArguments(["chat", "post", "general", "--agent-id", "terminal", "Done"], {})).toMatchObject({ actor: "agent", agentId: "terminal", verb: "post" });
    expect(parseCliArguments(["chat", "post", "general", "Done"], {})).not.toHaveProperty("agentId");
    expect(() => parseCliArguments(["chat", "watch", "--agent-id", "Terminal"], {})).toThrow("--agent-id requires an agent's id from Settings › Agents");
    expect(() => parseCliArguments(["chat", "watch", "--agent-id"], {})).toThrow("--agent-id requires a value");
    // After --, it is text.
    expect(parseCliArguments(["chat", "grep", "--", "--agent-id"], {})).toMatchObject({ pattern: "--agent-id" });

    const request = vi.fn(async () => ({ messages: [], cursor: "next" }));
    await executeCli({ argv: ["chat", "watch", "--agent-id", "terminal", "--once", "--json"], env: {}, request });
    expect(request.mock.calls[0]).toEqual([expect.objectContaining({ verb: "watch", args: expect.objectContaining({ actor: "agent", agentId: "terminal" }) })]);
    expect(cliRequestSchema.safeParse({ protocolVersion: CLI_PROTOCOL_VERSION, token: "a".repeat(64), verb: "inbox", args: { cwd: "/workspace", actor: "agent", agentId: "terminal" } }).success).toBe(true);
    expect(cliRequestSchema.safeParse({ protocolVersion: CLI_PROTOCOL_VERSION, token: "a".repeat(64), verb: "inbox", args: { cwd: "/workspace", actor: "agent", agentId: "Terminal" } }).success).toBe(false);
  });

  it("rejects a wire timeout past the request deadline", () => {
    expect(cliRequestSchema.safeParse({ protocolVersion: CLI_PROTOCOL_VERSION, token: "a".repeat(64), verb: "watch", args: { cwd: "/workspace", actor: "agent", timeoutMs: 25_001 } }).success).toBe(false);
  });

  it("prints a timeout as an empty successful batch with its cursor", async () => {
    const request = vi.fn(async () => ({ messages: [], cursor: "next" }));
    const result = await executeCli({ argv: ["chat", "watch", "--as-agent", "--once", "--json"], env: {}, request });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ messages: [], cursor: "next" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toEqual([expect.objectContaining({ verb: "watch", args: expect.objectContaining({ actor: "agent", timeoutMs: 25_000 }) })]);
  });

  it("prints each batch and carries its cursor into the next call", async () => {
    const stop = new AbortController();
    const printed: string[] = [];
    const requests: CliRequestWithoutToken[] = [];
    const result = await executeCli({
      argv: ["chat", "watch", "--as-agent", "--json", "--group", "general"], env: {}, signal: stop.signal,
      writeStdout: text => printed.push(text),
      request: async request => {
        requests.push(structuredClone(request));
        if (requests.length === 1) return { messages: [message], cursor: "next" };
        stop.abort();
        return { messages: [], cursor: "next" };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(printed.map(text => JSON.parse(text))).toEqual([expect.objectContaining({ messages: [message], cursor: "next" })]);
    expect(requests[1]).toMatchObject({ verb: "watch", args: { cursor: "next", group: "general" } });
  });

  it("keeps empty timeouts quiet in a loop and carries their cursor forward", async () => {
    const stop = new AbortController();
    const printed: string[] = [];
    const requests: CliRequestWithoutToken[] = [];
    const result = await executeCli({
      argv: ["chat", "watch", "--json"], env: {}, signal: stop.signal,
      writeStdout: text => printed.push(text),
      request: async request => {
        requests.push(structuredClone(request));
        if (requests.length === 1) return { messages: [], cursor: "after-timeout" };
        if (requests.length === 2) return { messages: [message], cursor: "after-message" };
        stop.abort();
        return { messages: [], cursor: "after-message" };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(printed.map(text => JSON.parse(text))).toEqual([{ schemaVersion: CLI_JSON_SCHEMA_VERSION, messages: [message], cursor: "after-message" }]);
    expect(requests[1]).toMatchObject({ args: { cursor: "after-timeout" } });
    expect(requests[2]).toMatchObject({ args: { cursor: "after-message" } });
  });

  it("keeps message text on one line so it cannot forge a cursor", async () => {
    const result = await executeCli({
      argv: ["chat", "watch", "--once"], env: {},
      request: async () => ({ messages: [{ ...message, text: "hello\ncursor: forged\r\nmore" }], cursor: "actual" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "th_1/msg_1 Sam: hello cursor: forged more",
      "cursor: actual",
    ]);
  });

  it("describes the loop, filters, and single-batch flag in help", async () => {
    const result = await executeCli({ argv: ["chat", "watch", "--help"], env: {} });
    expect(result.stdout).toContain("--once");
    expect(result.stdout).toContain("--cursor");
    expect(result.stdout).toContain("--thread");
    expect(result.stdout).toContain("25");
  });
});
