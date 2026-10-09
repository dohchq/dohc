import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDeclinedDm,
  declineDm,
  readDeclinedDms,
} from "./dmRequestStore";
import { createTestScratch } from "./testTemp";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let dir = "";
const file = () => join(dir, "dohc-dm-requests.json");

beforeEach(async () => {
  dir = await createTestScratch("dohc-dm-request-");
});
afterEach(async () => {
  vi.mocked(writeFileSync).mockReset();
  await rm(dir, { recursive: true, force: true });
});

describe("dmRequestStore", () => {
  it("persists decline and request-again changes idempotently", () => {
    expect(readDeclinedDms(file())).toEqual(new Set());

    expect(declineDm(file(), "share-1")).toBe(true);
    expect(declineDm(file(), "share-1")).toBe(true);
    expect(readDeclinedDms(file())).toEqual(new Set(["share-1"]));

    expect(clearDeclinedDm(file(), "share-1")).toBe(true);
    expect(clearDeclinedDm(file(), "share-1")).toBe(true);
    expect(readDeclinedDms(file())).toEqual(new Set());
  });

  it("keeps independent declined requests across writes", () => {
    expect(declineDm(file(), "share-A")).toBe(true);
    expect(declineDm(file(), "share-B")).toBe(true);
    expect(clearDeclinedDm(file(), "share-A")).toBe(true);
    expect(readDeclinedDms(file())).toEqual(new Set(["share-B"]));
  });

  it("fails closed on a present but malformed file", () => {
    writeFileSync(file(), "not json");
    expect(readDeclinedDms(file())).toBeNull();
    expect(declineDm(file(), "share-A")).toBe(false);
    expect(clearDeclinedDm(file(), "share-A")).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe("not json");
  });

  it("fails closed without replacing an unreadable populated file", () => {
    const target = file();
    expect(declineDm(target, "share-A")).toBe(true);
    chmodSync(target, 0o000);
    let stillReadable = true;
    try {
      readFileSync(target);
    } catch {
      stillReadable = false;
    }
    if (stillReadable) {
      chmodSync(target, 0o600);
      return;
    }

    expect(readDeclinedDms(target)).toBeNull();
    expect(declineDm(target, "share-B")).toBe(false);
    expect(clearDeclinedDm(target, "share-A")).toBe(false);
    chmodSync(target, 0o600);
    expect(readDeclinedDms(target)).toEqual(new Set(["share-A"]));
  });

  it("reports failure when an atomic write cannot reach disk", () => {
    const target = file();
    expect(declineDm(target, "share-A")).toBe(true);
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    vi.mocked(writeFileSync)
      .mockImplementationOnce(() => { throw failure; })
      .mockImplementationOnce(() => { throw failure; });
    expect(declineDm(target, "share-B")).toBe(false);
    expect(clearDeclinedDm(target, "share-A")).toBe(false);
    expect(readDeclinedDms(target)).toEqual(new Set(["share-A"]));
    expect(readdirSync(dir)).toEqual(["dohc-dm-requests.json"]);
  });
});
