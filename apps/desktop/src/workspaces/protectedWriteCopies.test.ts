import { randomUUID } from "node:crypto";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openedLocalState } from "../testing/preparedLocalState";
import { createTestScratch } from "./testTemp";
import { PROTECTED_COPIES_PATH, ProtectedCopyIdError, ProtectedCopyReadError, protectedWriteCopies } from "./protectedWriteCopies";

async function setup() {
  const rootPath = await createTestScratch("protected-copy-");
  const workspace = { workspaceId: "protected-copy", rootPath };
  await openedLocalState(workspace);
  return { rootPath, workspace, copies: protectedWriteCopies(workspace) };
}

describe("protected write copies", () => {
  it("keeps a change once per version, lists it after a restart, and removes it", async () => {
    const { rootPath, workspace, copies } = await setup();
    expect(await copies.keep(".env", "TOKEN=mine", "main")).toBe(true);
    expect(await copies.keep(".env", "TOKEN=mine", "main")).toBe(false);
    expect(await copies.keep(".env", "TOKEN=mine", "trip")).toBe(true);
    expect(await copies.keep(".env", "TOKEN=later", "main")).toBe(true);

    const restarted = protectedWriteCopies(workspace);
    const rows = await restarted.list();
    expect(rows.map(([path]) => path)).toEqual([".env", ".env", ".env"]);
    const kept = await Promise.all(rows.map(async ([, id]) => (await restarted.read(id))!));
    expect(kept.map(({ versionId, text }) => `${versionId}:${text}`).sort())
      .toEqual(["main:TOKEN=later", "main:TOKEN=mine", "trip:TOKEN=mine"]);
    const { id } = kept.find(({ versionId, text }) => versionId === "main" && text === "TOKEN=mine")!;

    expect(await restarted.remove(id)).toBe(true);
    expect(await restarted.remove(id)).toBe(false);
    expect(await restarted.read(id)).toBeNull();
    expect((await restarted.list()).map(([, listed]) => listed)).not.toContain(id);
    expect(await readdir(join(rootPath, PROTECTED_COPIES_PATH))).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32")("keeps copies only its own user can read", async () => {
    const { rootPath, copies } = await setup();
    await copies.keep(".env", "TOKEN=mine", "main");
    const dir = join(rootPath, PROTECTED_COPIES_PATH);
    const [name] = await readdir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, name!))).mode & 0o777).toBe(0o600);
  });

  it("names a copy it cannot read by its file, never by its text", async () => {
    const { rootPath, copies } = await setup();
    await copies.list();
    const id = randomUUID();
    await writeFile(join(rootPath, PROTECTED_COPIES_PATH, `${id}.json`), "{\"text\":\"SECRET-VALUE");
    const wrongName = randomUUID();
    await writeFile(join(rootPath, PROTECTED_COPIES_PATH, `${wrongName}.json`),
      JSON.stringify({ path: ".env", id: randomUUID(), versionId: "main", createdAtMs: 1, text: "SECRET-VALUE" }));
    const errors: unknown[] = [];

    expect(await copies.list((error) => errors.push(error))).toEqual([]);
    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error).toBeInstanceOf(ProtectedCopyReadError);
      expect(String(error)).not.toContain("SECRET-VALUE");
    }
    expect(errors.map((error) => (error as ProtectedCopyReadError).path).sort())
      .toEqual([`${PROTECTED_COPIES_PATH}/${id}.json`, `${PROTECTED_COPIES_PATH}/${wrongName}.json`].sort());
    await expect(copies.read(id)).rejects.toThrow(`Could not read ${PROTECTED_COPIES_PATH}/${id}.json`);
  });

  it("refuses an id that is not one dohc made", async () => {
    const { copies } = await setup();
    await expect(copies.read("../x")).rejects.toBeInstanceOf(ProtectedCopyIdError);
    await expect(copies.remove("../../.env")).rejects.toBeInstanceOf(ProtectedCopyIdError);
  });

  it("clears what a stopped write left behind", async () => {
    const { rootPath, copies } = await setup();
    await copies.list();
    const dir = join(rootPath, PROTECTED_COPIES_PATH);
    const leftover = `${randomUUID()}.json.tmp-123-${randomUUID()}`;
    await writeFile(join(dir, leftover), "{\"text\":\"TOKEN=half");

    expect(await copies.list()).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});
