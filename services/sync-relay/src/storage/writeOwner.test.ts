import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RelayWriteOwner, type RelayContinuity } from "./writeOwner";
import type { SqliteDb } from "./types";

function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE work(value INTEGER); CREATE TABLE sync_relay_continuity(singleton INTEGER,stamp INTEGER); INSERT INTO sync_relay_continuity VALUES(1,0)");
  const db: SqliteDb = {
    prepare: sql => raw.prepare(sql) as unknown as ReturnType<SqliteDb["prepare"]>,
    close: () => raw.close(),
    exec: sql => raw.exec(sql),
  };
  return { raw, db };
}

describe("relay write confirmation", () => {
  it("confirms the committed stamp before returning, and skips continuity for no-op writes", () => {
    const { raw, db } = fixture();
    const calls: string[] = [];
    const continuity: RelayContinuity = {
      reserve(previous) { expect(previous).toBe(0); calls.push("reserve"); return 1; },
      confirm(stamp, previous) {
        expect([stamp, previous]).toEqual([1, 0]);
        expect(raw.prepare("SELECT value FROM work").get()?.value).toBe(7);
        expect(raw.prepare("SELECT stamp FROM sync_relay_continuity").get()?.stamp).toBe(1);
        expect(() => raw.exec("ROLLBACK")).toThrow(/no transaction/);
        calls.push("confirm");
      },
      cancel() { throw new Error("Unexpected cancellation"); },
      close() {},
    };
    const owner = new RelayWriteOwner(db, continuity);
    try {
      expect(owner.write(() => { raw.exec("INSERT INTO work VALUES(7)"); return "accepted"; })).toBe("accepted");
      calls.push("returned");
      expect(calls).toEqual(["reserve", "confirm", "returned"]);
      owner.write(() => raw.prepare("SELECT * FROM work").all());
      expect(calls).toEqual(["reserve", "confirm", "returned"]);
    } finally { owner.close(); }
  });

  it.each([false, true])("retires an uncertain confirmation (record committed: %s) without cancelling or acknowledging", confirmed => {
    const { raw, db } = fixture();
    let cancelled = false, settled = 0;
    const owner = new RelayWriteOwner(db, {
      reserve: () => 1,
      confirm() { if (confirmed) settled = 1; throw new Error("lost confirmation result"); },
      cancel() { cancelled = true; },
      close() {},
    });
    try {
      const standing = owner.captureStanding();
      expect(() => owner.write(() => raw.exec("INSERT INTO work VALUES(7)"))).toThrow(/lost confirmation/);
      expect(raw.prepare("SELECT value FROM work").get()?.value).toBe(7);
      expect(raw.prepare("SELECT stamp FROM sync_relay_continuity").get()?.stamp).toBe(1);
      expect(settled).toBe(confirmed ? 1 : 0);
      expect(cancelled).toBe(false);
      expect(standing).toThrow(/unavailable/);
      expect(() => owner.write(() => {})).toThrow(/unavailable/);
    } finally { owner.close(); }
  });

  it("does not cancel an uncertain reservation even after rolling the relay transaction back", () => {
    const { raw, db } = fixture();
    let cancelled = false, confirmed = false;
    const owner = new RelayWriteOwner(db, {
      reserve() { throw new Error("lost reservation result"); },
      confirm() { confirmed = true; },
      cancel() { cancelled = true; },
      close() {},
    });
    try {
      expect(() => owner.write(() => raw.exec("INSERT INTO work VALUES(7)"))).toThrow(/lost reservation/);
      expect(raw.prepare("SELECT * FROM work").all()).toEqual([]);
      expect(cancelled).toBe(false);
      expect(confirmed).toBe(false);
      expect(owner.unavailable.aborted).toBe(true);
    } finally { owner.close(); }
  });
});
