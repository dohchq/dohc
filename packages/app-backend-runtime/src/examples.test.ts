import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateAppOperation, initializeAppDatabase } from "./index.ts";
import type { EvaluateAppOperationInput, JsonValue } from "./index.ts";

const participant = {kind: "link", principalId: "participant", grantId: "public"};
const helper = {kind: "named", userId: "organizer", grantId: "private", access: "edit", helper: true};
const owner = {kind: "owner", userId: "owner"};
const file = {fileId: "receipt", name: "receipt.png", contentType: "image/png", byteLength: 128, sha256: "a".repeat(64)};
const read = (app: string, name: string) => readFileSync(new URL(`../../../examples/${app}/${name}`, import.meta.url), "utf8");
async function fixture(app = "fundraiser") {
  const tables = app === "fundraiser" ? ["sessions", "registrations", "registration_sessions", "attendees"] : ["items", "orders", "order_items"];
  const source = read(app, "backend.ts");
  let database = await initializeAppDatabase({schemaSql: read(app, "schema.sql"), tables});
  let sequence = 0;
  async function call(operation: string, input: JsonValue = {}, options: Partial<EvaluateAppOperationInput> = {}) {
    const requestId = `request-${++sequence}`;
    const result = await evaluateAppOperation({source, tables, database, operation, input, caller: participant, requestId,
      nowMs: sequence * 1000, secret: randomBytes(32).toString("base64url"), files: [file], ...options});
    database = result.database;
    return result;
  }
  return {call, get database() { return database; }};
}
function registration(sessions: JsonValue[] = [{sessionId: "s1", players: ["First Player"], spectators: []}]) {
  return {fullName: "Synthetic Contact", mobile: "0917 123 4567", sessions, paymentMethod: "gcash", receiptFileId: file.fileId,
    submissionId: randomUUID(), retrySecret: randomBytes(32).toString("base64url"), receiptSha256: file.sha256};
}
const group = (sessionId: string, count: number) => ({sessionId, players: Array.from({length: count}, (_, i) => `Player Person${i}`), spectators: []});
const rows = (value: JsonValue) => value as Array<Record<string, unknown>>;
const row = (value: JsonValue) => value as Record<string, any>;

// These tests run the app source in the real isolated runtime and use real SQLite transactions.
// The host suite separately proves commit ordering and durable request replay.
describe("fundraiser app operations", () => {
  it("accepts private receipts and returns a secret status link with server-calculated totals", async () => {
    const f = await fixture();
    const accepted = await f.call("register", {...registration([
      {sessionId: "s1", players: ["First Player", "Second Player"], spectators: ["Watching Friend"]},
      {sessionId: "s2", players: ["First Player", "Second Player"], spectators: ["Watching Friend"]},
    ]), total: 1});
    expect(accepted.attachedFileIds).toEqual([file.fileId]);
    const result = row(accepted.result);
    expect(result).toMatchObject({status: "pending_verification", total: 4300, version: 1});
    expect(result.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.statusToken).not.toBe(result.id);
    const status = row((await f.call("lookupStatus", {token: result.statusToken}, {readOnly: true})).result);
    expect(status.attendees).toHaveLength(6);
    expect(status).not.toHaveProperty("mobile");
    expect(status).not.toHaveProperty("receiptFileId");
    expect(status).not.toHaveProperty("statusToken");
    await expect(f.call("lookupStatus", {token: result.id}, {readOnly: true})).rejects.toMatchObject({refusal: {code: "not_found"}});
    await expect(f.call("lookupStatus", {token: "Z".repeat(43)}, {readOnly: true})).rejects.toMatchObject({refusal: {code: "not_found"}});
    const listing = row((await f.call("listRegistrations", {}, {caller: helper, readOnly: true})).result);
    expect(listing.records[0]).toMatchObject({fullName: "Synthetic Contact", mobile: "+639171234567", hasReceipt: true});
    expect(listing.records[0]).not.toHaveProperty("statusToken");
    expect((await f.call("receiptAccess", {id: result.id}, {caller: helper, readOnly: true})).result).toEqual({fileId: file.fileId});
    expect((await f.call("totals", {}, {caller: helper, readOnly: true})).result).toEqual([
      {paymentMethod: "gcash", verified: 0, pending: 4300, rejected: 0, dueAtVenue: 0, total: 4300},
    ]);
    expect(rows((await f.call("listPublicSessions", {}, {readOnly: true})).result).map(value => value.available)).toEqual([34, 34]);
  }, 30000);

  it("rolls back both-session reservations when the second session is full", async () => {
    const f = await fixture();
    await f.call("register", registration([group("s2", 36)]));
    const before = Buffer.from(f.database);
    await expect(f.call("register", registration([group("s1", 1), group("s2", 1)]))).rejects.toMatchObject({refusal: {code: "capacity_unavailable"}});
    expect(Buffer.from(f.database)).toEqual(before);
    expect(rows((await f.call("listPublicSessions", {}, {readOnly: true})).result).map(value => value.available)).toEqual([36, 0]);
    expect(row((await f.call("listRegistrations", {}, {caller: helper, readOnly: true})).result).records).toHaveLength(1);
  }, 30000);

  it("enforces capacity on restoration and rejects stale table updates", async () => {
    const f = await fixture();
    const first = row((await f.call("register", registration([group("s1", 36)]))).result);
    await f.call("updateRegistration", {rowId: first.id, field: "status", value: "rejected", expectedVersion: 1}, {caller: owner});
    await expect(f.call("setStatus", {id: first.id, status: "verified", expectedVersion: 1}, {caller: helper})).rejects.toMatchObject({refusal: {code: "conflict"}});
    const second = row((await f.call("register", registration([group("s1", 36)]))).result);
    await expect(f.call("updateRegistration", {rowId: first.id, field: "status", value: "pending_verification", expectedVersion: 2}, {caller: owner})).rejects.toMatchObject({refusal: {code: "capacity_unavailable"}});
    await f.call("setStatus", {id: second.id, status: "rejected", expectedVersion: 1}, {caller: helper});
    const restored = await f.call("setStatus", {id: first.id, status: "verified", expectedVersion: 2}, {caller: helper});
    expect(restored.result).toMatchObject({status: "verified", version: 3});
    expect(rows((await f.call("listPublicSessions", {}, {readOnly: true})).result)[0].available).toBe(0);
    const attendees = row((await f.call("attendees", {}, {caller: helper, readOnly: true})).result).records;
    expect(attendees).toHaveLength(36);
    expect(attendees.every((person: {registrationId: string}) => person.registrationId === first.id)).toBe(true);
  }, 30000);

  it("supports manual spectators and pay-at-venue without an uploaded receipt", async () => {
    const f = await fixture();
    const entry = row((await f.call("manualEntry", {fullName: "Venue Friend", session: "both", role: "spectator", source: "reclub", status: "pay_at_venue", paymentMethod: "cash"}, {caller: helper})).result);
    expect(entry).toMatchObject({total: 300, status: "pay_at_venue"});
    expect(rows((await f.call("listPublicSessions", {}, {readOnly: true})).result).map(value => value.available)).toEqual([36, 36]);
    await expect(f.call("setStatus", {id: entry.id, status: "verified", expectedVersion: 1}, {caller: helper})).rejects.toMatchObject({refusal: {code: "invalid_input"}});
    await f.call("setStatus", {id: entry.id, status: "verified", expectedVersion: 1, paymentMethod: "gcash"}, {caller: helper});
    expect((await f.call("totals", {}, {caller: helper, readOnly: true})).result).toMatchObject([{paymentMethod: "gcash", verified: 300, dueAtVenue: 0}]);
    await expect(f.call("receiptAccess", {id: entry.id}, {caller: helper, readOnly: true})).rejects.toMatchObject({refusal: {code: "not_found"}});
  }, 30000);

  it("refuses hidden organizer operations for public callers and named nonhelpers", async () => {
    const f = await fixture();
    for (const caller of [participant, {...helper, helper: false}, {...helper, access: "view"}]) {
      for (const operation of ["listRegistrations", "setStatus", "updateRegistration", "manualEntry", "attendees", "totals", "receiptAccess", "listRegistrationSessions"]) {
        await expect(f.call(operation, {}, {caller})).rejects.toMatchObject({refusal: {code: "forbidden"}});
      }
    }
  }, 30000);

  it("validates duplicate names, mobile formats and receipt metadata before accepting", async () => {
    const f = await fixture();
    const before = Buffer.from(f.database);
    await expect(f.call("register", registration([{sessionId: "s1", players: ["Name Person"], spectators: ["Ｎａｍｅ Person"]}]))).rejects.toMatchObject({refusal: {code: "duplicate_attendee"}});
    await expect(f.call("register", {...registration(), mobile: "+1 202 555 0100"})).rejects.toMatchObject({refusal: {code: "invalid_input"}});
    await expect(f.call("register", registration(), {files: []})).rejects.toThrow();
    await expect(f.call("register", registration(), {files: [{...file, contentType: "text/html"}]})).rejects.toMatchObject({refusal: {code: "invalid_receipt"}});
    expect(Buffer.from(f.database)).toEqual(before);
  }, 30000);

  it("accepts the maximum original roster within operation and SQL limits", async () => {
    const f = await fixture();
    const sessions = ["s1", "s2"].map(sessionId => ({...group(sessionId, 36), spectators: Array.from({length: 100}, (_, i) => `Spectator Person${i}`)}));
    const result = row((await f.call("register", registration(sessions))).result);
    expect(result.total).toBe(102000);
    expect(row((await f.call("lookupStatus", {token: result.statusToken}, {readOnly: true})).result).attendees).toHaveLength(272);
    const first = row((await f.call("attendees", {limit: 200}, {caller: helper, readOnly: true})).result);
    expect(first.records).toHaveLength(200);
    expect(first.nextOffset).toBe(200);
    const second = row((await f.call("attendees", {limit: 200, offset: 200}, {caller: helper, readOnly: true})).result);
    expect(second.records).toHaveLength(72);
    expect(second.nextOffset).toBeNull();
  }, 30000);

  it("accepts the original form's local and international mobile formats", async () => {
    const f = await fixture();
    for (const mobile of ["09171234567", "09991234567", "08171234567", "+639171234567", "639171234567", "9171234567", "0917 123 4567", "+63 (917) 123-4567", "00639171234567"]) {
      expect((await f.call("register", {...registration(), mobile})).result).toMatchObject({status: "pending_verification"});
    }
    for (const mobile of ["", "0917123456", "091712345678", "+63281234567", "09001234567", "+12025550123", "08001234567", "0917abc4567", "call 09171234567", "09171234567 ext 2"]) {
      await expect(f.call("register", {...registration(), mobile})).rejects.toMatchObject({refusal: {code: "invalid_input"}});
    }
  }, 30000);
});

describe("stock order app operations", () => {
  it("uses the same runtime for all-or-nothing orders, cancellation and restoration", async () => {
    const f = await fixture("stock-orders");
    const first = row((await f.call("placeOrder", {customerName: "Synthetic Customer", items: [{itemId: "shirt-s", quantity: 20}], totalCents: 1})).result);
    expect(first.totalCents).toBe(30000);
    const before = Buffer.from(f.database);
    await expect(f.call("placeOrder", {customerName: "Other Customer", items: [{itemId: "shirt-m", quantity: 1}, {itemId: "shirt-s", quantity: 1}]})).rejects.toMatchObject({refusal: {code: "stock_unavailable"}});
    expect(Buffer.from(f.database)).toEqual(before);
    await f.call("updateOrder", {rowId: first.id, field: "status", value: "cancelled", expectedVersion: 1}, {caller: owner});
    const second = row((await f.call("placeOrder", {customerName: "Other Customer", items: [{itemId: "shirt-s", quantity: 20}]})).result);
    await expect(f.call("setStatus", {id: first.id, status: "confirmed", expectedVersion: 2}, {caller: helper})).rejects.toMatchObject({refusal: {code: "stock_unavailable"}});
    await f.call("setStatus", {id: second.id, status: "cancelled", expectedVersion: 1}, {caller: helper});
    expect((await f.call("setStatus", {id: first.id, status: "confirmed", expectedVersion: 2}, {caller: helper})).result).toMatchObject({version: 3, status: "confirmed"});
    await expect(f.call("setStatus", {id: first.id, status: "cancelled", expectedVersion: 2}, {caller: helper})).rejects.toMatchObject({refusal: {code: "conflict"}});
    await expect(f.call("listOrders", {}, {readOnly: true})).rejects.toMatchObject({refusal: {code: "forbidden"}});
    expect(rows((await f.call("listItems", {}, {readOnly: true})).result).find(item => item.id === "shirt-s")?.remaining).toBe(0);
  }, 30000);

  it("serves every declared stock table through the owner table shape", async () => {
    const f = await fixture("stock-orders");
    const order = row((await f.call("placeOrder", {customerName: "Searchable Customer", items: [{itemId: "shirt-s", quantity: 1}]})).result);
    const declaration = JSON.parse(read("stock-orders", "backend.publish.json"));
    for (const table of declaration.tables) {
      expect(declaration.operations).toContainEqual({name: table.readOperation, access: "owner", readOnly: true});
      const result = row((await f.call(table.readOperation, {offset: 0, limit: 1, search: ""}, {caller: owner, readOnly: true})).result);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty(table.primaryKey);
      expect(result.total).toBe(table.name === "items" ? 3 : 1);
      expect((await f.call(table.readOperation, {offset: result.total, limit: 1}, {caller: owner, readOnly: true})).result).toEqual({rows: [], total: result.total});
      expect((await f.call(table.readOperation, {search: "%"}, {caller: owner, readOnly: true})).result).toEqual({rows: [], total: 0});
      await expect(f.call(table.readOperation, {}, {readOnly: true})).rejects.toMatchObject({refusal: {code: "forbidden"}});
    }
    const firstPage = row((await f.call("tableItems", {offset: 0, limit: 1}, {caller: owner, readOnly: true})).result);
    const nextPage = row((await f.call("tableItems", {offset: 1, limit: 1}, {caller: owner, readOnly: true})).result);
    expect(firstPage.rows[0].id).not.toBe(nextPage.rows[0].id);
    expect(nextPage.total).toBe(3);
    const items = row((await f.call("tableItems", {offset: 0, limit: 2, search: "MEDIUM"}, {caller: owner, readOnly: true})).result);
    expect(items).toEqual({rows: [{id: "shirt-m", name: "Fundraiser shirt, medium", priceCents: 1500, remaining: 20}], total: 1});
    const orders = row((await f.call("tableOrders", {offset: 0, limit: 50, search: "searchable"}, {caller: owner, readOnly: true})).result);
    expect(orders.rows).toHaveLength(1);
    expect(orders.rows[0]).toMatchObject({id: order.id, customerName: "Searchable Customer", status: "pending"});
    expect(orders.total).toBe(1);
    const orderItems = row((await f.call("tableOrderItems", {offset: 0, limit: 50, search: order.id}, {caller: owner, readOnly: true})).result);
    expect(orderItems.rows).toEqual([{id: `${order.id}_shirt-s`, orderId: order.id, itemId: "shirt-s", quantity: 1, unitPriceCents: 1500}]);
    expect(orderItems.total).toBe(1);
    await expect(f.call("tableItems", {limit: 101}, {caller: owner, readOnly: true})).rejects.toMatchObject({refusal: {code: "invalid_input"}});
    await expect(f.call("tableOrders", {search: 1}, {caller: owner, readOnly: true})).rejects.toMatchObject({refusal: {code: "invalid_input"}});
    expect(Array.isArray((await f.call("listItems", {}, {readOnly: true})).result)).toBe(true);
    for (const operation of ["listOrders", "listOrderItems"]) {
      expect((await f.call(operation, {}, {caller: helper, readOnly: true})).result).toMatchObject({records: [expect.any(Object)], nextOffset: null});
    }
  }, 30000);
});
