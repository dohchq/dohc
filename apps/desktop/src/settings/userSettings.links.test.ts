import { lstat, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { ensureUserSettingsFile, USER_SETTINGS_FILE } from "./userSettingsStore";

describe("creating default user settings", () => {
  it.each([false, true])("leaves an existing link and its target alone (target exists: %s)", async (exists) => {
    const root = await createTestScratch("dohc-settings-link-");
    const path = join(root, USER_SETTINGS_FILE), target = join(root, "outside.json");
    if (exists) await writeFile(target, "{}");
    await symlink(target, path, "file");
    const link = await readlink(path);
    await expect(ensureUserSettingsFile(root)).resolves.toBe(path);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readlink(path)).toBe(link);
    if (exists) expect(await readFile(target, "utf8")).toBe("{}");
    else await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
