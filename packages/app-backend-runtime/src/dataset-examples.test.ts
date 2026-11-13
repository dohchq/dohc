import { readFileSync } from "node:fs";
import { privateFolder } from "./private-folder.test-helper";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transform } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { parseDatasetDefinition, parseAppDatasetReference, type AppDatasetBinding } from "@dohc/security-contract/dataset";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { createDatasetJournal } from "./journal.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { createDatasetHost } from "./dataset-host.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const read = (app: string, file: string) => readFileSync(new URL(`../../../examples/${app}/${file}`, import.meta.url), "utf8");
const receipt = { fileId: "receipt_1234567890", name: "receipt.png", contentType: "image/png", byteLength: 128, sha256: "a".repeat(64) };
type Context = "owner" | "helper" | "friend";
type Result = Record<string, any>;

async function fixture(app = "fundraiser") {
  const definition = parseDatasetDefinition(JSON.parse(read(app, "dataset.json")));
  const schemaSql = read(app, "schema.sql"), operationSource = read(app, "backend.ts");
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const declaration = JSON.parse(read(app, app === "fundraiser" ? "app.publish.json" : "app.binding.json"));
  const reference = parseAppDatasetReference(declaration.dataset ?? declaration);
  expect(reference.datasetPath).toBe(`${app}/dataset.json`);
  const { datasetPath, ...fields } = reference;
  const resolved = parseDatasetDefinition(JSON.parse(readFileSync(new URL(`../../../examples/${datasetPath}`, import.meta.url), "utf8")));
  const binding: AppDatasetBinding = { ...fields, datasetId: resolved.datasetId };
  expect(binding.revisionSha256).toBe(revision.revisionSha256);
  if (declaration.inputs) expect(declaration.inputs.map((path: string) => `${app}/${path}`)).not.toEqual(expect.arrayContaining([definition.schemaPath, definition.operationsPath]));
  const directory = await mkdtemp(join(tmpdir(), "dohc-example-dataset-"));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE attachments(file_id TEXT PRIMARY KEY);");
  function transaction<T>(run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = run(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const journal = createDatasetJournal({ db, transaction });
  const supervisor = await createDatasetSupervisor({ journal, directory: privateFolder(join(directory, "workers")) });
  cleanups.push(async () => { await supervisor.close(); db.close(); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); });
  const host = createDatasetHost<Context>({ db, transaction, journal, supervisor,
    resolveAuthority(context, request) {
      if (request.workspaceId !== "workspace") throw new Error("Wrong workspace");
      if (request.access.kind === "app" && !["form", "admin"].includes(request.access.appId)) throw new Error("Wrong app credential");
      return { principalKey: context, ...(request.access.kind === "app" ? { appId: request.access.appId } : {}),
        caller: context === "owner" ? { kind: "owner", userId: "owner" } : context === "helper"
          ? { kind: "named", userId: "helper", grantId: "source-view", access: "view", helper: false }
          : { kind: "link", principalId: "participant", grantId: "public" } };
    },
    compileOperations: async source => (await transform(source, { loader: "ts", target: "es2022" })).code,
    operationResources: () => ({ files: [receipt], accountAndAttach: candidate => {
      for (const fileId of candidate.attachedFileIds) db.prepare("INSERT OR IGNORE INTO attachments VALUES(?)").run(fileId);
    } }),
  });
  const scope = { workspaceId: "workspace", datasetId: definition.datasetId };
  await host.activate("owner", { workspaceId: "workspace", revision, schemaSql, operationSource });
  const operation = (name: string) => definition.operations.find(operation => operation.name === name)!;
  host.setBinding("owner", { ...scope, appId: "form", binding: { ...binding, operationIds: definition.operations.filter(operation => operation.access === "link").map(operation => operation.operationId) } });
  host.setBinding("owner", { ...scope, appId: "admin", binding });
  host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: revision.revisionSha256,
    operationIds: definition.operations.filter(operation => operation.access === "helper").map(operation => operation.operationId), discover: true } });
  let sequence = 0;
  async function call(name: string, input: AppBackendJson = {}, context: Context = "friend", appId?: string, idempotencyKey = `call-${++sequence}`) {
    return host.invoke(context, { ...scope, revision: 1, revisionSha256: revision.revisionSha256, operationId: operation(name).operationId,
      input, idempotencyKey, ...(appId ? { access: { kind: "app", appId } as const } : {}) });
  }
  async function result(name: string, input: AppBackendJson = {}, context: Context = "friend", appId?: string) {
    return (await call(name, input, context, appId)).result as Result;
  }
  const field = (table: string, column: string) => definition.tables.find(t => t.sqlName === table)!.fields.find(f => f.type !== "button" && f.sqlColumn === column)!.fieldId;
  return { host, db, scope, definition, revision, binding, operation, call, result, field };
}

const group = (sessionId: string, count = 1) => ({ sessionId, players: Array.from({ length: count }, (_, index) => `Player Person${index}`), spectators: [] });
function registration(sessions: AppBackendJson[] = [group("s1")]) {
  return { fullName: "Synthetic Contact", mobile: "0917 123 4567", sessions, paymentMethod: "gcash", receiptFileId: receipt.fileId,
    submissionId: randomUUID(), retrySecret: randomBytes(32).toString("base64url"), receiptSha256: receipt.sha256 };
}

it("shares fundraiser records and rules across the public app, admin app, and Collection", async () => {
  const f = await fixture();
  const input = registration([{ sessionId: "s1", players: ["First Player", "Second Player"], spectators: ["Watching Friend"] }, group("s2")]);
  const accepted = await f.call("register", input, "friend", "form", "submission");
  const saved = accepted.result as Result;
  expect(saved).toMatchObject({ total: 3150, version: 1, status: "pending_verification" });
  expect(f.db.prepare("SELECT * FROM attachments").all()).toEqual([{ file_id: receipt.fileId }]);
  expect((await f.call("register", input, "friend", "form", "submission")).replayed).toBe(true);
  expect(await f.result("register", input, "friend", "form")).toEqual(saved);
  const rows = await f.result("tableRegistrations", {}, "owner");
  expect(rows).toMatchObject({ rows: [{ id: saved.id, version: 1, values: { [f.field("registrations", "total_php")]: 3150 } }], nextCursor: null });
  expect(JSON.stringify(rows)).not.toContain(saved.statusToken);
  expect(JSON.stringify(rows)).not.toContain(input.retrySecret);
  const status = await f.result("lookupStatus", { token: saved.statusToken }, "friend", "form");
  expect(status).not.toHaveProperty("mobile"); expect(status).not.toHaveProperty("receiptFileId");
  expect(status.attendees.every((person: object) => !("reclubSynced" in person))).toBe(true);
  const people = (await f.result("attendees", {}, "helper", "admin")).records as Result[];
  const player = people.find(person => person.role === "player" && person.sessionId === "s1")!;
  await f.result("setPlayerReclub", { attendeeId: player.id, synced: true }, "helper", "admin");
  const checklist = await f.result("tableAttendees", {}, "owner");
  expect(checklist.rows.find((row: Result) => row.id === player.id).values[f.field("attendees", "reclub_synced")]).toBe(true);
  const statusField = f.field("registrations", "status");
  const boardGroup = {fieldId:statusField,value:"pending_verification"};
  expect(await f.result("tableRegistrations", {group:boardGroup}, "owner")).toMatchObject({group:boardGroup,rows:[{id:saved.id}]});
  expect(await f.result("tableRegistrations", {groupBy:statusField,limit:8}, "owner")).toEqual({groupBy:statusField,groups:["pending_verification"],nextGroupCursor:null});
  expect((await f.result("tableRegistrations", {group:{fieldId:statusField,value:"verified"}}, "owner")).rows).toEqual([]);
  const edited = await f.result("editRegistrationStatus", { id: saved.id, expectedVersion: 1, values: { [statusField]: "rejected" } }, "owner");
  expect(edited).toEqual({ id: saved.id, version: 2, priorValues: { [statusField]: "pending_verification" } });
  expect(f.host.history("owner", f.scope).entries[0]!.undo).toMatchObject({ operationId: f.operation("editRegistrationStatus").operationId,
    recordId: saved.id, expectedVersion: 2, fields: [{ fieldId: statusField, value: "pending_verification" }] });
  expect((await f.result("listPublicSessions", {}, "friend", "form") as any[]).map(row => row.available)).toEqual([36, 36]);
  await expect(f.call("setPlayerReclub", { attendeeId: player.id, synced: false }, "helper", "admin")).rejects.toMatchObject({ refusal: { code: "not_found" } });
  await f.result("editRegistrationStatus", { id: saved.id, expectedVersion: 2, values: edited.priorValues }, "owner");
  expect((await f.result("attendees", {}, "helper", "admin")).records.find((row: Result) => row.id === player.id).reclubSynced).toBe(true);
  await f.result("setStatus", { id: saved.id, status: "verified", expectedVersion: 3 }, "helper", "admin");
  expect((await f.result("tableRegistrations", {}, "owner")).rows[0]).toMatchObject({ version: 4, values: { [statusField]: "verified" } });
  await expect(f.call("editRegistrationStatus", { id: saved.id, expectedVersion: 3, values: edited.priorValues }, "owner")).rejects.toMatchObject({ refusal: { code: "conflict" } });
});

