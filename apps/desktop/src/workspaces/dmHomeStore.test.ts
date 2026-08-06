import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimDmHome, readDmHome, readDmHomes } from "./dmHomeStore";
import { createTestScratch } from "./testTemp";

// WS-MU-C3 cross-workspace DM contamination fix: a received DM is pinned to
// EXACTLY ONE local workspace so it can't be materialized into every workspace
// that opens Chats.

let dir = "";
const file = () => join(dir, "dohc-dm-homes.json");

beforeEach(async () => {
  dir = await createTestScratch("dohc-dm-home-");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("dmHomeStore", () => {
  it("homes a DM in the first claiming workspace and skips it in every other", () => {
    // Unhomed → workspace A claims it (auto-joins).
    expect(claimDmHome(file(), "share-1", "ws-A")).toBe(true);
    // The SAME workspace re-confirming still processes it.
    expect(claimDmHome(file(), "share-1", "ws-A")).toBe(true);
    // Workspace B is NOT the home → it must skip (no duplication).
    expect(claimDmHome(file(), "share-1", "ws-B")).toBe(false);
    // The pin is readable without a claim, for the cheap short-circuit.
    expect(readDmHome(file(), "share-1")).toBe("ws-A");
    // A different DM is independent.
    expect(readDmHome(file(), "share-2")).toBeNull();
    expect(claimDmHome(file(), "share-2", "ws-B")).toBe(true);
  });

  it("persists placement across reads (a fresh process sees the same home)", () => {
    expect(claimDmHome(file(), "share-1", "ws-A")).toBe(true);
    // Simulate a later run: no in-memory state, read straight from disk.
    expect(readDmHome(file(), "share-1")).toBe("ws-A");
    expect(claimDmHome(file(), "share-1", "ws-B")).toBe(false);
  });

  it("treats a MISSING file (ENOENT) as empty/unhomed", () => {
    expect(readDmHome(file(), "share-x")).toBeNull();
    // ENOENT is genuinely empty, so a first claim succeeds and persists.
    expect(claimDmHome(file(), "share-x", "ws-A")).toBe(true);
    expect(readDmHome(file(), "share-x")).toBe("ws-A");
  });

  // Scoping a whole received lane to one workspace needs every pin at once,
  // not one probe per share (#618).
  it("reads every pin at once, and answers empty rather than guessing when the map is unreadable", () => {
    const f = file();
    expect(readDmHomes(f)).toEqual({});
    expect(claimDmHome(f, "share-A", "ws-A")).toBe(true);
    expect(claimDmHome(f, "share-B", "ws-B")).toBe(true);
    expect(readDmHomes(f)).toEqual({ "share-A": "ws-A", "share-B": "ws-B" });

    chmodSync(f, 0o000);
    let stillReadable = true;
    try {
      readFileSync(f);
    } catch {
      stillReadable = false;
    }
    if (stillReadable) {
      // Running as root ignores mode bits — can't simulate the read error here.
      chmodSync(f, 0o600);
      return;
    }
    // An unreadable map declines the scoping; it never invents a pin, and it
    // never widens one workspace's claim over another's.
    expect(readDmHomes(f)).toEqual({});
    chmodSync(f, 0o600);
  });

  it("does NOT clobber other homes when a POPULATED map is momentarily unreadable (non-ENOENT)", () => {
    const f = file();
    expect(claimDmHome(f, "share-A", "ws-A")).toBe(true);
    expect(claimDmHome(f, "share-B", "ws-B")).toBe(true);
    // Make the populated file unreadable (EACCES, not ENOENT).
    chmodSync(f, 0o000);
    let stillReadable = true;
    try {
      readFileSync(f);
    } catch {
      stillReadable = false;
    }
    if (stillReadable) {
      // Running as root ignores mode bits — can't simulate the read error here.
      chmodSync(f, 0o600);
      return;
    }
    // A claim for a NEW share must FAIL CLOSED (return false) and must NOT
    // rewrite the map from an assumed-empty state.
    expect(claimDmHome(f, "share-C", "ws-C")).toBe(false);
    chmodSync(f, 0o600);
    // The pre-existing pins survived — no partial/clobbering rewrite happened.
    expect(readDmHome(f, "share-A")).toBe("ws-A");
    expect(readDmHome(f, "share-B")).toBe("ws-B");
    expect(readDmHome(f, "share-C")).toBeNull();
  });

  it("treats an un-persistable claim as unsuccessful (a claim only wins when it reaches disk)", () => {
    const f = file();
    expect(claimDmHome(f, "share-A", "ws-A")).toBe(true);
    // Block the atomic temp write: a directory sits exactly where writeMap's
    // temp file must go, so writeFileSync fails and the rename never happens.
    const tmp = `${f}.tmp-${process.pid}`;
    mkdirSync(tmp);
    try {
      // The claim can't be persisted → it must NOT report success…
      expect(claimDmHome(f, "share-B", "ws-B")).toBe(false);
      // …and the durable map is untouched: share-A intact, share-B absent.
      expect(readDmHome(f, "share-A")).toBe("ws-A");
      expect(readDmHome(f, "share-B")).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
