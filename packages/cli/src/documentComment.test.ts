import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCliArguments } from "./args";
import { executeCli } from "./index";
import { CHAT_MESSAGE_TOO_LONG, MAX_CHAT_MESSAGE_BODY_BYTES } from "@dohc/workspace-contracts/chat-message-body";
import { CLI_PROTOCOL_VERSION } from "./protocol";
import * as stdin from "./stdin";

const started = { ok: true, path: "notes/plan.md", threadId: "thread-file", messageId: "message-first", warning: "Check the chat." };
const base = ["document", "comment", "plan.md", "--title", "Budget"];

describe("document comment", () => {
  it("parses a comment as an agent and keeps optional identifiers", () => {
    expect(parseCliArguments([...base, "--text", "--json", "--agent", "local-agent", "--request-id", "retry-1", "--run-id", "run-1", "--json"], {}))
      .toEqual({ actor: "agent", json: true, verb: "fileChatStart", path: "plan.md", title: "Budget", body: "--json", stdin: false, agent: "local-agent", requestId: "retry-1", runId: "run-1" });
  });

  it.each([false, true])("dispatches the first message with stdin=%s", async (stdin) => {
    const request = vi.fn(async () => started);
    const readStdin = vi.fn(async () => "First message\n");
    const result = await executeCli({ argv: [...base, ...(stdin ? ["-"] : ["--text", "First message\n"]), "--agent", "local-agent", "--request-id", "retry-1", "--json"], cwd: "/workspace/notes", env: { DOHC_RUN_ID: "run-env" }, request, readStdin });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 2, ...started });
    expect(request).toHaveBeenCalledWith({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileChatStart", args: { cwd: resolve("/workspace/notes"), actor: "agent", path: "plan.md", title: "Budget", body: "First message\n", agent: "local-agent", requestId: "retry-1", runId: "run-env" } });
    expect(readStdin).toHaveBeenCalledTimes(stdin ? 1 : 0);
  });

  it("uses an explicit run id and preserves a literal dash in --text", async () => {
    const request = vi.fn(async () => started);
    const readStdin = vi.fn();
    const result = await executeCli({ argv: [...base, "--text", "-", "--run-id", "run-arg"], env: { DOHC_RUN_ID: "run-env" }, request, readStdin });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Commented on notes/plan.md in thread-file\nwarning: Check the chat.\n");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ body: "-", runId: "run-arg" }) }));
    expect(readStdin).not.toHaveBeenCalled();
  });

  it("omits optional identifiers when absent", async () => {
    const request = vi.fn(async () => started);
    await executeCli({ argv: [...base, "--text", "Message"], cwd: "/workspace", env: {}, request });
    expect(request).toHaveBeenCalledWith({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileChatStart", args: { cwd: resolve("/workspace"), actor: "agent", path: "plan.md", title: "Budget", body: "Message" } });
  });

  it.each([
    [], ["plan.md"], ["plan.md", "--title", "Budget"],
    ["plan.md", "--text", "Message"], ["plan.md", "--title", "", "--text", "Message"],
    ["plan.md", "--title", " ", "--text", "Message"], ["plan.md", "--title", "x".repeat(201), "--text", "Message"],
    ["plan.md", "--title", "Budget", "--text", ""], ["plan.md", "--title", "Budget", "--text", " \n"],
    ["plan.md", "--title", "Budget", "-", "--text", "Message"],
    ["plan.md", "--title", "Budget", "Message"], ["plan.md", "--title", "Budget", "-", "extra"],
    ["plan.md", "--title", "Budget", "--text", "Message", "--agent", "invalid/name"],
    ["plan.md", "--title", "Budget", "--text", "Message", "--request-id", ""],
    ["plan.md", "--title", "Budget", "--text", "Message", "--run-id", ""],
  ])("refuses missing or invalid input %j before dispatch", async (...input) => {
    const request = vi.fn();
    const result = await executeCli({ argv: ["document", "comment", ...input], request });
    expect(result.exitCode).toBe(1);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["", " \n"])("refuses empty stdin %j before dispatch", async (body) => {
    const request = vi.fn();
    const result = await executeCli({ argv: [...base, "-"], readStdin: async () => body, request });
    expect(result.exitCode).toBe(1);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports refusal with exit 1 in JSON mode=%s", async (json) => {
    expect(await executeCli({ argv: [...base, "--text", "Message", ...(json ? ["--json"] : [])], request: async () => ({ ok: false, reason: "File access denied." }) }))
      .toEqual({ exitCode: 1, stdout: "", stderr: "dohc: File access denied.\n" });
  });

  it.each([false, true])("refuses oversized UTF-8 bodies before dispatch with stdin=%s", async (fromStdin) => {
    for (const body of ["a".repeat(MAX_CHAT_MESSAGE_BODY_BYTES + 1), "界".repeat(21_846)]) {
      const request = vi.fn();
      expect(await executeCli({ argv: [...base, ...(fromStdin ? ["-"] : ["--text", body])], request, readStdin: async () => body }))
        .toEqual({ exitCode: 1, stdout: "", stderr: `dohc: ${CHAT_MESSAGE_TOO_LONG}\n` });
      expect(request).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("accepts the exact UTF-8 byte limit with stdin=%s", async (fromStdin) => {
    for (const body of ["a".repeat(MAX_CHAT_MESSAGE_BODY_BYTES), "界".repeat(21_845) + "a"]) {
      const request = vi.fn(async () => started);
      expect((await executeCli({ argv: [...base, ...(fromStdin ? ["-"] : ["--text", body])], request, readStdin: async () => body })).exitCode).toBe(0);
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ body }) }));
    }
  });

  it("stops reading a comment pipe as soon as it exceeds the limit", async () => {
    let chunksRead = 0;
    let closed = false;
    async function* pipe() {
      try {
        chunksRead += 1;
        yield Buffer.alloc(MAX_CHAT_MESSAGE_BODY_BYTES, "a");
        chunksRead += 1;
        yield Buffer.from("界");
        chunksRead += 1;
        throw new Error("The remaining pipe must not be read.");
      } finally {
        closed = true;
      }
    }
    const readStdinText = stdin.readStdinText;
    const spy = vi.spyOn(stdin, "readStdinText").mockImplementation((_stream, limit) => readStdinText(pipe(), limit));
    const request = vi.fn();
    try {
      expect(await executeCli({ argv: [...base, "-"], request }))
        .toEqual({ exitCode: 1, stdout: "", stderr: `dohc: ${CHAT_MESSAGE_TOO_LONG}\n` });
      expect(spy).toHaveBeenCalledWith(process.stdin, { bytes: MAX_CHAT_MESSAGE_BODY_BYTES, message: CHAT_MESSAGE_TOO_LONG });
      expect(chunksRead).toBe(2);
      expect(closed).toBe(true);
      expect(request).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("prints the comment result without a warning when none was returned", async () => {
    const { warning: _warning, ...withoutWarning } = started;
    expect(await executeCli({ argv: [...base, "--text", "Message"], request: async () => withoutWarning }))
      .toEqual({ exitCode: 0, stdout: "Commented on notes/plan.md in thread-file\n", stderr: "" });
  });

  it("rejects an invalid desktop response", async () => {
    expect(await executeCli({ argv: [...base, "--text", "Message"], request: async () => ({ ok: true, path: "plan.md" }) }))
      .toEqual({ exitCode: 1, stdout: "", stderr: "dohc: desktop app returned an invalid response\n" });
  });

  it("explains that the comment starts a file-linked chat", async () => {
    const request = vi.fn();
    const result = await executeCli({ argv: ["document", "comment", "--help"], request });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.replace(/\s+/g, " ")).toContain("Start a chat linked to a file with its first message.");
    for (const flag of ["--title", "--text", "--agent", "--request-id", "--run-id"]) expect(result.stdout).toContain(flag);
    expect(result.stdout.replace(/\s+/g, " ")).toContain("Use - as the body to read it from stdin.");
    expect(result.stdout).not.toContain("default output shows the result as JSON");
    expect(result.stdout).not.toContain("schemaVersion in the output");
    expect(request).not.toHaveBeenCalled();
  });
});
