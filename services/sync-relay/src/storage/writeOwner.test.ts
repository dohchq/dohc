import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RelayWriteOwner, type RelayContinuity } from "./writeOwner";
import type { SqliteDb } from "./types";

function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE work(value INTEGER); CREATE TABLE sync_relay_continuity(singleton INTEGER,stamp INTEGER,nonce TEXT,previous_nonce TEXT); INSERT INTO sync_relay_continuity VALUES(1,0,'initial',NULL)");
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
      confirm(stamp, nonce, previousNonce) {
        expect(stamp).toBe(1);
        expect(previousNonce).toBe("initial");
        expect(raw.prepare("SELECT nonce,previous_nonce FROM sync_relay_continuity").get()).toMatchObject({nonce, previous_nonce: "initial"});
        expect(raw.prepare("SELECT value FROM work").get()?.value).toBe(7);
        expect(raw.prepare("SELECT stamp FROM sync_relay_continuity").get()?.stamp).toBe(1);
        expect(() => raw.exec("ROLLBACK")).toThrow(/no transaction/);
        calls.push("confirm");
      },
      close() {},
    };
    const owner = new RelayWriteOwner(db, continuity, 0, "initial");
    try {
      expect(owner.write(() => { raw.exec("INSERT INTO work VALUES(7)"); return "accepted"; })).toBe("accepted");
      calls.push("returned");
      expect(calls).toEqual(["confirm", "returned"]);
      owner.write(() => raw.prepare("SELECT * FROM work").all());
      expect(calls).toEqual(["confirm", "returned"]);
    } finally { owner.close(); }
  });

  it("links consecutive writes with fresh nonces and one record update each", () => {
    const {raw, db} = fixture();
    const confirmations: {stamp: number; nonce: string; previousNonce: string}[] = [];
    const owner = new RelayWriteOwner(db, {
      confirm(stamp, nonce, previousNonce) { confirmations.push({stamp, nonce, previousNonce}); },
      close() {},
    }, 0, "initial");
    try {
      owner.write(() => raw.exec("INSERT INTO work VALUES(1)"));
      owner.write(() => raw.exec("INSERT INTO work VALUES(2)"));
      expect(confirmations).toHaveLength(2);
      expect(confirmations[0]).toMatchObject({stamp: 1, previousNonce: "initial"});
      expect(confirmations[1]).toMatchObject({stamp: 2, previousNonce: confirmations[0]!.nonce});
      expect(confirmations[1]!.nonce).not.toBe(confirmations[0]!.nonce);
      expect(raw.prepare("SELECT stamp,nonce,previous_nonce FROM sync_relay_continuity").get()).toMatchObject({
        stamp: 2, nonce: confirmations[1]!.nonce, previous_nonce: confirmations[0]!.nonce,
      });
    } finally {owner.close();}
  });

  it.each([false, true])("retires an uncertain confirmation (record committed: %s) without acknowledging", confirmed => {
    const { raw, db } = fixture();
    let settled = 0;
    const owner = new RelayWriteOwner(db, {
      confirm() { if (confirmed) settled = 1; throw new Error("lost confirmation result"); },
      close() {},
    }, 0, "initial");
    try {
      const standing = owner.captureStanding();
      expect(() => owner.write(() => raw.exec("INSERT INTO work VALUES(7)"))).toThrow(/lost confirmation/);
      expect(raw.prepare("SELECT value FROM work").get()?.value).toBe(7);
      expect(raw.prepare("SELECT stamp FROM sync_relay_continuity").get()?.stamp).toBe(1);
      expect(settled).toBe(confirmed ? 1 : 0);
      expect(standing).toThrow(/unavailable/);
      expect(() => owner.write(() => {})).toThrow(/unavailable/);
    } finally { owner.close(); }
  });

  it("does not update the record before a transaction commits", () => {
    const { raw, db } = fixture();
    let confirmed = false;
    const owner = new RelayWriteOwner(db, {confirm() { confirmed = true; }, close() {}}, 0, "initial");
    try {
      expect(() => owner.write(() => { raw.exec("INSERT INTO work VALUES(7)"); throw new Error("refused"); })).toThrow(/refused/);
      expect(raw.prepare("SELECT * FROM work").all()).toEqual([]);
      expect(raw.prepare("SELECT stamp,nonce FROM sync_relay_continuity").get()).toMatchObject({stamp: 0, nonce: "initial"});
      expect(confirmed).toBe(false);
      expect(owner.unavailable.aborted).toBe(false);
    } finally { owner.close(); }
  });
});
