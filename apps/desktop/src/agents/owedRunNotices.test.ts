import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import { createOwedRunNotices } from "./owedRunNotices";

describe("owed run notices", () => {
  it("keeps each owed run in its file until it is removed", async () => {
    const path = join(await createTestScratch("dohc-owed-run-notices-"), "state", "owed-run-notices.json");
    const owed = createOwedRunNotices(() => path);
    await Promise.all([owed.add("trip", "run-1"), owed.add("trip", "run-1"), owed.add("work", "run-2")]);

    const reopened = createOwedRunNotices(() => path);
    expect(await reopened.list("trip")).toEqual(["run-1"]);
    expect(await reopened.list("work")).toEqual(["run-2"]);

    await owed.remove("trip", "run-1");
    expect(await createOwedRunNotices(() => path).list("trip")).toEqual([]);
  });

  it("changes nothing when its file cannot be written, so the change can be tried again", async () => {
    const root = await createTestScratch("dohc-owed-run-notices-");
    const good = join(root, "owed-run-notices.json");
    const blocker = join(root, "blocker");
    await writeFile(blocker, "");
    let path = good;
    const owed = createOwedRunNotices(() => path);
    await owed.add("trip", "run-1");

    path = join(blocker, "owed-run-notices.json");
    await expect(owed.remove("trip", "run-1")).rejects.toThrow();
    expect(await owed.list("trip")).toEqual(["run-1"]);

    path = good;
    await owed.remove("trip", "run-1");
    expect(await createOwedRunNotices(() => good).list("trip")).toEqual([]);
  });

  it("sets a damaged file aside and starts empty", async () => {
    const root = await createTestScratch("dohc-owed-run-notices-");
    const path = join(root, "owed-run-notices.json");
    await writeFile(path, "{not json");
    const owed = createOwedRunNotices(() => path);
    expect(await owed.list("trip")).toEqual([]);
    await owed.add("trip", "run-1");
    expect(await createOwedRunNotices(() => path).list("trip")).toEqual(["run-1"]);
    expect((await readdir(root)).sort()).toEqual(["owed-run-notices.json", "owed-run-notices.json.damaged"]);
  });
});
