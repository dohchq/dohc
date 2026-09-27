// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredDrafts,
  isStoredDraftCurrent,
  loadStoredDrafts,
  ORPHANED_DRAFT_RETENTION_MS,
  ORPHANED_DRAFT_STORAGE_PREFIX,
  remapStoredDraftPaths,
  replaceStoredDraft,
  storeDraft,
} from "./orphanedDraftStorage";

const now = 1_800_000_000_000;
const key = `${ORPHANED_DRAFT_STORAGE_PREFIX}fixture`;
const draft = { id: 1, workspaceId: "ws", path: "a.md", text: "keep me", capturedAtMs: now };

beforeEach(() => {
  clearStoredDrafts();
  vi.stubGlobal("dohcDesktop", { platform: "linux" });
});

afterEach(() => {
  clearStoredDrafts();
  vi.unstubAllGlobals();
});

it("writes version 1 on capture and replacement and restores both", () => {
  expect(storeDraft(draft)).toBe(true);
  const storedKey = localStorage.key(0)!;
  expect(JSON.parse(localStorage.getItem(storedKey)!)).toEqual({ ...draft, version: 1 });
  expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(draft)]);
  const replacement = { ...draft, text: "updated" };
  expect(replaceStoredDraft(replacement)).toBe(true);
  expect(JSON.parse(localStorage.getItem(storedKey)!)).toEqual({ ...replacement, version: 1 });
  expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(replacement)]);
});

describe.each([{}, { version: 1 }])("supported format %j", (version) => {
  it("restores the draft without rewriting it", () => {
    const raw = JSON.stringify({ ...draft, ...version });
    localStorage.setItem(key, raw);
    expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(draft)]);
    expect(isStoredDraftCurrent(draft.id)).toBe(true);
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it("writes version 1 when repairing a timestamp", () => {
    localStorage.setItem(key, JSON.stringify({ ...draft, ...version, capturedAtMs: 0 }));
    expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(draft)]);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ ...draft, version: 1 });
  });

  it("writes version 1 when remapping a path", () => {
    localStorage.setItem(key, JSON.stringify({ ...draft, ...version }));
    remapStoredDraftPaths("ws", () => "b.md");
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ ...draft, path: "b.md", version: 1 });
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
  it("ignores the draft on restore and leaves its bytes intact", () => {
    const raw = JSON.stringify(row);
    localStorage.setItem(key, raw);
    expect(loadStoredDrafts(now)).toEqual([]);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(isStoredDraftCurrent(draft.id)).toBe(false);
    expect(storeDraft(draft)).toBe(true);
    expect(loadStoredDrafts(now)).toEqual([expect.objectContaining(draft)]);
    expect(localStorage.getItem(key)).toBe(raw);
  });

  it.each(["b.md", ".env"])("leaves its bytes intact when paths move to %s", (path) => {
    const raw = JSON.stringify(row);
    localStorage.setItem(key, raw);
    const project = vi.fn(() => path);
    expect(remapStoredDraftPaths("ws", project).size).toBe(0);
    expect(project).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(raw);
  });
});
