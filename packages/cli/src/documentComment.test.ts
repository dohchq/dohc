import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCliArguments } from "./args";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION } from "./protocol";

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
    expect(JSON.parse(result.stdout)).toEqual(started);
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

  it("keeps the chat body contract for messages larger than document edits", async () => {
    const body = "界".repeat(90_000);
    const request = vi.fn(async () => started);
    expect((await executeCli({ argv: [...base, "--text", body], request })).exitCode).toBe(0);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ body }) }));
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
    expect(request).not.toHaveBeenCalled();
  });
});
