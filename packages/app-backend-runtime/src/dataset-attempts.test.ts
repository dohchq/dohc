import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDatasetAttempts, parseDatasetAttemptRequest, type DatasetAttemptScope } from "./dataset-attempts.js";
const open: DatabaseSync[] = [];
const scope: DatasetAttemptScope = { workspaceId: "workspace", datasetId: "dataset", appId: "publication", principalKey: "participant", operationId: "create", revisionSha256: "a".repeat(64) };
function fixture(maxAttemptsPerDataset = 4096) {
  const db = new DatabaseSync(":memory:"); open.push(db);
  db.exec("CREATE TABLE usage(bytes INTEGER); INSERT INTO usage VALUES(0)");
  const options = { db, maxAttemptsPerDataset, transaction<T>(run: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const value = run(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } }, account(_scope: DatasetAttemptScope, bytes: number) { db.prepare("UPDATE usage SET bytes=bytes+?").run(bytes); } };
  return { db, options, attempts: createDatasetAttempts(options) };
}
afterEach(() => { for (const db of open.splice(0)) db.close(); });
describe("durable submission attempts", () => {
  it("survives adapter recreation and returns the first exact request to concurrent tabs", () => {
    const f = fixture(); const first = f.attempts.request(scope, { action: "save", idempotencyKey: "first", input: { values: { name: "First", receipt: "file_id" } } }, () => {});
    const recreated = createDatasetAttempts(f.options);
    expect(recreated.request(scope, { action: "get" }, () => {})).toEqual(first);
    expect(recreated.request(scope, { action: "save", idempotencyKey: "second", input: { values: { name: "Second" } } }, () => {})).toEqual(first);
    expect(Number(f.db.prepare("SELECT bytes FROM usage").get()!.bytes)).toBeGreaterThan(0);
  });
  it("isolates app, dataset, principal, and operation scopes", () => {
    const f = fixture(); f.attempts.request(scope, { action: "save", idempotencyKey: "first", input: "private" }, () => {});
    for (const key of ["workspaceId", "datasetId", "appId", "principalKey", "operationId"] as const) expect(f.attempts.request({ ...scope, [key]: "another" }, { action: "get" }, () => {})).toEqual({ attempt: null });
    expect(() => f.attempts.request({ ...scope, revisionSha256: "b".repeat(64) }, { action: "get" }, () => {})).toThrow("earlier Collection");
  });
  it("rechecks authorization in the transaction and rolls back quota and pending payload", () => {
    const f = fixture(); let calls = 0;
    expect(() => f.attempts.request(scope, { action: "save", idempotencyKey: "first", input: {} }, () => { if (++calls === 2) throw Error("revoked"); })).toThrow("revoked");
    expect(f.attempts.request(scope, { action: "get" }, () => {})).toEqual({ attempt: null }); expect(f.db.prepare("SELECT bytes FROM usage").get()!.bytes).toBe(0);
  });
  it("clears only the captured token and does not erase a newer response", () => {
    const f = fixture(), first = f.attempts.request(scope, { action: "save", idempotencyKey: "first", input: {} }, () => {});
    expect(() => f.attempts.request(scope, { action: "clear", token: "a".repeat(43) }, () => {})).toThrow("Another submission");
    f.attempts.request(scope, { action: "clear", token: first.attempt!.token }, () => {});
    expect(f.db.prepare("SELECT bytes FROM usage").get()!.bytes).toBe(0);
    const second = f.attempts.request(scope, { action: "save", idempotencyKey: "second", input: {} }, () => {});
    expect(() => f.attempts.request(scope, { action: "clear", token: first.attempt!.token }, () => {})).toThrow();
    expect(f.attempts.request(scope, { action: "get" }, () => {})).toEqual(second);
  });
  it("refuses oversized values and finite slot exhaustion without expiring unknown outcomes", () => {
    expect(() => parseDatasetAttemptRequest({ action: "save", idempotencyKey: "first", input: "x".repeat(65536) })).toThrow();
    const f = fixture(1); f.attempts.request(scope, { action: "save", idempotencyKey: "first", input: {} }, () => {});
    expect(() => f.attempts.request({ ...scope, principalKey: "other" }, { action: "save", idempotencyKey: "second", input: {} }, () => {})).toThrow("too many");
  });
});
