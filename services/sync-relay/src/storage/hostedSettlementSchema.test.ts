import { afterEach, expect, it } from "vitest";
import {
  testStorage,
  closeTestStorages,
  inspectDatabase,
  storagePath,
  closeTestStorage,
  reopenTestStorage,
} from "../testing";
import {
  initializeHostedSettlementSchema,
  SETTLEMENT_CUTS,
  SETTLEMENT_BINDINGS,
  SETTLEMENT_SCHEMA_MARKER,
} from "./hostedSettlementSchema";
import type { SqliteDb } from "./types";
afterEach(closeTestStorages);
it("retains the hosted schema across reopen", async () => {
  const storage = await testStorage(),
    path = storagePath(storage);
  closeTestStorage(storage);
  const next = reopenTestStorage(path);
  expect(
    inspectDatabase(path)
      .prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?")
      .get(SETTLEMENT_SCHEMA_MARKER),
  ).toBeDefined();
  closeTestStorage(next);
});
it.each([
  SETTLEMENT_CUTS,
  SETTLEMENT_BINDINGS,
  "settlement_cut_usage_insert",
  "settlement_binding_usage_insert",
  "settlement_admission_usage_insert",
])(
  "refuses missing proof retention object %s without repairing it",
  async (name) => {
    const storage = await testStorage(),
      path = storagePath(storage);
    closeTestStorage(storage);
    const db = inspectDatabase(path);
    db.exec(
      `DROP ${name.startsWith("sync_relay_") ? "TABLE" : "TRIGGER"} ${name}`,
    );
    expect(() => initializeHostedSettlementSchema(db as SqliteDb)).toThrow(
      "Hosted settlement schema is missing or damaged.",
    );
    db.close();
    expect(() => reopenTestStorage(path)).toThrow(
      /schema is missing or damaged/,
    );
  },
);
it("refuses unmarked hosted retention tables", async () => {
  const storage = await testStorage(),
    path = storagePath(storage);
  closeTestStorage(storage);
  const db = inspectDatabase(path);
  db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id=?").run(
    SETTLEMENT_SCHEMA_MARKER,
  );
  expect(() => initializeHostedSettlementSchema(db as SqliteDb)).toThrow(
    "Hosted settlement schema is missing or damaged.",
  );
  db.close();
});
