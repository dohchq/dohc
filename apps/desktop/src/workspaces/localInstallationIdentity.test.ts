import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readOrCreateLocalInstallationId } from "./localInstallationIdentity";
import { createTestScratch } from "./testTemp";

let dir: string;
beforeEach(async () => { dir = await createTestScratch("dohc-local-id-"); });
const idFile = () => join(dir, "dohc-local-id.json");

describe("local installation id", () => {
  it("persists one id across restarts and leaves no temporary file", async () => {
    const onError = vi.fn();
    const first = readOrCreateLocalInstallationId(idFile(), onError);
    expect(first).toMatch(/^local:/u);
    expect(readOrCreateLocalInstallationId(idFile(), onError)).toBe(first);
    expect(JSON.parse(await readFile(idFile(), "utf8"))).toEqual({ id: first });
    expect(await readdir(dir)).toEqual(["dohc-local-id.json"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps an existing id, whatever else an earlier build wrote beside it", async () => {
    await writeFile(idFile(), JSON.stringify({ id: "local:preexisting", authorContextSecret: "a".repeat(64) }));
    expect(readOrCreateLocalInstallationId(idFile(), vi.fn())).toBe("local:preexisting");
  });

  it.each([
    ["not JSON", "not json {"],
    ["truncated", '{"id":"local:trunc'],
    ["an empty id", JSON.stringify({ id: "" })],
    ["a control character", JSON.stringify({ id: "local:\u0007" })],
    ["no id", JSON.stringify({ name: "x" })],
  ])("keeps a file with %s beside a fresh saved id", async (_case, text) => {
    await writeFile(idFile(), text);
    const onError = vi.fn();
    const id = readOrCreateLocalInstallationId(idFile(), onError);
    expect(id).toMatch(/^local:[0-9a-f-]{36}$/u);
    expect(readOrCreateLocalInstallationId(idFile(), onError)).toBe(id);
    const kept = (await readdir(dir)).filter(name => name.startsWith("dohc-local-id.json.corrupt-"));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(dir, kept[0]!), "utf8")).toBe(text);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps every unusable file it sets aside, however close together", async () => {
    for (const text of ["first {", "second {"]) {
      await writeFile(idFile(), text);
      readOrCreateLocalInstallationId(idFile(), vi.fn());
    }
    const kept = (await readdir(dir)).filter(name => name.startsWith("dohc-local-id.json.corrupt-"));
    const texts = await Promise.all(kept.map(name => readFile(join(dir, name), "utf8")));
    expect(texts.sort()).toEqual(["first {", "second {"]);
  });

  it("answers an unsaved id without throwing when the folder cannot be made", async () => {
    await writeFile(join(dir, "blocker"), "a file where the folder should be");
    const onError = vi.fn();
    const id = readOrCreateLocalInstallationId(join(dir, "blocker", "dohc-local-id.json"), onError);
    expect(id).toMatch(/^local:/u);
    expect(onError).toHaveBeenCalledOnce();
    expect((await readdir(dir)).sort()).toEqual(["blocker"]);
  });

  it("creates a missing state folder", async () => {
    const file = join(dir, "state", "dohc-local-id.json");
    const id = readOrCreateLocalInstallationId(file, vi.fn());
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ id });
  });

  it("leaves an id it cannot read in place and answers an unsaved id", async () => {
    await mkdir(idFile());
    const onError = vi.fn();
    expect(readOrCreateLocalInstallationId(idFile(), onError)).toMatch(/^local:/u);
    expect(onError).toHaveBeenCalledOnce();
    expect(await readdir(dir)).toEqual(["dohc-local-id.json"]);
  });
});
