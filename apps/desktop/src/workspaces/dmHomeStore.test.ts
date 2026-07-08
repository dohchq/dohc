import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimDmHome, readDmHome } from "./dmHomeStore";

// WS-MU-C3 cross-workspace DM contamination fix: a received DM is pinned to
// EXACTLY ONE local workspace so it can't be materialized into every workspace
// that opens Chats.

let dir = "";
const file = () => join(dir, "dohc-dm-homes.json");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dohc-dm-home-"));
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

  it("treats a missing/unreadable map as empty (unhomed)", () => {
    expect(readDmHome(file(), "share-x")).toBeNull();
  });
});
