import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { folderEntriesOrNone } from "./folderEntries";
import { createTestScratch } from "./testTemp";

it("reads a folder, answers none for a missing one, and throws when it cannot read one", async () => {
  const root = await createTestScratch("dohc-folder-entries-");
  await mkdir(join(root, "ideas"));
  await writeFile(join(root, "ideas", "collection.yaml"), "name: Ideas\n");

  await expect(folderEntriesOrNone(join(root, "ideas"))).resolves.toEqual(["collection.yaml"]);
  await expect(folderEntriesOrNone(join(root, "gone"))).resolves.toEqual([]);
  // A path that is not a folder cannot be read as one, so it is not empty.
  await expect(folderEntriesOrNone(join(root, "ideas", "collection.yaml"))).rejects.toMatchObject({ code: "ENOTDIR" });
});
