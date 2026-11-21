// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftFilesForTests } from "./orphanedDraftFiles.testHarness";
import {
  clearStoredDrafts,
  draftFileWritesSettled,
  isStoredDraftCurrent,
  isStoredDraftPending,
  loadDraftFiles,
  loadStoredDrafts,
  ORPHANED_DRAFT_RETENTION_MS,
  remapStoredDraftPaths,
  replaceStoredDraft,
  storeDraft,
} from "./orphanedDraftStorage";

const now = 1_800_000_000_000;
const key = "00000000-0000-4000-8000-000000000001";
const draft = { id: 1, workspaceId: "ws", path: "a.md", text: "keep me", capturedAtMs: now };
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
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("dohcDesktop", {
      platform: "linux",
      ...disk.calls,
      writeSetAsideDraft: (input: Parameters<typeof disk.calls.writeSetAsideDraft>[0]) =>
        gate.then(() => disk.calls.writeSetAsideDraft(input)),
      removeSetAsideDraft: (input: Parameters<typeof disk.calls.removeSetAsideDraft>[0]) =>
        gate.then(() => disk.calls.removeSetAsideDraft(input)),
    });
  });
  afterEach(() => release());

  it("stores the draft under the new path", async () => {
    const stored = storeDraft(draft);
    remapStoredDraftPaths("ws", () => "b.md");
    expect(isStoredDraftPending(draft.id)).toBe(true);
    release();
    expect(await stored).toBe(true);
    await draftFileWritesSettled();
    expect(disk.rows().map((row) => row.path)).toEqual(["b.md"]);
    expect(isStoredDraftCurrent(draft.id)).toBe(true);
  });

  it("removes the plaintext file when the new path is a secret", async () => {
    const stored = storeDraft(draft);
    expect([...remapStoredDraftPaths("ws", () => ".env")]).toEqual([draft.id]);
    release();
    await stored;
    await draftFileWritesSettled();
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("dohcDesktop", {
      platform: "linux",
      ...disk.calls,
      writeSetAsideDraft: (input: Parameters<typeof disk.calls.writeSetAsideDraft>[0]) =>
        gate.then(() => {
          if (input.raw.includes("newer typing")) throw new Error("No space left on device");
          return disk.calls.writeSetAsideDraft(input);
        }),
      removeSetAsideDraft: (input: Parameters<typeof disk.calls.removeSetAsideDraft>[0]) =>
        gate.then(() => disk.calls.removeSetAsideDraft(input)),
    });
    const replaced = replaceStoredDraft({ ...draft, text: "newer typing" });
    remapStoredDraftPaths("ws", () => renamed);
    release();
    expect(await replaced).toBe(false);
    await draftFileWritesSettled();
    expect(disk.rows().map((row) => [row.path, row.text])).toEqual(
      paths.map((path) => [path, draft.text]),
    );
  },
);

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
    remapStoredDraftPaths("ws", () => "b.md");
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
    const project = vi.fn(() => path);
    expect(remapStoredDraftPaths("ws", project).size).toBe(0);
    await draftFileWritesSettled();
    expect(project).not.toHaveBeenCalled();
    expect(disk.files.get(key)).toBe(raw);
  });
});
