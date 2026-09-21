import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { CollectionSchema } from "@dohc/workspace-contracts/collection";
import * as runtime from "@dohc/app-backend-runtime";
import type { JsonValue } from "@dohc/app-backend-runtime";
import { generateAppForm } from "./appFormGenerator";
import { compileClosedApp } from "./closedAppCompiler";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { createLocalAppBackendHost, type LocalAppBackendHost } from "./localAppBackend";

const maliciousLabel = "Name </script><script>alert('label')</script>";
const privateField = "Organizer private review";
const privateOption = "INTERNAL_REVIEW_REQUIRED";
const schema: CollectionSchema = {
  name: "Registrations </script><script>alert('title')</script>", description: null, views: [],
  fields: [
    { name: maliciousLabel, type: "text" }, { name: "Guests", type: "number" },
    { name: "Consent", type: "checkbox" }, { name: "Session", type: "select", options: ["Morning", "Evening"] },
    { name: "Date", type: "date" }, { name: "Website", type: "url" },
    { name: privateField, type: "select", options: [privateOption, "Approved"] },
  ],
};
const submission = {
  [maliciousLabel]: "Alice", Guests: 2, Consent: true, Session: "Morning", Date: "2026-09-22", Website: "https://example.com/",
};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function prepare(fieldsSchema = schema, publicFields = fieldsSchema.fields.filter(field => field.name !== privateField).map(field => field.name)) {
  const generated = generateAppForm({ schema: fieldsSchema, schemaSource: "Participants/collection.yaml", appRoot: "app", publicFields });
  const sources = new Map(Object.entries(generated.files).map(([path, text]) => [`app/${path}`, Buffer.from(text)]));
  const blobs = new Map<string, Uint8Array>();
  const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
    const params = request.params as Record<string, unknown>;
    if (request.method === "versionedText.captureSources") {
      const files = [...(params.paths as string[])].sort().map(path => {
        const bytes = sources.get(path);
        if (!bytes) throw new Error(`Missing generated source: ${path}`);
        const sha256 = hash(bytes); blobs.set(sha256, bytes);
        return { path, objectId: path, contentKind: "text", sha256, byteLength: bytes.byteLength, latestMomentId: "m" };
      });
      return { id: request.id, result: { workspaceId: "w", versionId: "main", files,
        totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
        sourceDigest: hash(JSON.stringify(["dohc-source-capture-v1", "w", "main", files])) } };
    }
    const bytes = blobs.get(String(params.sha256));
    if (!bytes) throw new Error("Missing captured blob.");
    return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
  } }, "owner", { workspaceId: "w" });
  return prepareLocalAppPublication({ workspaceId: "w", appRoot: "app" }, {
    adapter, compile: compileClosedApp, signal: new AbortController().signal, assertCurrent() {},
  });
}

const roots: string[] = [];
const hosts = new Set<LocalAppBackendHost>();
async function open(root?: string) {
  const workspaceRoot = root ?? await mkdtemp(join(tmpdir(), "dohc-generated-form-test-"));
  if (!root) roots.push(workspaceRoot);
  const host = await createLocalAppBackendHost({ workspaceId: "w", workspaceRoot, runtime });
  hosts.add(host);
  return { host, workspaceRoot };
}
function close(host: LocalAppBackendHost) { host.close(); hosts.delete(host); }
afterEach(async () => {
  for (const host of hosts) host.close();
  hosts.clear();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}dohc-generated-form-test-`)) throw new Error("Unexpected test directory.");
    await rm(root, { recursive: true, force: true });
  }
});
type Reply = { result: Record<string, unknown>; revision: number; replayed: boolean };
const invoke = (host: LocalAppBackendHost, publication: { publicationId: string; authorityRevision: number },
  operation: string, idempotencyKey: string, input: unknown = {}) => host.request(publication.publicationId, "invoke", {
  authorityRevision: publication.authorityRevision, operation, idempotencyKey, input,
}) as Promise<Reply>;

describe("generated form integration", () => {
  it("treats omitted prototype-named fields as null and preserves explicit values", async () => {
    const names = ["toString", "valueOf", "hasOwnProperty"];
    const prototypeSchema: CollectionSchema = { name: "Prototype names", description: null, views: [],
      fields: names.map(name => ({ name, type: "text" })),
    };
    const { host } = await open();
    const publication = await host.activate(await prepare(prototypeSchema, names));
    const omitted = await invoke(host, publication, "submit", "omitted", {});
    const values = { toString: "Alice", valueOf: "Morning", hasOwnProperty: "Confirmed" };
    const explicit = await invoke(host, publication, "submit", "explicit", values);
    const listed = await invoke(host, publication, "listResponses", "read");
    expect(listed.result.total).toBe(2);
    expect(listed.result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: omitted.result.id, toString: null, valueOf: null, hasOwnProperty: null }),
      expect.objectContaining({ id: explicit.result.id, ...values }),
    ]));
  }, 30_000);

  it("compiles hostile labels while keeping organizer fields and SQL outside the frontend bundle", async () => {
    const prepared = await prepare();
    const capability = prepared.candidate.capabilities.find(item => item.kind === "app-backend");
    expect(capability).toBeDefined();
    if (!capability || capability.kind !== "app-backend") throw new Error("Missing backend.");
    const frontend = prepared.files.filter(file => ![capability.backendPath, capability.schemaPath].includes(file.path))
      .map(file => Buffer.from(file.bytes).toString()).join("\n");
    expect(frontend).not.toContain(privateField);
    expect(frontend).not.toContain(privateOption);
    expect(frontend).not.toContain("CREATE TABLE responses");
    expect(frontend).not.toContain("INSERT INTO responses");
    expect([...capability.operations].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "editResponse", access: "helper", readOnly: false },
      { name: "listResponses", access: "helper", readOnly: true },
      { name: "submit", access: "link", readOnly: false },
    ]);
  });

  it("persists generated responses, replays a lost reply after restart, and rejects stale edits", async () => {
    const prepared = await prepare();
    const { host, workspaceRoot } = await open();
    const publication = await host.activate(prepared);
    const first = await invoke(host, publication, "submit", "submission-1", submission);
    close(host);
    const restarted = (await open(workspaceRoot)).host;
    expect(await invoke(restarted, publication, "submit", "submission-1", submission)).toEqual({ ...first, replayed: true });
    const listed = await invoke(restarted, publication, "listResponses", "read-1");
    expect(listed.result.total).toBe(1);
    expect(listed.result.rows).toEqual([expect.objectContaining({ ...submission, id: first.result.id, version: 1, [privateField]: null })]);
    const edit = { rowId: first.result.id, field: privateField, value: "Approved", expectedVersion: 1 };
    const edited = await invoke(restarted, publication, "editResponse", "edit-1", edit);
    expect(edited.result).toMatchObject({ ...submission, [privateField]: "Approved", version: 2 });
    await expect(invoke(restarted, publication, "editResponse", "stale-edit", { ...edit, value: privateOption }))
      .rejects.toThrow("This response changed");
    await expect(invoke(restarted, publication, "submit", "forged-private", { ...submission, [privateField]: "Approved" }))
      .rejects.toThrow("Check the field values");
    expect((await invoke(restarted, publication, "listResponses", "read-2")).result.rows)
      .toEqual([expect.objectContaining({ id: first.result.id, [privateField]: "Approved", version: 2 })]);
  }, 30_000);

  it("lets a public caller submit while only organizers can read and edit the same snapshot", async () => {
    const prepared = await prepare();
    const capability = prepared.candidate.capabilities.find(item => item.kind === "app-backend");
    if (!capability || capability.kind !== "app-backend") throw new Error("Missing backend.");
    const source = Buffer.from(prepared.files.find(file => file.path === capability.backendPath)!.bytes).toString();
    const schemaSql = Buffer.from(prepared.files.find(file => file.path === capability.schemaPath)!.bytes).toString();
    const tables = capability.tables.map(table => table.name);
    const database = await runtime.initializeAppDatabase({ tables, schemaSql });
    const base = { source, tables, database, nowMs: 1, requestId: "public-1", caller: { kind: "public", id: "verified-link" } };
    const submitted = await runtime.evaluateAppOperation({ ...base, operation: "submit", input: submission });
    expect(submitted.result).toEqual({ id: "public-1" });
    const saved = { ...base, database: submitted.database };
    const refusedCallers: JsonValue[] = [{ kind: "public", id: "verified-link" }, { kind: "named", access: "edit", helper: false },
      { kind: "named", access: "read", helper: true }];
    for (const caller of refusedCallers) {
      await expect(runtime.evaluateAppOperation({ ...saved, caller, operation: "listResponses", input: {}, readOnly: true }))
        .rejects.toThrow("Organizer access is required");
      await expect(runtime.evaluateAppOperation({ ...saved, caller, operation: "editResponse",
        input: { rowId: "public-1", field: privateField, value: "Approved", expectedVersion: 1 } }))
        .rejects.toThrow("Organizer access is required");
    }
    const helper = { kind: "named", access: "edit", helper: true };
    const edited = await runtime.evaluateAppOperation({ ...saved, caller: helper, operation: "editResponse", requestId: "helper-edit",
      input: { rowId: "public-1", field: privateField, value: "Approved", expectedVersion: 1 } });
    const ownerRead = await runtime.evaluateAppOperation({ ...saved, database: edited.database, caller: { kind: "owner" },
      operation: "listResponses", input: {}, readOnly: true });
    expect(ownerRead.result).toEqual({ total: 1, rows: [{ ...submission, id: "public-1", version: 2, createdAt: 1, [privateField]: "Approved" }] });
    await expect(runtime.evaluateAppOperation({ ...base, requestId: "forged", operation: "submit",
      input: { ...submission, [privateField]: "Approved" } })).rejects.toThrow("Check the field values");
  }, 30_000);

  it("accepts table-editor strings for nullable organizer values without interpreting SQL field names", async () => {
    const sqlField = "review\"; DROP TABLE responses; --";
    const extraSchema: CollectionSchema = { ...schema, fields: [...schema.fields,
      { name: "Organizer amount", type: "number" }, { name: "Organizer checked", type: "checkbox" },
      { name: sqlField, type: "text" },
    ] };
    const prepared = await prepare(extraSchema, Object.keys(submission));
    const { host } = await open();
    const publication = await host.activate(prepared);
    const submitted = await invoke(host, publication, "submit", "row-1", submission);
    expect((await invoke(host, publication, "listResponses", "initial")).result.rows).toEqual([
      expect.objectContaining({ "Organizer amount": null, "Organizer checked": null, [sqlField]: null }),
    ]);
    let expectedVersion = 1;
    for (const [field, value, expected] of [
      ["Organizer amount", "12.5", 12.5], ["Organizer checked", "true", true],
      ["Organizer checked", "false", false], ["Organizer amount", "", null],
      ["Organizer checked", "", null], [sqlField, "'); DROP TABLE responses; --", "'); DROP TABLE responses; --"],
      ["Session", "", null], ["Session", "Evening", "Evening"],
      [sqlField, "", null],
    ] as const) {
      const reply = await invoke(host, publication, "editResponse", `edit-${expectedVersion}`, {
        rowId: submitted.result.id, field, value, expectedVersion,
      });
      expectedVersion++;
      expect(reply.result).toMatchObject({ [field]: expected, version: expectedVersion });
    }
    for (const [index, [field, value]] of [["Organizer amount", "1x"], ["Organizer checked", "yes"], ["Date", "2026-02-30"],
      ["Website", "javascript:alert(1)"], ["Session", "Unlisted"]].entries()) {
      await expect(invoke(host, publication, "editResponse", `invalid-edit-${index}`, {
        rowId: submitted.result.id, field, value, expectedVersion,
      })).rejects.toThrow("Check the field values");
    }
    expect((await invoke(host, publication, "listResponses", "final")).result).toMatchObject({ total: 1, rows: [
      { ...submission, Session: "Evening", "Organizer amount": null, "Organizer checked": null, [sqlField]: null, version: expectedVersion },
    ] });
  }, 30_000);

  it("validates public dates and URLs and bounds filtered pagination without interpreting search as SQL", async () => {
    const { host } = await open();
    const publication = await host.activate(await prepare());
    for (const [index, invalid] of [{ Date: "2026-02-30" }, { Date: "22/09/2026" }, { Website: "javascript:alert(1)" },
      { Website: "https://example.com/has space" }, { Guests: "2" }, { Consent: "true" }].entries()) {
      await expect(invoke(host, publication, "submit", `invalid-${index}`, { ...submission, ...invalid }))
        .rejects.toThrow("Check the field values");
    }
    const ids: unknown[] = [];
    for (const [index, name] of ["Alice", "ALINA", "Bobby ' OR 1=1 --"].entries()) {
      ids.push((await invoke(host, publication, "submit", `row-${index}`, { ...submission, [maliciousLabel]: name })).result.id);
    }
    const page = await invoke(host, publication, "listResponses", "page", { search: "ali", offset: 1, limit: 1 });
    expect(page.result).toMatchObject({ total: 2, rows: [{ id: ids[1], [maliciousLabel]: "ALINA" }] });
    expect((await invoke(host, publication, "listResponses", "past-end", { offset: 3, limit: 1 })).result).toEqual({ total: 3, rows: [] });
    expect((await invoke(host, publication, "listResponses", "search-literal", { search: "' OR 1=1 --" })).result)
      .toMatchObject({ total: 1, rows: [{ id: ids[2] }] });
    for (const [index, input] of [{ limit: 51 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { search: "a".repeat(201) }].entries()) {
      await expect(invoke(host, publication, "listResponses", `invalid-page-${index}`, input)).rejects.toThrow("Check the field values");
    }
  }, 30_000);
});
