import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { compileClosedApp } from "./closedAppCompiler";
import { prepareOwnerAppPublication } from "./ownerAppPublication";
import { type AppDatasetBinding, type DatasetRevision } from "@dohc/security-contract/dataset";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const digest = (domain: string, value: unknown) => hash(JSON.stringify([domain, value]));
const backend = { entryPath: "app/backend.ts", schemaPath: "app/schema.sql", dataPath: "private/registrations.sqlite", schemaVersion: 1,
  operations: [{ name: "register", access: "link", readOnly: false }, { name: "list", access: "owner", readOnly: true }],
  tables: [{ name: "registrations", primaryKey: "id", readOperation: "list", writeOperation: "register" }] };
function harness(resolveDatasetRevision?: (binding: AppDatasetBinding) => Promise<DatasetRevision>) {
  const declaration = { entryPath: "app/main.ts", inputs: ["app/main.ts", "app/backend.ts", "app/schema.sql", "app/rules.ts"], packageMap: {}, backend };
  const sources = new Map([
    ["app/app.publish.json", Buffer.from(JSON.stringify(declaration))],
    ["app/main.ts", Buffer.from("document.body.textContent = 'Register';")],
    ["app/backend.ts", Buffer.from("import { capacity } from './rules.ts'; globalThis.operations = { register: () => capacity, list: () => [] };")],
    ["app/rules.ts", Buffer.from("export const capacity: number = 20;")],
    ["app/schema.sql", Buffer.from("CREATE TABLE registrations(id TEXT PRIMARY KEY);")],
  ]);
  const blobs = new Map<string, Uint8Array>();
  const capturePaths: string[][] = [];
  const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
    const params = request.params as Record<string, unknown>;
    if (request.method === "versionedText.captureSources") {
      const paths = params.paths as string[];
      capturePaths.push(paths);
      const files = [...paths].sort().map(path => {
        const bytes = sources.get(path)!;
        const sha256 = hash(bytes); blobs.set(sha256, Uint8Array.from(bytes));
        return { path, objectId: path, contentKind: "text", sha256, byteLength: bytes.byteLength, latestMomentId: "m" };
      });
      return { id: request.id, result: { workspaceId: "w", versionId: "main", files, totalBytes: files.reduce((total, file) => total + file.byteLength, 0),
        sourceDigest: hash(JSON.stringify(["dohc-source-capture-v1", "w", "main", files])) } };
    }
    const bytes = blobs.get(String(params.sha256))!;
    return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
  } }, "owner", { workspaceId: "w" });
  const compile = vi.fn(compileClosedApp);
  const controller = new AbortController();
  const prepare = () => prepareOwnerAppPublication({ workspaceId: "w", appRoot: "app", shareId: "s", grantId: "g" },
    { shareId: "s", grantId: "g", generation: 1, status: "active", revokedAtMs: null, selector: { paths: ["app"], versionId: null } },
    { adapter, compile, signal: controller.signal, assertCurrent() {}, resolveDatasetRevision });
  return { declaration, sources, compile, capturePaths, prepare, controller,
    setDeclaration(value: unknown) { sources.set("app/app.publish.json", Buffer.from(JSON.stringify(value))); } };
}

describe("owner backend publication", () => {
  it("captures both entries together, compiles separately and binds schema, dependencies and all outputs", async () => {
    const h = harness();
    const { candidate, files } = await h.prepare();
    expect(h.compile.mock.calls.map(([request]) => request.entryPath)).toEqual(["app/main.ts", "app/backend.ts"]);
    expect(h.compile.mock.calls[0]![0].inputs).toEqual(h.compile.mock.calls[1]![0].inputs);
    expect(h.capturePaths.flat()).not.toContain(backend.dataPath);
    expect(candidate.dependencies).toEqual(["app/backend.ts", "app/main.ts", "app/rules.ts", "app/schema.sql"]);
    expect(files.map(file => file.path)).toEqual(["backend.js", "bundle.js", "schema.sql"]);
    expect(new TextDecoder().decode(files.find(file => file.path === "bundle.js")!.bytes)).not.toContain("operations");
    expect(new TextDecoder().decode(files.find(file => file.path === "backend.js")!.bytes)).toContain("globalThis.operations");
    expect(candidate.capabilities).toEqual([{ kind: "app-backend", dataPath: backend.dataPath, schemaVersion: 1,
      backendPath: "backend.js", backendSha256: files[0]!.sha256, schemaPath: "schema.sql", schemaSha256: files[2]!.sha256,
      operations: [...backend.operations].sort((a, b) => a.name.localeCompare(b.name)), tables: backend.tables }]);
    expect(candidate.sourceDigest).toBe(digest("dohc-app-source-v2", { entry: candidate.entryPath, files: candidate.inputs, packages: [] }));
    expect(candidate.dependencyLockDigest).toBe(digest("dohc-app-dependencies-v1", candidate.inputs.filter(file => candidate.dependencies.includes(file.path))));
    expect(candidate.bundleDigest).toBe(digest("dohc-app-bundle-v1", candidate.files));
    expect(candidate.buildDigest).toBe(digest("dohc-app-build-v1", { sourceDigest: candidate.sourceDigest,
      dependencyLockDigest: candidate.dependencyLockDigest, compiler: candidate.compilerIdentity, bundleDigest: candidate.bundleDigest }));
    h.sources.set("app/schema.sql", Buffer.from("CREATE TABLE registrations(id TEXT PRIMARY KEY, name TEXT);"));
    const changed = await h.prepare();
    expect(changed.candidate.sourceDigest).not.toBe(candidate.sourceDigest);
    expect(changed.candidate.dependencyLockDigest).not.toBe(candidate.dependencyLockDigest);
    expect(changed.candidate.bundleDigest).not.toBe(candidate.bundleDigest);
  });

  it.each(["collection", "unknown", "undeclared", "outside"])("refuses %s backend declarations before compilation", async kind => {
    const h = harness();
    if (kind === "collection") h.setDeclaration({ ...h.declaration, collection: {} });
    if (kind === "unknown") h.setDeclaration({ ...h.declaration, backend: { ...backend, environment: {} } });
    if (kind === "undeclared") h.setDeclaration({ ...h.declaration, inputs: ["app/main.ts"] });
    if (kind === "outside") h.setDeclaration({ ...h.declaration, inputs: [...h.declaration.inputs, "private/backend.ts"], backend: { ...backend, entryPath: "private/backend.ts" } });
    await expect(h.prepare()).rejects.toThrow();
    expect(h.compile).not.toHaveBeenCalled();
  });

  it("refuses a backend imported into the browser bundle", async () => {
    const h = harness(); h.sources.set("app/main.ts", Buffer.from("import './backend.ts';"));
    await expect(h.prepare()).rejects.toThrow(/browser app must not import/);
  });

  it("refuses CSS outputs from backend dependencies", async () => {
    const h = harness(); h.setDeclaration({ ...h.declaration, inputs: [...h.declaration.inputs, "app/style.css"] });
    h.sources.set("app/backend.ts", Buffer.from("import './style.css'; globalThis.operations = {};"));
    h.sources.set("app/style.css", Buffer.from("body { color: red }"));
    await expect(h.prepare()).rejects.toThrow(/without CSS/);
  });

  it.each(["missing", "compiler"])("refuses %s backend compile output", async kind => {
    const h = harness();
    h.compile.mockImplementation(async request => {
      const built = await compileClosedApp(request);
      if (request.entryPath === backend.entryPath) {
        if (kind === "missing") built.files = [];
        else built.compiler.binarySha256 = "a".repeat(64);
      }
      return built;
    });
    await expect(h.prepare()).rejects.toThrow();
  });

  it("stops after cancellation between browser and backend compilation", async () => {
    const h = harness();
    h.compile.mockImplementationOnce(async request => { const result = await compileClosedApp(request); h.controller.abort(); return result; });
    await expect(h.prepare()).rejects.toMatchObject({ name: "AbortError" });
    expect(h.compile).toHaveBeenCalledTimes(1);
  });
});

describe("owner dataset publication", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const approved: DatasetRevision = { datasetId: id(1), revision: 1, revisionSha256: "a".repeat(64), definitionSha256: "b".repeat(64),
    schemaSha256: "c".repeat(64), operationsSha256: "d".repeat(64), definition: {
      formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "private/schema.sql", operationsPath: "private/operations.js",
      tables: [{ tableId: id(2), name: "People", sqlName: "people", primaryKey: "id", fields: [
        { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
      ] }], operations: [
        { operationId: id(4), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [] },
        { operationId: id(5), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] },
      ],
    } };
  const binding: AppDatasetBinding = { kind: "dataset", datasetId: approved.datasetId, revision: approved.revision,
    revisionSha256: approved.revisionSha256, operationIds: [id(4)] };
  const declaration = { entryPath: "app/main.ts", inputs: ["app/main.ts"], packageMap: {}, dataset: binding };

  it("captures and compiles only frontend sources and derives dispatch metadata from the catalog", async () => {
    const resolve = vi.fn(async () => approved);
    const h = harness(resolve); h.setDeclaration(declaration);
    const { candidate, files } = await h.prepare();
    expect(resolve).toHaveBeenCalledWith(binding);
    expect(h.compile).toHaveBeenCalledTimes(1);
    expect(h.capturePaths).toEqual([["app/app.publish.json"], ["app/app.publish.json", "app/main.ts"]]);
    expect(files.map(file => file.path)).toEqual(["bundle.js"]);
    expect(candidate.capabilities).toEqual([{ ...binding, operations: [{ operationId: id(4), name: "submit", access: "link", readOnly: false }] }]);
  });

  it("does not treat a source declaration as dataset approval", async () => {
    const h = harness(); h.setDeclaration(declaration);
    await expect(h.prepare()).rejects.toThrow(/Collection is unavailable/);
    expect(h.compile).not.toHaveBeenCalled();
  });

  it.each(["stale", "unknown", "source", "operations", "backend"])("refuses %s dataset bindings before compilation", async kind => {
    const resolve = vi.fn(async () => approved);
    const h = harness(resolve);
    let value: unknown = declaration;
    if (kind === "stale") value = { ...declaration, dataset: { ...binding, revision: 2 } };
    if (kind === "unknown") value = { ...declaration, dataset: { ...binding, operationIds: [id(99)] } };
    if (kind === "source") value = { ...declaration, dataset: { ...binding, source: "replace rules" } };
    if (kind === "operations") value = { ...declaration, dataset: { ...binding, operations: [{ name: "submit", access: "link", readOnly: true }] } };
    if (kind === "backend") value = { ...declaration, backend };
    h.setDeclaration(value);
    await expect(h.prepare()).rejects.toThrow();
    expect(h.compile).not.toHaveBeenCalled();
    if (["source", "operations", "backend"].includes(kind)) expect(resolve).not.toHaveBeenCalled();
  });

  it("honors cancellation after catalog resolution", async () => {
    const h = harness(async () => { h.controller.abort(); return approved; });
    h.setDeclaration(declaration);
    await expect(h.prepare()).rejects.toMatchObject({ name: "AbortError" });
    expect(h.compile).not.toHaveBeenCalled();
  });
});
