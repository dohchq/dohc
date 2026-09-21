import { describe, expect, it } from "vitest";
import {
  APP_BACKEND_INPUT_BYTES, APP_BACKEND_JSON_MAX_DEPTH, APP_BACKEND_JSON_MAX_NODES,
  APP_BACKEND_MAX_OPERATIONS, APP_BACKEND_MAX_TABLES, APP_BACKEND_UPLOAD_BYTES,
  canInvokeAppBackendOperation, parseAppBackendCaller, parseAppBackendCapability,
  parseAppBackendFile, parseAppBackendInvokeRequest, parseAppBackendJson, parseAppBackendUploadRequest, parseAppBackendRefusal,
  type AppBackendCaller, type AppBackendCapability,
} from "./appBackend";

it("accepts only bounded safe app refusal fields", () => {
  const refusal = {code:"capacity_full",message:"This session is full."};
  expect(parseAppBackendRefusal(refusal)).toEqual(refusal);
  for (const value of [{...refusal,stack:"private"},{...refusal,code:"full\n"},{...refusal,message:"é".repeat(513)},{code:"",message:""}]) {
    expect(() => parseAppBackendRefusal(value)).toThrow();
  }
  expect(parseAppBackendRefusal({code:"full",message:"é".repeat(512)}).message).toHaveLength(512);
});

function capability(): AppBackendCapability {
  return {
    kind: "app-backend", dataPath: "data/registrations.sqlite", backendPath: "backend.js", schemaPath: "schema.sql",
    backendSha256: "a".repeat(64), schemaSha256: "b".repeat(64), schemaVersion: 1,
    operations: [
      { name: "register", access: "link", readOnly: false },
      { name: "registrations.list", access: "helper", readOnly: true },
      { name: "registrations.update", access: "helper", readOnly: false },
      { name: "organizers.manage", access: "owner", readOnly: false },
    ],
    tables: [{ name: "registrations", primaryKey: "id", readOperation: "registrations.list", writeOperation: "registrations.update" }],
  };
}
const invoke = () => ({ authorityRevision: 1, operation: "register", idempotencyKey: "attempt:1", input: { attendees: ["Alex"], count: 1 } });
const upload = () => ({ authorityRevision: 1, idempotencyKey: "upload:1", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: "JVBERg==" });

describe("app backend capability", () => {
  it("keeps the stable database identity separate from compiled artifacts and returns a detached canonical inventory", () => {
    const input = capability();
    const result = parseAppBackendCapability(input);
    expect(result.dataPath).toBe("data/registrations.sqlite");
    expect(result.operations.map(operation => operation.name)).toEqual(["organizers.manage", "register", "registrations.list", "registrations.update"]);
    input.operations[0]!.access = "owner";
    expect(result.operations.find(operation => operation.name === "register")!.access).toBe("link");
    expect(parseAppBackendCapability({ ...capability(), tables: [] }).tables).toEqual([]);
  });

  it.each(["../private.sqlite", "/data.sqlite", "C:\\data.sqlite", "data\\app.sqlite", "data/./app.sqlite", ".dohc/app.sqlite", ".env", "data/app.env", "data//app.sqlite", "data/app.db", "data/app.sqlite3"])("rejects unsafe or noncanonical database path %s", dataPath => {
    expect(() => parseAppBackendCapability({ ...capability(), dataPath })).toThrow();
  });

  it.each([
    { backendPath: "../backend.js" }, { schemaPath: "source.sql" }, { backendSha256: "A".repeat(64) },
    { schemaSha256: "b".repeat(63) }, { schemaSha256: "b".repeat(64) + "\n" }, { schemaVersion: 0 }, { schemaVersion: 1.1 }, { network: true },
  ])("rejects invalid artifacts, schema revisions, and extra authority: %j", patch => {
    expect(() => parseAppBackendCapability({ ...capability(), ...patch })).toThrow();
  });

  it("rejects duplicate, excessive, and invalid operation or table declarations", () => {
    const input = capability();
    for (const operations of [[], [...input.operations, input.operations[0]], Array(APP_BACKEND_MAX_OPERATIONS + 1).fill(input.operations[0]),
      [{ name: "constructor", access: "link", readOnly: true }], [{ name: "x.__proto__", access: "link", readOnly: true }],
      [{ name: "run", access: "edit", readOnly: false }], [{ name: "run", access: "owner", readOnly: "false" }],
      [{ ...input.operations[0], userId: "owner" }]]) {
      expect(() => parseAppBackendCapability({ ...input, operations })).toThrow();
    }
    for (const tables of [[...input.tables, { ...input.tables[0], name: "REGISTRATIONS" }], Array(APP_BACKEND_MAX_TABLES + 1).fill(input.tables[0]),
      [{ ...input.tables[0], primaryKey: "id); DROP TABLE registrations" }], [{ ...input.tables[0], readOperation: "missing" }],
      [{ ...input.tables[0], readOperation: "register" }], [{ ...input.tables[0], writeOperation: "registrations.list" }]]) {
      expect(() => parseAppBackendCapability({ ...input, tables })).toThrow();
    }
    expect(parseAppBackendCapability({ ...input, tables: [{ ...input.tables[0], writeOperation: null }] }).tables[0]!.writeOperation).toBeNull();
  });
});

describe("verified app backend callers", () => {
  const callers: AppBackendCaller[] = [
    { kind: "link", principalId: "participant", grantId: "grant" },
    { kind: "named", userId: "person", grantId: "grant", access: "view", helper: true },
    { kind: "named", userId: "person", grantId: "grant", access: "comment", helper: true },
    { kind: "named", userId: "person", grantId: "grant", access: "edit", helper: false },
    { kind: "named", userId: "person", grantId: "grant", access: "edit", helper: true },
    { kind: "owner", userId: "owner" },
  ];

  it("requires both an explicit helper assignment and a named Edit grant for helper operations", () => {
    const operations = capability().operations;
    expect(callers.map(caller => parseAppBackendCaller(caller))).toEqual(callers);
    for (const caller of callers) expect(canInvokeAppBackendOperation(caller, operations[0]!)).toBe(true);
    expect(callers.map(caller => canInvokeAppBackendOperation(caller, operations[1]!))).toEqual([false, false, false, false, true, true]);
    expect(callers.map(caller => canInvokeAppBackendOperation(caller, operations[3]!))).toEqual([false, false, false, false, false, true]);
  });

  it.each([
    { kind: "link", principalId: "participant", grantId: "grant", access: "edit", helper: true },
    { kind: "named", userId: "person", grantId: "grant", access: "owner", helper: true },
    { kind: "named", userId: "person", grantId: "grant", access: "edit" },
    { kind: "owner", userId: "owner", grantId: "grant" },
    { kind: "owner", userId: "" },
  ])("rejects widened or incomplete caller records: %j", caller => {
    expect(() => parseAppBackendCaller(caller)).toThrow();
  });
});

describe("bounded app backend JSON and requests", () => {
  it("copies nested JSON and counts its encoded UTF-8 bytes, including escapes", () => {
    const input = { rows: [{ value: "🍎\n" }], empty: null, yes: true };
    const serializedBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    expect(parseAppBackendJson(input, serializedBytes)).toEqual(input);
    expect(() => parseAppBackendJson(input, serializedBytes - 1)).toThrow();
    const request = invoke();
    const result = parseAppBackendInvokeRequest(request);
    expect(result).toEqual(request);
    expect(result.input).not.toBe(request.input);
  });

  it.each([NaN, Infinity, undefined, 1n, new Date(), new Map(), () => null,
    JSON.parse('{"__proto__":{"admin":true}}'), { nested: { constructor: "bad" } }, new Array(2),
    Object.assign([1], { extra: true }), Object.assign({}, { [Symbol("private")]: true })])("rejects non-JSON or prototype-bearing payloads", input => {
    expect(() => parseAppBackendJson(input)).toThrow();
  });

  it("rejects accessors without invoking them", () => {
    let called = false;
    const payload = Object.defineProperty({}, "input", { enumerable: true, get() { called = true; return 1; } });
    expect(() => parseAppBackendJson(payload)).toThrow();
    const array = Object.defineProperty([0], "0", { enumerable: true, get() { called = true; return 1; } });
    expect(() => parseAppBackendJson(array)).toThrow();
    expect(called).toBe(false);
  });

  it("bounds depth, node count, encoded payload size, and cyclic values", () => {
    let nested: unknown = null;
    for (let index = 0; index <= APP_BACKEND_JSON_MAX_DEPTH; index++) nested = [nested];
    expect(() => parseAppBackendJson(nested)).toThrow();
    expect(() => parseAppBackendJson(Array(APP_BACKEND_JSON_MAX_NODES).fill(0))).toThrow();
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(() => parseAppBackendJson(cyclic)).toThrow();
    expect(() => parseAppBackendInvokeRequest({ ...invoke(), input: "x".repeat(APP_BACKEND_INPUT_BYTES) })).toThrow();
  });

  it.each([0, -1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"])("rejects authority revision %s", authorityRevision => {
    expect(() => parseAppBackendInvokeRequest({ ...invoke(), authorityRevision })).toThrow();
    expect(() => parseAppBackendUploadRequest({ ...upload(), authorityRevision })).toThrow();
  });

  it.each([{ caller: { kind: "owner", userId: "owner" } }, { dataPath: "private.sqlite" }, { readOnly: false },
    { operation: "__proto__" }, { idempotencyKey: "" }, { idempotencyKey: "x".repeat(129) }])("rejects malformed requests and client-supplied authority: %j", patch => {
    expect(() => parseAppBackendInvokeRequest({ ...invoke(), ...patch })).toThrow();
  });
});

describe("staged file wire contract", () => {
  it("accepts a nominal MIME type and bounded bytes without claiming to detect content", () => {
    expect(parseAppBackendUploadRequest(upload())).toEqual(upload());
    const bytesBase64 = Buffer.alloc(APP_BACKEND_UPLOAD_BYTES).toString("base64");
    expect(parseAppBackendUploadRequest({ ...upload(), bytesBase64 }).bytesBase64).toBe(bytesBase64);
    const file = { fileId: "file_0123456789abcdef", name: "receipt.pdf", contentType: "application/pdf", byteLength: 4, sha256: "a".repeat(64) };
    expect(parseAppBackendFile(file)).toEqual(file);
    expect(() => parseAppBackendFile({ ...file, path: "private/receipt.pdf" })).toThrow();
    expect(() => parseAppBackendFile({ ...file, fileId: "../receipt" })).toThrow();
  });

  it.each(["", "a", "a===", "====", "AA==\n", "AAA\n", "-_==", "AB==", "AAB=", "AA=A"])("rejects invalid or noncanonical base64 %s", bytesBase64 => {
    expect(() => parseAppBackendUploadRequest({ ...upload(), bytesBase64 })).toThrow();
  });

  it("rejects oversized bytes before decoding them", () => {
    const bytesBase64 = Buffer.alloc(APP_BACKEND_UPLOAD_BYTES + 1).toString("base64");
    expect(() => parseAppBackendUploadRequest({ ...upload(), bytesBase64 })).toThrow();
  });

  it.each([{ name: "../receipt.pdf" }, { name: "folder\\receipt.pdf" }, { contentType: "image/png\r\nX-Header: true" },
    { contentType: "text/html; charset=utf-8" }, { path: "receipts/private" }, { fileId: "caller-chosen-file" }])("rejects file paths and extra upload authority: %j", patch => {
    expect(() => parseAppBackendUploadRequest({ ...upload(), ...patch })).toThrow();
  });
});
