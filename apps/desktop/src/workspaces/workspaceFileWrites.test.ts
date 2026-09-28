import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_FILE_WRITE_BYTES, MAX_FILE_WRITE_FILES } from "@dohc/cli/protocol";
import { createTestScratch } from "./testTemp";
import { AuthoredTextChangedError, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { withOrderedWorkspaceTargetPath, writeWorkspaceText } from "./workspaceAssets";
import { decodeFileWriteContent, writeWorkspaceFilesAs } from "./workspaceFileWrites";
import * as policyFile from "./workspaceEnginePolicyFile";

const author = { kind: "agent", agentId: "Test agent", onBehalfOf: "local", depth: 3 } as const;
const file = (path: string, content = "new") => ({ path, contentBase64: Buffer.from(content).toString("base64") });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture() {
  const rootPath = await createTestScratch("dohc-file-writes-");
  await mkdir(join(rootPath, ".dohc"));
  const operation = { workspace: { rootPath, attachmentId: Symbol(), readOnly: false, shareView: undefined as unknown },
    state: {}, signal: new AbortController().signal, assertCurrent: vi.fn() };
  const capture = { writeAuthoredFile: vi.fn<WorkspaceEngineCapture["writeAuthoredFile"]>(async (absolute, content, _author, options) => {
    await options?.beforeWrite?.(absolute);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    return { resolvedAbsolutePath: absolute, materializeOutcome: "applied" };
  }) };
  return { rootPath, operation, capture, run: (files: Parameters<typeof writeWorkspaceFilesAs>[1]) =>
    writeWorkspaceFilesAs(operation, files, author, { capture, requestId: "batch" }) };
}

describe("workspace file write admission", () => {
  it.each(["file", "link"])("refuses a %s at .dohc in the desktop", async kind => {
    const f = await fixture();
    await rmdir(join(f.rootPath, ".dohc"));
    if (kind === "file") await writeFile(join(f.rootPath, ".dohc"), "blocked");
    else {
      const outside = await createTestScratch("dohc-metadata-outside-");
      await symlink(outside, join(f.rootPath, ".dohc"), process.platform === "win32" ? "junction" : "dir");
    }
    expect(await f.run([file("plain.txt")])).toMatchObject({ ok: false, written: [], reason: expect.stringContaining("policy directory") });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
    await expect(readFile(join(f.rootPath, "plain.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "win32").each(["notes.md.", "notes.md ", "build./x", "build /x"])("refuses Windows alias %s before writing", async path => {
    const f = await fixture();
    await writeFile(join(f.rootPath, ".dohc/files.toml"), '[[rule]]\npath = "build/**"\ntracked = false\n');
    expect(await f.run([file("first.txt"), file(path)])).toMatchObject({ ok: false, written: [], reason: expect.stringContaining("trailing dots and spaces") });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it("bounds batch count before admission", async () => {
    const f = await fixture();
    expect(await f.run(Array.from({ length: MAX_FILE_WRITE_FILES + 1 }, (_, n) => file(`${n}.txt`, ""))))
      .toMatchObject({ ok: false, written: [], reason: expect.stringContaining("256 files") });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it("reads policy once for admission and again at each write", async () => {
    const f = await fixture();
    const readPolicy = vi.spyOn(policyFile, "readWorkspaceEnginePolicy");
    const implementation = f.capture.writeAuthoredFile.getMockImplementation()!;
    f.capture.writeAuthoredFile.mockImplementation(async (...args) => {
      expect(readPolicy).toHaveBeenCalledTimes(f.capture.writeAuthoredFile.mock.calls.length);
      return implementation(...args);
    });
    try {
      expect(await f.run([file("a.txt"), file("b.txt")])).toMatchObject({ ok: true });
      expect(readPolicy).toHaveBeenCalledTimes(3);
    } finally { readPolicy.mockRestore(); }
  });

  it.each(["../escape.txt", ".env", "notes.md", "notes.markdown", "scene.excalidraw", "shared-with-me/a.txt", ".dohc/private.txt"])("refuses %s before writing the batch", async path => {
    const f = await fixture();
    expect(await f.run([file("first.txt"), file(path)])).toMatchObject({ ok: false, written: [] });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it.each(["readOnly", "shareView"] as const)("refuses a %s workspace", async kind => {
    const f = await fixture();
    if (kind === "readOnly") f.operation.workspace.readOnly = true;
    else f.operation.workspace.shareView = {};
    expect(await f.run([file("plain.txt")])).toMatchObject({ ok: false, written: [] });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it.each(["notes.md", "scene.excalidraw", ".env", "hidden.txt"])("refuses an alias to %s", async target => {
    const f = await fixture();
    await writeFile(join(f.rootPath, target), "original");
    await writeFile(join(f.rootPath, ".dohc/files.toml"), '[[rule]]\npath = "hidden.txt"\ntracked = false\n');
    await symlink(join(f.rootPath, target), join(f.rootPath, "alias.txt"));
    expect(await f.run([file("alias.txt")])).toMatchObject({ ok: false, written: [] });
    expect(await readFile(join(f.rootPath, target), "utf8")).toBe("original");
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it("checks the spelled path's policy and secret floor too", async () => {
    const f = await fixture();
    await writeFile(join(f.rootPath, "plain.txt"), "original");
    await symlink(join(f.rootPath, "plain.txt"), join(f.rootPath, ".env"));
    expect(await f.run([file(".env")])).toMatchObject({ ok: false });
    await symlink(join(f.rootPath, "plain.txt"), join(f.rootPath, "excluded.txt"));
    await writeFile(join(f.rootPath, ".dohc/files.toml"), '[[rule]]\npath = "excluded.txt"\ntracked = false\n');
    expect(await f.run([file("excluded.txt")])).toMatchObject({ ok: false });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it("refuses a symlink escape", async () => {
    const f = await fixture();
    const outside = await createTestScratch("dohc-file-outside-");
    await symlink(outside, join(f.rootPath, "alias"), process.platform === "win32" ? "junction" : "dir");
    expect(await f.run([file("alias/new.txt")])).toMatchObject({ ok: false, written: [] });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it("reads files.toml after the editor ordering queue opens", async () => {
    const f = await fixture();
    await writeFile(join(f.rootPath, "queued.txt"), "original");
    const entered = barrier(), release = barrier();
    const held = withOrderedWorkspaceTargetPath(f.rootPath, await realpath(join(f.rootPath, "queued.txt")), async () => { entered.release(); await release.promise; });
    await entered.promise;
    const pending = f.run([file("queued.txt")]);
    await writeFile(join(f.rootPath, ".dohc/files.toml"), '[[rule]]\npath = "queued.txt"\ntracked = false\n');
    release.release();
    await held;
    expect(await pending).toMatchObject({ ok: false, written: [] });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it("rechecks policy when the capture queue opens", async () => {
    const f = await fixture();
    f.capture.writeAuthoredFile.mockImplementationOnce(async (absolute, _bytes, _author, options) => {
      await writeFile(join(f.rootPath, ".dohc/files.toml"), '[[rule]]\npath = "queued.txt"\ntracked = false\n');
      await options?.beforeWrite?.(absolute);
      throw new Error("Admission should have refused");
    });
    expect(await f.run([file("queued.txt")])).toMatchObject({ ok: false, written: [], reason: expect.stringContaining("History cannot record") });
    await expect(readFile(join(f.rootPath, "queued.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the current hash for a stale write", async () => {
    const f = await fixture();
    const current = Buffer.alloc(2 * 1024 * 1024, "current");
    await writeFile(join(f.rootPath, "plain.txt"), current);
    f.capture.writeAuthoredFile.mockRejectedValueOnce(new AuthoredTextChangedError("plain.txt"));
    expect(await f.run([{ ...file("plain.txt"), expectedSha256: "0".repeat(64) }])).toMatchObject({
      ok: false, written: [], currentSha256: createHash("sha256").update(current).digest("hex"),
    });
    expect(await readFile(join(f.rootPath, "plain.txt"))).toEqual(current);
  });

  it("returns only the first two paths when file three fails", async () => {
    const f = await fixture();
    const implementation = f.capture.writeAuthoredFile.getMockImplementation()!;
    f.capture.writeAuthoredFile.mockImplementation(async (...args) => {
      if (args[0].endsWith("3.txt")) throw new Error("Disk full. Free space and retry.");
      return implementation(...args);
    });
    expect(await f.run([1, 2, 3, 4, 5].map(n => file(`${n}.txt`)))).toEqual({
      ok: false, written: ["1.txt", "2.txt"], path: "3.txt", reason: "Disk full. Free space and retry.",
    });
    expect(f.capture.writeAuthoredFile).toHaveBeenCalledTimes(3);
    for (const [index, call] of f.capture.writeAuthoredFile.mock.calls.entries()) {
      expect(call[2]).toEqual(author);
      expect(call[3]).toMatchObject({ requestId: `fileWrite:batch:${index}`, correlationId: "fileWrite:batch" });
    }
    for (const n of [3, 4, 5]) await expect(readFile(join(f.rootPath, `${n}.txt`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes the editor's next save report a conflict after an agent overwrite", async () => {
    const f = await fixture();
    await writeFile(join(f.rootPath, "plain.txt"), "original");
    const before = createHash("sha256").update("original").digest("hex");
    expect(await f.run([file("plain.txt", "agent edit")])).toMatchObject({ ok: true });
    expect(await writeWorkspaceText(f.rootPath, "plain.txt", "editor edit", before)).toMatchObject({ status: "conflict" });
    expect(await readFile(join(f.rootPath, "plain.txt"), "utf8")).toBe("agent edit");
  });

  it.each(["error", "skipped", undefined])("refuses unpublished outcome %s", async materializeOutcome => {
    const f = await fixture();
    f.capture.writeAuthoredFile.mockResolvedValueOnce({ resolvedAbsolutePath: join(f.rootPath, "plain.txt"), materializeOutcome });
    expect(await f.run([file("plain.txt")])).toMatchObject({ ok: false, written: [], reason: expect.stringContaining("could not publish") });
  });

  it("names malformed policy as the reason to fix before retrying", async () => {
    const f = await fixture();
    await writeFile(join(f.rootPath, ".dohc/files.toml"), "invalid [[");
    expect(await f.run([file("plain.txt")])).toMatchObject({ ok: false, written: [], reason: expect.stringContaining("Fix the reported policy errors") });
    expect(f.capture.writeAuthoredFile).not.toHaveBeenCalled();
  });

  it("reports publication conflicts as failures", async () => {
    const f = await fixture();
    f.capture.writeAuthoredFile.mockResolvedValueOnce({ resolvedAbsolutePath: join(f.rootPath, "plain.txt"), materializeOutcome: "conflict" });
    expect(await f.run([file("plain.txt")])).toMatchObject({ ok: false, written: [], currentSha256: null });
  });

  it("accepts exactly 10 MiB and refuses one extra byte or invalid base64", () => {
    expect(decodeFileWriteContent(Buffer.alloc(MAX_FILE_WRITE_BYTES).toString("base64"))).toHaveLength(MAX_FILE_WRITE_BYTES);
    expect(() => decodeFileWriteContent(Buffer.alloc(MAX_FILE_WRITE_BYTES + 1).toString("base64"))).toThrow("10 MiB");
    for (const value of ["!", "Zg", "Zh==", "Zg==\n"]) expect(() => decodeFileWriteContent(value)).toThrow("base64");
  });
});
