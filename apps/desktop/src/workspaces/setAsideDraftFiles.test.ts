import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { SetAsideDraftChange } from "../ipc/bridgeContract";
import { setAsideDraftFiles } from "./setAsideDraftFiles";
import { createTestScratch } from "./testTemp";

const key = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const draft = (text: string, path = "a.md", workspaceId = "ws") =>
  JSON.stringify({ version: 1, workspaceId, path, text });
const rename = (fromPath: string, toPath: string) => [
  { id: "rename", kind: "file" as const, fromPath, toPath },
];

async function store() {
  const directory = join(await createTestScratch("dohc-set-aside-drafts-"), "set-aside-drafts");
  const changes: SetAsideDraftChange[] = [];
  return { directory, changes, files: setAsideDraftFiles(directory, (c) => changes.push(c)) };
}

it("answers a write once its file holds the draft, and tells every window", async () => {
  const { directory, changes, files } = await store();
  expect(await files.write(key, draft("kept"), null)).toBe(true);
  expect(await readFile(join(directory, `${key}.json`), "utf8")).toBe(draft("kept"));
  expect(changes).toEqual([{ key, raw: draft("kept") }]);
  expect(await files.list()).toEqual([{ key, raw: draft("kept") }]);
});

it("writes and removes only while the file holds what the caller last saw", async () => {
  const { changes, files } = await store();
  await files.write(key, draft("first"), null);
  expect(await files.write(key, draft("stale"), null)).toBe(false);
  expect(await files.write(key, draft("second"), draft("other"))).toBe(false);
  expect(await files.remove(key, draft("other"))).toBe(false);
  expect(await files.write(key, draft("second"), draft("first"))).toBe(true);
  expect(await files.remove(key, draft("second"))).toBe(true);
  expect(await files.list()).toEqual([]);
  expect(changes.map((change) => change.raw)).toEqual([draft("first"), draft("second"), null]);
});

it("runs one file's writes in the order they arrive", async () => {
  const { files } = await store();
  const answers = await Promise.all([
    files.write(key, draft("first"), null),
    files.write(key, draft("second"), draft("first")),
    files.remove(key, draft("second")),
  ]);
  expect(answers).toEqual([true, true, true]);
  expect(await files.list()).toEqual([]);
});

it("refuses a draft for a path that never enters plaintext storage", async () => {
  const { directory, files } = await store();
  expect(() => files.write(key, draft("API_KEY=shh", ".env"), null)).toThrow(
    "This path cannot enter set-aside drafts.",
  );
  expect(() => files.write(key, "not json", null)).toThrow();
  expect(await readdir(directory).catch(() => [])).toEqual([]);
});

it("removes a write an earlier app run left unfinished, and keeps finished drafts", async () => {
  const { directory, files } = await store();
  await files.write(key, draft("kept"), null);
  const unfinished = `${key}.json.tmp-${process.pid + 1}-00000000-0000-4000-8000-000000000002`;
  await writeFile(join(directory, unfinished), draft("half"));
  expect(await files.list()).toEqual([{ key, raw: draft("kept") }]);
  expect(await readdir(directory)).toEqual([`${key}.json`]);
});

it("moves a draft with a rename after the writes sent before it, and before those sent after", async () => {
  const { files } = await store();
  const answers = await Promise.all([
    files.write(key, draft("first"), null),
    files.move("ws", rename("a.md", "b.md")),
    files.write(key, draft("second", "b.md"), draft("first", "b.md")),
  ]);
  expect(answers).toEqual([true, null, true]);
  expect(await files.list()).toEqual([{ key, raw: draft("second", "b.md") }]);
});

it("finishes renames onto a secret path with no window waiting for them", async () => {
  const { directory, changes, files } = await store();
  void files.write(key, draft("API_KEY=shh"), null);
  void files.move("ws", rename("a.md", "b.md"));
  await files.move("ws", rename("b.md", ".env"));
  expect(await readdir(directory)).toEqual([]);
  expect(changes.map((change) => change.raw)).toEqual([
    draft("API_KEY=shh"),
    draft("API_KEY=shh", "b.md"),
    null,
  ]);
});

it("moves only the renamed workspace's drafts", async () => {
  const { files } = await store();
  await files.write(key, draft("mine"), null);
  await files.write(other, draft("theirs", "a.md", "elsewhere"), null);
  await files.move("ws", rename("a.md", "b.md"));
  expect(await files.list()).toEqual([
    { key, raw: draft("mine", "b.md") },
    { key: other, raw: draft("theirs", "a.md", "elsewhere") },
  ]);
});
