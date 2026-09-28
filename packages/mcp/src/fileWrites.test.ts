import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DohcCliError } from "@dohc/cli/errors";
import { createApp, FILE_WRITE_UNAVAILABLE_REASON, importData, writeWorkspaceFile, type ToolContext } from "./tools";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function context(): Promise<ToolContext> {
  const base = await mkdtemp(join(tmpdir(), "dohc-mcp-file-write-"));
  roots.push(base);
  const root = join(base, "workspace"), home = join(base, "home");
  await mkdir(root); await mkdir(home);
  return { root, home };
}

describe("MCP authored file writes", () => {
  it("refuses a missing endpoint without creating files or metadata", async () => {
    const ctx = await context();
    expect(await writeWorkspaceFile(ctx, { path: "new/note.txt", content: "new" })).toEqual({ ok: false, reason: FILE_WRITE_UNAVAILABLE_REASON });
    expect(await readdir(ctx.root)).toEqual([]);
  });

  it("passes through the desktop refusal and current hash without a disk fallback", async () => {
    const ctx = await context();
    await writeFile(join(ctx.root, "note.txt"), "original");
    const refusal = { ok: false, reason: "The file changed. Read it again.", currentSha256: "a".repeat(64), written: [] };
    ctx.request = async () => refusal;
    expect(await writeWorkspaceFile(ctx, { path: "note.txt", content: "new", expectedSha256: "0".repeat(64) })).toEqual(refusal);
    expect(await readFile(join(ctx.root, "note.txt"), "utf8")).toBe("original");
    ctx.request = async () => { throw new DohcCliError("dohc could not start the engine for this workspace"); };
    expect(await writeWorkspaceFile(ctx, { path: "note.txt", content: "new" })).toMatchObject({ ok: false, reason: "dohc could not start the engine for this workspace" });
  });

  it("sends one authored request for a file and preserves base64 for desktop validation", async () => {
    const ctx = await context();
    const request = vi.fn<NonNullable<ToolContext["request"]>>(async () => ({ ok: false, reason: "Bad base64. Encode it again.", written: [] }));
    ctx.request = request;
    await writeWorkspaceFile(ctx, { path: "note.txt", content: "!", encoding: "base64" }, "Client");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({ verb: "fileWrite", args: { actor: "agent", agent: "Client", requestId: expect.any(String), files: [{ path: "note.txt", contentBase64: "!" }] } });
    expect(await readdir(ctx.root)).toEqual([]);
  });

  it("sends the app as one create-only batch and preserves partial failure details", async () => {
    const ctx = await context();
    const refusal = { ok: false, reason: "Disk full. Free space and retry.", path: "app/script.js", written: ["app/index.html", "app/styles.css"] };
    const request = vi.fn<NonNullable<ToolContext["request"]>>(async () => refusal);
    ctx.request = request;
    expect(await createApp(ctx, { appRoot: "app" }, "Client")).toEqual(refusal);
    expect(request).toHaveBeenCalledOnce();
    const sent = request.mock.calls[0]?.[0];
    expect(sent?.verb).toBe("fileWrite");
    if (sent?.verb !== "fileWrite") throw new Error("Expected fileWrite");
    expect(sent.args.agent).toBe("Client");
    expect(sent.args.files.length).toBeGreaterThan(3);
    expect(sent.args.files.every(file => file.createOnly)).toBe(true);
    expect(await readdir(ctx.root)).toEqual([]);
  });

  it("sends an imported database as one create-only authored write", async () => {
    const ctx = await context();
    await writeFile(join(ctx.root, "source.csv"), "name\nPat\n");
    const request = vi.fn<NonNullable<ToolContext["request"]>>(async () => ({ ok: false, reason: "Engine unavailable. Restart dohc.", written: [] }));
    ctx.request = request;
    expect(await importData(ctx, { sourcePath: "source.csv", databasePath: "people.sqlite", tableName: "people" }, "Client")).toMatchObject({ ok: false });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({ verb: "fileWrite", args: { agent: "Client", files: [{ path: "people.sqlite", createOnly: true }] } });
    expect(await readdir(ctx.root)).toEqual(["source.csv"]);
  });
});
