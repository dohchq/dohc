import { createHash } from "node:crypto";
import { link, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openedLocalState } from "../testing/preparedLocalState";
import { createTestScratch } from "./testTemp";
import { outsideWriteCopies, OutsideWriteCopyError } from "./outsideWriteCopies";
import * as durableFiles from "../atomicReplaceFile";

vi.mock("../atomicReplaceFile", { spy: true });

async function setup() {
  const recorded = new Map<string, string>();
  const isRecorded = async (path: string, sha256: string) => recorded.get(path) === sha256;
  const rootPath = await createTestScratch("outside-copy-");
  const workspace = { workspaceId: "outside-copy", rootPath };
  await openedLocalState(workspace);
  return { rootPath, workspace, recorded, isRecorded, copies: outsideWriteCopies(workspace) };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("materialization keeps outside bytes before replacement", () => {
  it.each([undefined, ".dohc", ".dohc/local", ".dohc/local/outside-write-copies"])("reports the cause and exact recovery path, blocker=%s", blockingPath => {
    const rootPath = "C:\\workspace";
    const error = new OutsideWriteCopyError("n.md", new Error("write refused"), rootPath, blockingPath);
    expect(error.message.split("\n")[0]).toBe(blockingPath
      ? `dohc could not keep a copy of n.md, because ${blockingPath} is in the way, so it left n.md as it was. Move ${blockingPath} somewhere else, then choose Try again.`
      : "dohc could not keep a copy of n.md, so it left n.md as it was. Check that dohc can write to the workspace folder, then choose Try again.");
    expect(error.message).toContain("Cause: write refused");
    expect(error.message).toContain(blockingPath ? `Blocking file: ${join(rootPath, blockingPath)}` : `Workspace folder: ${rootPath}`);
    expect(error.message).not.toContain("Move it somewhere else.");
  });

  it.each([".dohc", ".dohc/local", ".dohc/local/outside-write-copies"])("names a blocking file at %s after the local-state guard refuses", async blockingPath => {
    const { rootPath, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "outside");
    await rm(join(rootPath, blockingPath), { recursive: true, force: true });
    await writeFile(join(rootPath, blockingPath), "blocker");
    const cause = await copies.beforeWrite("n.md", Buffer.from("incoming"), () => undefined, isRecorded).catch(error => error as unknown);
    expect(cause).toBeInstanceOf(Error);
    const error = await OutsideWriteCopyError.from("n.md", cause, rootPath);
    expect(error.message).toContain(`because ${blockingPath} is in the way`);
    expect(error.message).toContain(`Move ${blockingPath} somewhere else, then choose Try again.`);
    expect(error.message).toContain(`Blocking file: ${join(rootPath, blockingPath)}`);
    expect(await readFile(join(rootPath, "n.md"), "utf8")).toBe("outside");
  });

  it("names a malformed copy record as the blocking file", async () => {
    const { rootPath, copies, isRecorded } = await setup();
    await copies.list();
    const blockingPath = ".dohc/local/outside-write-copies/broken.json";
    await writeFile(join(rootPath, blockingPath), "invalid");
    await writeFile(join(rootPath, "n.md"), "outside");
    const fresh = outsideWriteCopies({ rootPath, workspaceId: "outside-copy" });
    const cause = await fresh.beforeWrite("n.md", null, () => undefined, isRecorded).catch(error => error as unknown);
    const error = await OutsideWriteCopyError.from("n.md", cause, rootPath);
    expect(error.message).toContain(`Move ${blockingPath} somewhere else, then choose Try again.`);
    expect(error.message).toContain(`Blocking file: ${join(rootPath, blockingPath)}`);
  });

  it.each(["different", "unknown"])("keeps bytes with a %s baseline and rediscovers the copy after restart", async baseline => {
    const { rootPath, workspace, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), Buffer.from([65, 255, 0, 10]));
    if (baseline === "different") recorded.set("n.md", hash("BASE"));
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    const rows = await outsideWriteCopies(workspace).list();
    expect(rows).toEqual([["n.md", "n (kept copy).md", expect.any(String)]]);
    expect(await readFile(join(rootPath, rows[0]![1]))).toEqual(Buffer.from([65, 255, 0, 10]));
    expect(await readFile(join(rootPath, "n.md"))).toEqual(Buffer.from([65, 255, 0, 10]));
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    expect(await copies.list()).toEqual(rows);
  });

  it.each(["baseline", "incoming"])("does not copy bytes equal to the %s", async same => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "same");
    if (same === "baseline") recorded.set("n.md", hash("same"));
    const admit = vi.fn();
    await copies.beforeWrite("n.md", Buffer.from(same === "incoming" ? "same" : "OWNER-1"), admit, isRecorded);
    expect(admit).not.toHaveBeenCalled();
    expect(await copies.list()).toEqual([]);
  });

  it("prunes missing copy receipts on the first list", async () => {
    const { rootPath, workspace, copies, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    await rm(join(rootPath, "n (kept copy).md"));
    expect(await copies.list()).toEqual([]);
    expect(await readdir(join(rootPath, ".dohc/local/outside-write-copies"))).toEqual([]);
    expect(await outsideWriteCopies(workspace).list()).toEqual([]);
  });

  it("leaves the original when preserving the copy fails", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    const replace = vi.fn();
    await expect((async () => {
      await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => { throw new Error("copy refused"); }, isRecorded);
      replace();
    })()).rejects.toThrow("copy refused");
    expect(replace).not.toHaveBeenCalled();
    expect(await readFile(join(rootPath, "n.md"), "utf8")).toBe("AGENT-1");
  });

  it("does not replace the original if the durable receipt fails", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    vi.spyOn(durableFiles, "atomicWriteFile").mockRejectedValueOnce(new Error("receipt flush failed"));
    const cause = await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded).catch(error => error as unknown);
    expect(cause).toBeInstanceOf(Error);
    const error = await OutsideWriteCopyError.from("n.md", cause, rootPath);
    expect(error.message.split("\n")[0]).toBe("dohc could not keep a copy of n.md, so it left n.md as it was. Check that dohc can write to the workspace folder, then choose Try again.");
    expect(error.message).toContain(`Workspace folder: ${rootPath}\nCause: receipt flush failed`);
    expect(await readFile(join(rootPath, "n.md"), "utf8")).toBe("AGENT-1");
    expect(await readFile(join(rootPath, "n (kept copy).md"), "utf8")).toBe("AGENT-1");
    expect(await outsideWriteCopies({ workspaceId: "outside-copy", rootPath }).list()).toEqual([]);
  });

  it("does not reuse a copy replaced with a hard link to the original", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    await rm(join(rootPath, "n (kept copy).md"));
    await link(join(rootPath, "n.md"), join(rootPath, "n (kept copy).md"));
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    expect(await copies.list()).toEqual([["n.md", "n (kept copy 2).md", expect.any(String)]]);
    await writeFile(join(rootPath, "n.md"), "OWNER-1");
    expect(await readFile(join(rootPath, "n (kept copy 2).md"), "utf8")).toBe("AGENT-1");
  });

  it("never overwrites an existing copy name", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    await writeFile(join(rootPath, "n (kept copy).md"), "earlier copy");
    await copies.beforeWrite("n.md", Buffer.from("OWNER-1"), () => undefined, isRecorded);
    expect(await copies.list()).toEqual([["n.md", "n (kept copy 2).md", expect.any(String)]]);
    expect(await readFile(join(rootPath, "n (kept copy).md"), "utf8")).toBe("earlier copy");
  });

  it("keeps outside bytes before deletion, but creates nothing for an absent file", async () => {
    const { rootPath, copies, recorded, isRecorded } = await setup();
    await copies.beforeWrite("absent.md", null, () => undefined, isRecorded);
    await writeFile(join(rootPath, "n.md"), "AGENT-1");
    await copies.beforeWrite("n.md", null, () => undefined, isRecorded);
    expect(await copies.list()).toEqual([["n.md", "n (kept copy).md", expect.any(String)]]);
    expect((await readdir(rootPath)).filter(name => name.includes("kept copy"))).toHaveLength(1);
  });
});
