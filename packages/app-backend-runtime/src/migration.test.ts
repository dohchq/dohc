import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { authorizeMigration } from "./migration.ts";

it("permits SQLite's scoped constraint check while adding a field", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL) STRICT; INSERT INTO items VALUES('one');");
    authorizeMigration(db, ["items"]);
    db.exec("ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'New' CHECK(status IN ('New','Done'));");
    db.setAuthorizer(null);
    expect(db.prepare("SELECT status FROM items").get()!.status).toBe("New");
  } finally { db.close(); }
});

it("refuses unscoped quick checks and checks of undeclared tables", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL); CREATE TABLE private(id TEXT PRIMARY KEY NOT NULL);");
    authorizeMigration(db, ["items"]);
    expect(() => db.exec("PRAGMA quick_check")).toThrow(/not authorized/);
    expect(() => db.exec("PRAGMA quick_check(private)")).toThrow(/not authorized/);
    expect(() => db.prepare("SELECT * FROM pragma_quick_check").all()).toThrow(/not authorized/);
    expect(() => db.prepare("SELECT * FROM private").all()).toThrow(/prohibited/);
  } finally { db.close(); }
});
