import { describe, expect, it } from "vitest";
import {
  collectionRecordRefKey, collectionRefKey, parseCollectionDataAction, parseCollectionDataEditInput,
  parseCollectionDataQuery, parseCollectionRecordRef, parseCollectionRef,
  type CollectionRef, type CollectionRecordRef,
} from "./collectionData";

const datasetId = "00000000-0000-4000-8000-000000000001";
const tableId = "00000000-0000-4000-8000-000000000002";
const fieldId = "00000000-0000-4000-8000-000000000003";
const operationId = "00000000-0000-4000-8000-000000000004";
const document: CollectionRef = { kind: "document", path: "tasks" };
const transactional: CollectionRef = { kind: "transactional", datasetId, tableId };
const documentRecord: CollectionRecordRef = { collection: document, recordId: `rec_${"a".repeat(26)}` };
const action = () => ({ kind: "transactional", action: "operation", collection: transactional, operationId,
  input: { id: 1, expectedVersion: 2, values: { [fieldId]: "Alice" } }, revision: 1, revisionSha256: "a".repeat(64), idempotencyKey: "edit:1" });

describe("Collection references", () => {
  it("keeps document and transactional identities separate without inventing paths", () => {
    expect(parseCollectionRef(document)).toEqual(document);
    expect(parseCollectionRef(transactional)).toEqual(transactional);
    expect(parseCollectionRef(transactional)).not.toHaveProperty("path");
    expect(parseCollectionRecordRef(documentRecord)).toEqual(documentRecord);
    expect(parseCollectionRecordRef({ collection: transactional, recordId: "order/2026 A" }).recordId).toBe("order/2026 A");
    expect(collectionRefKey({ tableId, datasetId, kind: "transactional" })).toBe(collectionRefKey(transactional));
    expect(collectionRecordRefKey({ collection: transactional, recordId: 1 })).not.toBe(collectionRecordRefKey({ collection: transactional, recordId: "1" }));
  });

  it("rejects mixed identities and unsafe record values", () => {
    for (const input of [{ ...transactional, path: "fake.md" }, { ...document, datasetId }, { kind: "transactional", datasetId: "data/file.sqlite", tableId },
      { ...transactional, tableId: `${tableId}\n` }, { ...document, path: "../private" }, { ...document, path: "C:/secret" },
      { ...document, path: "a//b" }, { ...document, path: ".dohc/data" }, { ...document, path: "a/%2e%2e" }]) {
      expect(() => parseCollectionRef(input)).toThrow();
    }
    for (const input of [{ collection: document, recordId: 1 }, { collection: document, recordId: "fake.md" },
      { collection: transactional, recordId: Number.MAX_SAFE_INTEGER + 1 }, { collection: transactional, recordId: Infinity },
      { collection: transactional, recordId: 1.5 }, { collection: transactional, recordId: "" }]) {
      expect(() => parseCollectionRecordRef(input)).toThrow();
    }
  });
});

describe("Collection data requests", () => {
  it("matches bounded table query inputs and preserves document field names", () => {
    const query = { collection: transactional, limit: 50, after: { id: 3, value: "Alice" }, sort: { fieldId, direction: "asc" }, search: "", filters: [{ fieldId, value: "Alice" }] };
    expect(parseCollectionDataQuery(query)).toEqual(query);
    expect(parseCollectionDataQuery({ collection: transactional, after: { id: 3, value: null } }).after).toEqual({ id: 3, value: null });
    expect(parseCollectionDataQuery({ collection: document, sort: { fieldId: "Due date", direction: "desc" }, filters: [{ fieldId: "Amount", value: 3n }] }).filters![0]!.value).toBe(3n);
    for (const patch of [{ limit: 0 }, { limit: 1001 }, { after: { id: 1, value: undefined } }, { after: { id: 1 } }, { after: { id: 1.2, value: null } }, { sort: { fieldId: "Name", direction: "asc" } },
      { sort: { fieldId, direction: "up" } }, { filters: [{ fieldId, value: 1 }, { fieldId, value: 2 }] }, { filters: [{ fieldId, value: 1n }] }, { sql: "SELECT * FROM people" }]) {
      expect(() => parseCollectionDataQuery({ ...query, ...patch })).toThrow();
    }
  });

  it("requires exact operation revision and keeps edits inside approved operations", () => {
    expect(parseCollectionDataAction(action())).toEqual(action());
    expect(parseCollectionDataEditInput(action().input)).toEqual(action().input);
    for (const patch of [{ kind: "document" }, { collection: document }, { operationId: "owner.edit" }, { revision: 0 },
      { revisionSha256: "a".repeat(64) + "\n" }, { idempotencyKey: "retry\n" }, { caller: { kind: "owner" } }, { input: { [fieldId]: 1n } }]) {
      expect(() => parseCollectionDataAction({ ...action(), ...patch })).toThrow();
    }
    expect(() => parseCollectionDataAction({ ...action(), action: "edit" })).toThrow();
    expect(() => parseCollectionDataEditInput({ id: 1, expectedVersion: 0, values: {} })).toThrow();
    expect(() => parseCollectionDataEditInput({ id: 1, expectedVersion: 1, values: { name: "Alice" } })).toThrow();
  });

  it("routes document actions by record identity without changing the existing document contract", () => {
    const create = { kind: "document", action: "create", collection: document, name: "New task", fields: { "Due date": "2026-09-22" } };
    const edit = { kind: "document", action: "setFields", record: documentRecord, fields: { Amount: 20n } };
    expect(parseCollectionDataAction(create)).toEqual(create);
    expect(parseCollectionDataAction(edit)).toEqual(edit);
    expect(() => parseCollectionDataAction({ ...create, collection: transactional })).toThrow();
    expect(() => parseCollectionDataAction({ ...create, name: "../escape" })).toThrow();
    expect(() => parseCollectionDataAction({ ...create, operationId })).toThrow();
    expect(() => parseCollectionDataAction({ ...edit, record: { collection: transactional, recordId: 1 } })).toThrow();
  });

  it("copies bounded plain values without invoking accessors or accepting hidden authority", () => {
    let calls = 0;
    const getter = Object.defineProperty({}, "collection", { enumerable: true, get() { calls++; return transactional; } });
    const hidden = Object.defineProperty({ collection: transactional }, "caller", { value: "owner", enumerable: false });
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const sparse = new Array(2);
    const symbol = { collection: transactional, [Symbol("authority")]: "owner" };
    for (const value of [getter, hidden, { collection: transactional, filters: sparse }, symbol, Object.create({ collection: transactional }),
      { ...action(), input: circular }, { ...action(), input: JSON.parse('{"__proto__":{"owner":true}}') },
      { ...action(), input: "é".repeat(33_000) }, { ...action(), input: Array(4097).fill(1) }]) {
      expect(() => value === getter || value === hidden || value === symbol ? parseCollectionDataQuery(value) : parseCollectionDataAction(value)).toThrow();
    }
    expect(calls).toBe(0);
    const input = action(); const parsed = parseCollectionDataAction(input); input.input.values[fieldId] = "Changed";
    expect(parsed).toEqual(action());
  });
});
