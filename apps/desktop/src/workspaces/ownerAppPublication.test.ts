import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { compileClosedApp } from "./closedAppCompiler";
import { prepareOwnerAppPublication } from "./ownerAppPublication";
import { type AppDatasetBinding, type DatasetRevision } from "@dohc/security-contract/dataset";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
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
    if (request.method === "versionedText.list") {
      return { id: request.id, result: { nextAfterPath: null, files: [...sources].map(([path, bytes]) => ({ path, objectId: path, contentKind: "text",
        sha256: hash(bytes), byteLength: bytes.byteLength, binarySha256: null, updatedAtMs: 1, latestMomentId: "m", metadataOrigin: "disk", hasYdocMarker: false })) } };
    }
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

it("refuses retired app-owned backend declarations before compilation", async () => {
  const h = harness();
  await expect(h.prepare()).rejects.toThrow(/Invalid app publication declaration/);
  expect(h.compile).not.toHaveBeenCalled();
});

describe("app without app.publish.json", () => {
  const page = (h: ReturnType<typeof harness>, files: Record<string, string>) => {
    h.sources.clear();
    for (const [path, text] of Object.entries(files)) h.sources.set(path, Buffer.from(text));
  };

  it("publishes its folder as a static page with no capabilities", async () => {
    const h = harness();
    page(h, { "app/index.html": '<link rel="stylesheet" href="style.css"><h1>Trip</h1><script src="app.js"></script>',
      "app/style.css": "h1 { color: red }", "app/app.js": "document.title = 'Trip';", "app/notes.md": "# Notes", "app/dohc.json": "{}",
      "app/my notes.js": "", "other/index.html": "<p>Other</p>" });
    const { candidate, files } = await h.prepare();
    expect(h.capturePaths).toEqual([["app/index.html", "app/style.css", "app/app.js"]]);
    expect(candidate.entryPath).toBe("app/index.html");
    expect(candidate.capabilities).toEqual([]);
    expect(candidate.dependencies).toEqual(["app/app.js", "app/index.html", "app/style.css"]);
    expect(files.map(file => file.path)).toEqual(["bundle.css", "bundle.js"]);
  });

  it("names the missing page before capturing anything", async () => {
    const h = harness();
    page(h, { "app/style.css": "h1 { color: red }" });
    await expect(h.prepare()).rejects.toThrow("dohc found no index.html or app.publish.json in app. Add one to publish this app.");
    expect(h.capturePaths).toEqual([]);
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
