import {DatabaseSync} from "node:sqlite";
import {expect, it} from "vitest";
import {RestoreAdmissionReads} from "./restoreAdmissionReads";
import type {SqliteDb} from "./types";

function fixture() {
  const raw = new DatabaseSync(":memory:"), db = raw as unknown as SqliteDb;
  raw.exec("CREATE TABLE evidence(id INTEGER, bytes BLOB, label TEXT); INSERT INTO evidence VALUES (1,x'0102',NULL),(2,x'0304','other')");
  return {raw, db, reads: new RestoreAdmissionReads(db)};
}
it("pins only the selected rows and their returned columns", () => {
  const {raw, db, reads} = fixture();
  try {
    reads.capture(() => db.prepare("SELECT bytes,label FROM evidence WHERE id=?").get(1));
    raw.exec("UPDATE evidence SET bytes=x'0506' WHERE id=2");
    reads.assertCurrent();
    raw.exec("UPDATE evidence SET bytes=x'0708' WHERE id=1");
    expect(() => reads.assertCurrent()).toThrow("changed during validation");
  } finally {raw.close();}
});
it.each(["INSERT INTO evidence VALUES(3,x'0506','added')", "DELETE FROM evidence WHERE id=2",
  "UPDATE evidence SET label='changed' WHERE id=2"])("pins all rows: %s", sql => {
  const {raw, db, reads} = fixture();
  try {
    reads.capture(() => db.prepare("SELECT * FROM evidence ORDER BY id").all());
    reads.assertCurrent(); raw.exec(sql);
    expect(() => reads.assertCurrent()).toThrow("changed during validation");
  } finally {raw.close();}
});
it("pins absent rows, duplicate counts, nulls, and the first row read by get", () => {
  const {raw, db, reads} = fixture();
  try {
    reads.capture(() => {
      db.prepare("SELECT * FROM evidence WHERE id=3").get();
      db.prepare("SELECT label FROM evidence UNION ALL SELECT label FROM evidence").all();
      db.prepare("SELECT bytes FROM evidence ORDER BY id").get();
    });
    reads.assertCurrent();
    raw.exec("UPDATE evidence SET label=NULL WHERE id=2");
    expect(() => reads.assertCurrent()).toThrow("changed during validation");
    raw.exec("UPDATE evidence SET label='other' WHERE id=2; INSERT INTO evidence VALUES(3,x'0506','added')");
    expect(() => reads.assertCurrent()).toThrow("changed during validation");
  } finally {raw.close();}
});
it("restores the connection after a failed capture and refuses unbounded or mutating statements", () => {
  const {raw, db, reads} = fixture(), prepare = db.prepare;
  try {
    expect(() => reads.capture(() => db.prepare("UPDATE evidence SET label='bad'").run())).toThrow("only read");
    expect(db.prepare).toBe(prepare);
    expect(() => reads.capture(() => db.prepare("SELECT * FROM evidence").iterate())).toThrow("bounded reads");
    expect(db.prepare).toBe(prepare);
  } finally {raw.close();}
});
