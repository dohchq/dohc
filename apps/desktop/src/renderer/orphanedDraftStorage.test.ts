// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftFilesForTests } from "./orphanedDraftFiles.testHarness";
import {
  clearStoredDrafts,
  draftFileWritesSettled,
  forgetStoredDraft,
  isStoredDraftCurrent,
  isStoredDraftPending,
  loadDraftFiles,
  loadStoredDrafts,
  ORPHANED_DRAFT_RETENTION_MS,
  remapStoredDraftPaths,
  replaceStoredDraft,
  storedDraftSettled,
  storeDraft,
} from "./orphanedDraftStorage";

const now = 1_800_000_000_000;
const key = "00000000-0000-4000-8000-000000000001";
const draft = { id: 1, workspaceId: "ws", path: "a.md", text: "keep me", capturedAtMs: now };
const rename = (fromPath: string, toPath: string) => [
  { id: `${fromPath}->${toPath}`, kind: "file" as const, fromPath, toPath },
];
let disk: ReturnType<typeof draftFilesForTests>;

beforeEach(async () => {
  clearStoredDrafts();
  disk = draftFilesForTests();
  vi.stubGlobal("dohcDesktop", { platform: "linux", ...disk.calls });
  await loadDraftFiles();
});

afterEach(async () => {
  await draftFileWritesSettled();
  clearStoredDrafts();
  vi.unstubAllGlobals();
});

it("writes version 1 on capture and replacement and restores both", async () => {
  expect(await storeDraft(draft)).toBe(true);
  const [storedKey] = [...disk.files.keys()];
  expect(JSON.parse(disk.files.get(storedKey!)!)).toEqual({ ...draft, version: 1 });
  expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(draft)]);
  const replacement = { ...draft, text: "updated" };
  expect(await replaceStoredDraft(replacement)).toBe(true);
  expect(JSON.parse(disk.files.get(storedKey!)!)).toEqual({ ...replacement, version: 1 });
  expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(replacement)]);
});

it("counts a draft kept only once main answers that its file is written", async () => {
  let answer!: (written: boolean) => void;
  const write = vi.fn(
    (input: { key: string; raw: string; ifCurrent: string | null }) =>
      new Promise<boolean>((resolve) => {
        answer = (written) => {
          if (written) disk.set(input.key, input.raw);
          resolve(written);
        };
      }),
  );
  vi.stubGlobal("dohcDesktop", { platform: "linux", ...disk.calls, writeSetAsideDraft: write });
  const stored = storeDraft(draft);
  expect(isStoredDraftPending(draft.id)).toBe(true);
  expect(isStoredDraftCurrent(draft.id)).toBe(false);
  answer(true);
  expect(await stored).toBe(true);
  expect(isStoredDraftPending(draft.id)).toBe(false);
  expect(isStoredDraftCurrent(draft.id)).toBe(true);
});

describe("a rename while the first write is still on its way", () => {
  let release!: () => void;
  beforeEach(() => {
    release = disk.hold();
  });
  afterEach(() => release());

  it("stores the draft under the new path", async () => {
    const stored = storeDraft(draft);
    remapStoredDraftPaths("ws", rename("a.md", "b.md"));
    expect(isStoredDraftPending(draft.id)).toBe(true);
    release();
    expect(await stored).toBe(true);
    await draftFileWritesSettled();
    expect(disk.rows().map((row) => row.path)).toEqual(["b.md"]);
    expect(isStoredDraftCurrent(draft.id)).toBe(true);
  });

  it("removes the plaintext file when the new path is a secret", async () => {
    const stored = storeDraft(draft);
    expect([...remapStoredDraftPaths("ws", rename("a.md", ".env"))]).toEqual([draft.id]);
    release();
    await stored;
    await draftFileWritesSettled();
    expect(disk.files.size).toBe(0);
  });

  it("stores a replacement sent after the rename", async () => {
    void storeDraft(draft);
    remapStoredDraftPaths("ws", rename("a.md", "b.md"));
    const replaced = replaceStoredDraft({ ...draft, path: "b.md", text: "newer typing" });
    release();
    expect(await replaced).toBe(true);
    await draftFileWritesSettled();
    expect(disk.rows().map((row) => [row.path, row.text])).toEqual([["b.md", "newer typing"]]);
    expect(isStoredDraftCurrent(draft.id)).toBe(true);
  });

  it("dismissing removes the moved file after a replacement sent after the rename fails", async () => {
    void storeDraft(draft);
    remapStoredDraftPaths("ws", rename("a.md", "b.md"));
    disk.fail(new Error("No space left on device"), (raw) => raw.includes("newer typing"));
    void replaceStoredDraft({ ...draft, path: "b.md", text: "newer typing" });
    release();
    await draftFileWritesSettled();
    forgetStoredDraft(draft.id);
    await draftFileWritesSettled();
    expect(disk.files.size).toBe(0);
  });

  it("a second rename to a secret path stops counting the draft as kept at once", async () => {
    void storeDraft(draft);
    remapStoredDraftPaths("ws", rename("a.md", "b.md"));
    expect([...remapStoredDraftPaths("ws", rename("b.md", ".env"))]).toEqual([draft.id]);
    expect(isStoredDraftCurrent(draft.id)).toBe(false);
    release();
    await draftFileWritesSettled();
    expect(isStoredDraftCurrent(draft.id)).toBe(false);
    expect(disk.files.size).toBe(0);
  });
});

it.each([
  ["b.md", ["b.md"]],
  [".env", []],
])(
  "moves the older file to %s when the replacement in flight during the rename fails",
  async (renamed, paths) => {
    expect(await storeDraft(draft)).toBe(true);
    const release = disk.hold();
    disk.fail(new Error("No space left on device"), (raw) => raw.includes("newer typing"));
    const replaced = replaceStoredDraft({ ...draft, text: "newer typing" });
    remapStoredDraftPaths("ws", rename("a.md", renamed));
    release();
    expect(await replaced).toBe(false);
    await draftFileWritesSettled();
    expect(disk.rows().map((row) => [row.path, row.text])).toEqual(
      paths.map((path) => [path, draft.text]),
    );
  },
);

it("settles a draft once its own writes are answered, whatever other drafts wait on", async () => {
  const answers = new Map<string, () => void>();
  vi.stubGlobal("dohcDesktop", {
    platform: "linux",
    ...disk.calls,
    writeSetAsideDraft: (input: Parameters<typeof disk.calls.writeSetAsideDraft>[0]) =>
      new Promise<boolean>((resolve) =>
        answers.set(JSON.parse(input.raw).text, () =>
          resolve(disk.calls.writeSetAsideDraft(input)),
        ),
      ),
  });
  void storeDraft(draft);
  void storeDraft({ ...draft, id: 2, text: "other" });
  let settled = false;
  void storedDraftSettled(draft.id).then(() => (settled = true));
  answers.get(draft.text)!();
  await expect.poll(() => settled).toBe(true);
  answers.get("other")!();
});

describe("after a replacement fails during a rename", () => {
  let release!: () => void;
  beforeEach(async () => {
    expect(await storeDraft(draft)).toBe(true);
    release = disk.hold();
    disk.fail(new Error("No space left on device"), (raw) => raw.includes("newer typing"));
    void replaceStoredDraft({ ...draft, text: "newer typing" });
    remapStoredDraftPaths("ws", rename("a.md", "b.md"));
  });
  afterEach(() => release());

  it("dismissing the draft removes the moved file", async () => {
    release();
    await draftFileWritesSettled();
    forgetStoredDraft(draft.id);
    await draftFileWritesSettled();
    expect(disk.files.size).toBe(0);
  });

  it("a second rename to a secret path removes the moved file", async () => {
    remapStoredDraftPaths("ws", rename("b.md", ".env"));
    release();
    await draftFileWritesSettled();
    expect(disk.files.size).toBe(0);
  });
});

it("moves a draft another window is still writing when this window renames its file", async () => {
  const release = disk.hold();
  const raw = JSON.stringify({ ...draft, version: 1 });
  void disk.calls.writeSetAsideDraft({ key, raw, ifCurrent: null });
  remapStoredDraftPaths("ws", rename("a.md", ".env"));
  release();
  await draftFileWritesSettled();
  expect(disk.files.size).toBe(0);
});

it("leaves a draft main could not move at risk, and dismissing still removes its file", async () => {
  expect(await storeDraft(draft)).toBe(true);
  disk.fail(new Error("No space left on device"));
  remapStoredDraftPaths("ws", rename("a.md", "b.md"));
  await draftFileWritesSettled();
  expect(isStoredDraftCurrent(draft.id)).toBe(false);
  expect(disk.rows().map((row) => row.path)).toEqual(["a.md"]);
  disk.fail(null);
  forgetStoredDraft(draft.id);
  await draftFileWritesSettled();
  expect(disk.files.size).toBe(0);
});

it("reports a draft whose write failed as not kept", async () => {
  disk.fail(new Error("No space left on device"));
  expect(await storeDraft(draft)).toBe(false);
  expect(isStoredDraftPending(draft.id)).toBe(false);
  expect(isStoredDraftCurrent(draft.id)).toBe(false);
  expect(disk.files.size).toBe(0);
});

it("reports a refused replacement as not kept while the file keeps the older text", async () => {
  expect(await storeDraft(draft)).toBe(true);
  disk.fail(new Error("No space left on device"));
  expect(await replaceStoredDraft({ ...draft, text: "newer typing" })).toBe(false);
  expect(isStoredDraftCurrent(draft.id)).toBe(false);
  expect(disk.rows().map((row) => row.text)).toEqual([draft.text]);
});

it("restores why main set a draft aside, and refuses a reason it does not know", async () => {
  const recovery = {
    objectId: "object",
    updateBase64: "AAA=",
    recordId: "a".repeat(64),
    reason: "deleted" as const,
  };
  expect(await storeDraft({ ...draft, recovery })).toBe(true);
  expect(loadStoredDrafts(now)).toEqual([expect.objectContaining({ recovery })]);
  disk.clear();
  disk.set(
    key,
    JSON.stringify({ ...draft, version: 1, recovery: { ...recovery, reason: "unknown" } }),
  );
  expect(loadStoredDrafts(now)).toEqual([]);
});

it("preserves a superseded file another window changed before cleanup", async () => {
  const original = JSON.stringify({ ...draft, version: 1 });
  disk.set(key, original);
  loadStoredDrafts(now);
  const changed = JSON.stringify({ ...draft, text: "another window typing", version: 1 });
  const write = disk.calls.writeSetAsideDraft;
  vi.stubGlobal("dohcDesktop", {
    platform: "linux",
    ...disk.calls,
    writeSetAsideDraft: async (input: { key: string; raw: string; ifCurrent: string | null }) => {
      const written = await write(input);
      if (input.key !== key) disk.set(key, changed);
      return written;
    },
  });
  expect(await replaceStoredDraft({ ...draft, text: "newer typing" })).toBe(true);
  await draftFileWritesSettled();
  expect(disk.files.get(key)).toBe(changed);
  expect(
    loadStoredDrafts(now)
      .map((row) => row.text)
      .sort(),
  ).toEqual(["another window typing", "newer typing"]);
});

it("keeps the superseded file when the new copy cannot be written", async () => {
  const original = JSON.stringify({ ...draft, version: 1 });
  disk.set(key, original);
  loadStoredDrafts(now);
  disk.fail(new Error("No space left on device"));
  expect(await replaceStoredDraft({ ...draft, text: "newer typing" })).toBe(false);
  disk.fail(null);
  expect(disk.files.get(key)).toBe(original);
  expect(loadStoredDrafts(now).map((row) => row.text)).toEqual([draft.text]);
});

describe.each([{}, { version: 1 }])("supported format %j", (version) => {
  it("restores the draft without rewriting it", () => {
    const raw = JSON.stringify({ ...draft, ...version });
    disk.set(key, raw);
    expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(draft)]);
    expect(isStoredDraftCurrent(draft.id)).toBe(true);
    expect(disk.files.get(key)).toBe(raw);
  });

  it("writes version 1 when repairing a timestamp", async () => {
    disk.set(key, JSON.stringify({ ...draft, ...version, capturedAtMs: 0 }));
    expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(draft)]);
    await draftFileWritesSettled();
    expect(JSON.parse(disk.files.get(key)!)).toEqual({ ...draft, version: 1 });
  });

  it("writes version 1 when remapping a path", async () => {
    disk.set(key, JSON.stringify({ ...draft, ...version }));
    remapStoredDraftPaths("ws", rename("a.md", "b.md"));
    await draftFileWritesSettled();
    expect(JSON.parse(disk.files.get(key)!)).toEqual({ ...draft, path: "b.md", version: 1 });
  });
});

describe.each([
  { ...draft, version: 2 },
  { ...draft, version: 2, capturedAtMs: now - ORPHANED_DRAFT_RETENTION_MS },
  { ...draft, version: 2, capturedAtMs: 0 },
  { ...draft, version: 2, path: ".env" },
  { version: 2, futurePayload: "keep these bytes" },
  { ...draft, version: "1" },
  { ...draft, version: null },
])("unsupported format %j", (row) => {
  it("ignores the draft on restore and leaves its bytes intact", async () => {
    const raw = JSON.stringify(row);
    disk.set(key, raw);
    expect(loadStoredDrafts(now)).toEqual([]);
    expect(disk.files.get(key)).toBe(raw);
    expect(isStoredDraftCurrent(draft.id)).toBe(false);
    expect(await storeDraft(draft)).toBe(true);
    expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(draft)]);
    expect(disk.files.get(key)).toBe(raw);
  });

  it.each(["b.md", ".env"])("leaves its bytes intact when paths move to %s", async (path) => {
    const raw = JSON.stringify(row);
    disk.set(key, raw);
    expect(remapStoredDraftPaths("ws", rename("a.md", path)).size).toBe(0);
    await draftFileWritesSettled();
    expect(disk.files.get(key)).toBe(raw);
  });
});
