import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION, type CliRequestWithoutToken } from "./protocol";

describe("document commands", () => {
  it.each(["", "# Live text", "# Live text\n\n"])("reads current Markdown byte for byte: %j", async (markdown) => {
    const request = vi.fn(async () => ({ ok: true, path: "notes/plan.md", markdown }));
    expect(await executeCli({ argv: ["document", "read", "plan.md"], cwd: "/workspace/notes", request }))
      .toEqual({ exitCode: 0, stdout: markdown, stderr: "" });
    expect(request).toHaveBeenCalledWith({
      protocolVersion: CLI_PROTOCOL_VERSION, verb: "documentRead",
      args: { cwd: resolve("/workspace/notes"), actor: "agent", path: "plan.md" },
    });
  });

  it.each([false, true])("edits through the socket with stdin=%s", async (stdin) => {
    const request = vi.fn(async () => ({ ok: true, path: "plan.md", changed: true, warning: "Read the document to check." }));
    const readStdin = vi.fn(async () => "--json\n");
    const result = await executeCli({
      argv: ["document", "edit", "plan.md", "--find", "Draft", "--request-id", "edit-1", "--agent", "local-agent",
        ...(stdin ? ["-"] : ["--text", "--json\n"]), "--json"],
      cwd: "/workspace", request, readStdin,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 2, ok: true, path: "plan.md", changed: true, warning: "Read the document to check." });
    expect(request).toHaveBeenCalledWith({
      protocolVersion: CLI_PROTOCOL_VERSION, verb: "documentEdit",
      args: { cwd: resolve("/workspace"), actor: "agent", path: "plan.md", find: "Draft", replacement: "--json\n", requestId: "edit-1", agent: "local-agent" },
    });
    expect(readStdin).toHaveBeenCalledTimes(stdin ? 1 : 0);
  });

  it.each([[], ["--text", ""], ["-"]])("creates an empty document with %j", async (...input) => {
    const request = vi.fn(async () => ({ ok: true, path: "new.md" }));
    const result = await executeCli({ argv: ["document", "create", "new.md", ...input], request, readStdin: async () => "" });
    expect(result).toEqual({ exitCode: 0, stdout: "Created new.md\n", stderr: "" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ verb: "documentCreate", args: expect.objectContaining({ actor: "agent", markdown: "" }) }));
  });

  it("appends without find and keeps a literal dash in --text", async () => {
    const request = vi.fn(async (_request: CliRequestWithoutToken) => ({ ok: true, path: "plan.md", changed: false, warning: "Check the document." }));
    const result = await executeCli({ argv: ["document", "edit", "plan.md", "--text", "-"], request });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ replacement: "-" }) }));
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("args.find");
    expect(result).toEqual({ exitCode: 0, stdout: "Unchanged plan.md\nCheck the document.\n", stderr: "" });
  });

  it.each(["read", "edit", "create"])("reports %s refusals with exit 1, including JSON mode", async (verb) => {
    for (const json of [[], ["--json"]]) {
      const result = await executeCli({ argv: ["document", verb, "plan.md", ...(verb === "read" ? [] : ["--text", "x"]), ...json],
        request: async () => ({ ok: false, reason: "Document changed; read it again." }) });
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "dohc: Document changed; read it again.\n" });
    }
  });

  it("prints read JSON and allows an empty replacement to delete matching text", async () => {
    const read = await executeCli({ argv: ["document", "read", "a.md", "--json"],
      request: async () => ({ ok: true, path: "a.md", markdown: "Live\n" }) });
    expect(JSON.parse(read.stdout)).toEqual({ schemaVersion: 2, ok: true, path: "a.md", markdown: "Live\n" });
    const request = vi.fn(async () => ({ ok: true, path: "a.md", changed: true }));
    const edit = await executeCli({ argv: ["document", "edit", "a.md", "--find", "--json", "-"], request, readStdin: async () => "" });
    expect(edit.stdout).toBe("Updated a.md\n");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ find: "--json", replacement: "" }) }));
  });

  it.each(["edit", "create"])("bounds %s stdin by UTF-8 bytes before sending", async (verb) => {
    const request = vi.fn();
    const result = await executeCli({ argv: ["document", verb, "a.md", "-"], request, readStdin: async () => "界".repeat(90_000) });
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "dohc: document text is at most 256 KiB as UTF-8\n" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["read"], ["read", "a.md", "extra"], ["edit", "a.md"],
    ["edit", "a.md", "-", "--text", "x"], ["edit", "a.md", "--text", "x", "--find", ""],
    ["create", "a.md", "--text"], ["create", "a.md", "--agent", "invalid/name"],
  ])("refuses invalid input %j before sending", async (...args) => {
    const request = vi.fn();
    const result = await executeCli({ argv: ["document", ...args], request });
    expect(result.exitCode).toBe(1);
    expect(request).not.toHaveBeenCalled();
  });
});
