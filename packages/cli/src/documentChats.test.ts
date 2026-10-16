import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCliArguments } from "./args";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION } from "./protocol";

const listed = {
  ok: true, path: "notes/plan.md", fileObjectId: "object-plan",
  threads: [{ id: "thread-review", title: "Review", createdAtMs: 1, updatedAtMs: 2, linkedPathHint: "old-plan.md" }],
};

describe("document chats", () => {
  it("dispatches the file-chat read and preserves every result field", async () => {
    const request = vi.fn(async () => listed);
    const result = await executeCli({ argv: ["document", "chats", "plan.md", "--json"], cwd: "/workspace/notes", env: {}, request });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 3, ...listed });
    expect(request).toHaveBeenCalledExactlyOnceWith({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileChats", args: { cwd: resolve("/workspace/notes"), actor: "agent", path: "plan.md" } });
  });

  it("prints the same fields by default", async () => {
    const result = await executeCli({ argv: ["document", "chats", "plan.md"], request: async () => listed });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(listed);
  });

  it("returns an empty list for an untracked file", async () => {
    const empty = { ok: true, path: "new.md", fileObjectId: null, threads: [] };
    const result = await executeCli({ argv: ["document", "chats", "new.md", "--json"], request: async () => empty });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 3, ...empty });
  });

  it("keeps the agent actor with --as-agent", () => {
    expect(parseCliArguments(["document", "chats", "plan.md", "--as-agent"], {}))
      .toEqual({ actor: "agent", json: false, verb: "fileChats", path: "plan.md" });
  });

  it.each([[], ["plan.md", "extra"], ["plan.md", "--title", "Review"]])("refuses invalid operands %j before dispatch", async (...args) => {
    const request = vi.fn();
    const result = await executeCli({ argv: ["document", "chats", ...args], request });
    expect(result.exitCode).toBe(1);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports a desktop refusal with JSON=%s", async json => {
    expect(await executeCli({ argv: ["document", "chats", "plan.md", ...(json ? ["--json"] : [])], request: async () => ({ ok: false, reason: "File access denied." }) }))
      .toEqual({ exitCode: 1, stdout: "", stderr: "dohc: File access denied.\n" });
  });

  it("rejects an incomplete desktop response", async () => {
    expect(await executeCli({ argv: ["document", "chats", "plan.md"], request: async () => ({ ok: true, threads: [] }) }))
      .toEqual({ exitCode: 1, stdout: "", stderr: "dohc: desktop app returned an invalid response\n" });
  });
});
