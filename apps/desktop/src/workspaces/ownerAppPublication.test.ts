import { describe, expect, it, vi } from "vitest";
import { compileClosedApp } from "./closedAppCompiler";
import { prepareOwnerAppPublication } from "./ownerAppPublication";
import { type AppDatasetBinding, type DatasetRevision } from "@dohc/security-contract/dataset";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";

const backend = { entryPath: "app/backend.ts", schemaPath: "app/schema.sql", dataPath: "private/registrations.sqlite", schemaVersion: 1,
  operations: [{ name: "register", access: "link", readOnly: false }, { name: "list", access: "owner", readOnly: true }],
  tables: [{ name: "registrations", primaryKey: "id", readOperation: "list", writeOperation: "register" }] };
function harness(resolveDatasetRevision?: (binding: AppDatasetBinding) => Promise<DatasetRevision>) {
  const declaration = { entryPath: "main.ts", inputs: ["main.ts", "backend.ts", "schema.sql", "rules.ts"], packageMap: {}, backend };
  const sources = new Map([
    ["app/app.publish.json", JSON.stringify(declaration)],
    ["app/main.ts", "document.body.textContent = 'Register';"],
    ["app/backend.ts", "import { capacity } from './rules.ts'; globalThis.operations = { register: () => capacity, list: () => [] };"],
    ["app/rules.ts", "export const capacity: number = 20;"],
    ["app/schema.sql", "CREATE TABLE registrations(id TEXT PRIMARY KEY);"],
  ]);
  const capturePaths: string[][] = [], listCalls: Record<string, unknown>[] = [];
  const hooks = { onCapture: () => {} };
  const adapter = sourceCaptureAdapter(sources, { onRequest(method, params) {
    if (method === "versionedText.list") listCalls.push(params);
    if (method === "versionedText.captureSources") { capturePaths.push(params.paths as string[]); if (capturePaths.length > 1) hooks.onCapture(); }
  } });
  const compile = vi.fn(compileClosedApp);
  const controller = new AbortController();
  const prepare = (appRoot = "app", shared = [appRoot]) => prepareOwnerAppPublication({ workspaceId: "w", appRoot, shareId: "s", grantId: "g" },
    { shareId: "s", grantId: "g", generation: 1, status: "active", revokedAtMs: null, selector: { paths: shared, versionId: null } },
    { adapter, compile, signal: controller.signal, assertCurrent() {}, resolveDatasetRevision });
  return { declaration, sources, compile, capturePaths, listCalls, hooks, prepare, controller,
    setDeclaration(value: unknown) { sources.set("app/app.publish.json", JSON.stringify(value)); } };
}

it("refuses retired app-owned backend declarations before compilation", async () => {
  const h = harness();
  await expect(h.prepare()).rejects.toThrow("app/app.publish.json must hold entryPath, inputs, and packageMap, and at most one of collection or dataset.");
  expect(h.compile).not.toHaveBeenCalled();
});

describe("app.publish.json paths", () => {
  const manifest = { entryPath: "main.ts", inputs: ["main.ts", "deps/greeting.js", "../shared/theme.css"], packageMap: { greeting: "deps/greeting.js" } };
  const place = (h: ReturnType<typeof harness>, root: string, parent: string, value: unknown = manifest) => {
    h.sources.clear();
    h.sources.set(`${root}/app.publish.json`, JSON.stringify(value));
    h.sources.set(`${root}/main.ts`, "import greeting from 'greeting'; import '../shared/theme.css'; document.body.textContent = greeting;");
    h.sources.set(`${root}/deps/greeting.js`, "export default 'Hello';");
    h.sources.set(`${parent}shared/theme.css`, "body { color: teal }");
  };

  it.each([["app", ""], ["trip/app", "trip/"]])("resolves every path from the app folder at %s, so a moved folder publishes unchanged", async (root, parent) => {
    const h = harness(); place(h, root, parent);
    const { candidate, files } = await h.prepare(root, [root, `${parent}shared`]);
    expect(candidate.entryPath).toBe(`${root}/main.ts`);
    expect(candidate.inputs.map(file => file.path)).toEqual([`${root}/app.publish.json`, `${root}/deps/greeting.js`, `${root}/main.ts`, `${parent}shared/theme.css`].sort());
    expect(candidate.packageMap).toEqual({ greeting: `${root}/deps/greeting.js` });
    expect(files.map(file => file.path)).toEqual(["bundle.css", "bundle.js"]);
    expect(h.listCalls).toEqual([{ versionId: "main", limit: 500, afterPath: `${root}/` }]);
  });

  it("names a listed file that does not exist, such as a path written from the workspace root", async () => {
    const h = harness(); place(h, "app", "", { entryPath: "app/main.ts", inputs: ["app/main.ts"], packageMap: {} });
    await expect(h.prepare("app", ["app", "shared"])).rejects.toThrow("app/app.publish.json lists app/app/main.ts, which does not exist. Write its paths relative to app.");
    expect(h.capturePaths).toEqual([["app/app.publish.json"], ["app/app.publish.json", "app/app/main.ts"]]);
    expect(h.compile).not.toHaveBeenCalled();
  });

  it.each([
    ["../../main.ts", "app/app.publish.json lists ../../main.ts, which is outside the workspace."],
    ["/main.ts", "app/app.publish.json lists /main.ts. Write the path relative to app, without a leading /."],
    ["", "app/app.publish.json names no file in entryPath."],
  ])("names the path in %j and why it cannot be published", async (entryPath, message) => {
    const h = harness(); place(h, "app", "", { entryPath, inputs: [entryPath], packageMap: {} });
    await expect(h.prepare("app", ["app", "shared"])).rejects.toThrow(message);
    expect(h.compile).not.toHaveBeenCalled();
  });

  it("names a file beside the folder that the chosen link does not share", async () => {
    const h = harness(); place(h, "app", "");
    await expect(h.prepare("app", ["app"])).rejects.toThrow("app/app.publish.json lists shared/theme.css, which is outside this link's shared files. Choose a link that includes it.");
    expect(h.capturePaths).toEqual([["app/app.publish.json"]]);
  });

  it("names the missing app.publish.json after the engine refuses to capture it", async () => {
    const h = harness(); place(h, "app", "");
    h.hooks.onCapture = () => { h.sources.delete("app/app.publish.json"); };
    await expect(h.prepare("app", ["app", "shared"])).rejects.toThrow("app/app.publish.json changed while dohc prepared the app. Prepare the app again.");
    expect(h.listCalls).toEqual([
      { versionId: "main", limit: 500, afterPath: "app/" },
      { versionId: "main", limit: 500 },
    ]);
    expect(h.compile).not.toHaveBeenCalled();
  });

  it("names a file that disappears while dohc captures the app", async () => {
    const h = harness(); place(h, "app", "");
    h.hooks.onCapture = () => { h.sources.delete("app/deps/greeting.js"); };
    await expect(h.prepare("app", ["app", "shared"])).rejects.toThrow("app/app.publish.json lists app/deps/greeting.js, which does not exist. Write its paths relative to app.");
  });
});

describe("app without app.publish.json", () => {
  const page = (h: ReturnType<typeof harness>, files: Record<string, string>) => {
    h.sources.clear();
    for (const [path, text] of Object.entries(files)) h.sources.set(path, text);
  };

  it("publishes its folder as a static page with no capabilities", async () => {
    const h = harness();
    page(h, { "app/index.html": '<!doctype html><link rel="stylesheet" href="style.css"><h1>Trip</h1><script src="App.JS"></script>',
      "app/style.css": "h1 { color: red }", "app/App.JS": "document.title = 'Trip';", "app/notes.md": "# Notes", "app/dohc.json": "{}",
      "app/my notes.js": "", "other/index.html": "<p>Other</p>" });
    const { candidate, files } = await h.prepare();
    expect(h.capturePaths).toEqual([["app/index.html", "app/App.JS", "app/style.css"]]);
    expect(candidate.entryPath).toBe("app/index.html");
    expect(candidate.capabilities).toEqual([]);
    expect(candidate.dependencies).toEqual(["app/App.JS", "app/index.html", "app/style.css"]);
    expect(files.map(file => file.path)).toEqual(["bundle.js", "page.json"]);
  });

  it("names the missing page before capturing anything", async () => {
    const h = harness();
    page(h, { "app/style.css": "h1 { color: red }" });
    await expect(h.prepare()).rejects.toThrow("dohc found no index.html or app.publish.json in app. Add one to publish this app.");
    expect(h.capturePaths).toEqual([]);
  });

  it("names a file the page links but the folder cannot publish", async () => {
    const h = harness();
    page(h, { "app/index.html": '<!doctype html><img alt="Map" src="my%20map.png">', "app/my map.png": "png" });
    await expect(h.prepare()).rejects.toThrow("app/index.html links my map.png. Rename it without spaces or symbols, then publish again.");
  });

  it("includes every type the compiler accepts, and leaves out build configuration and installed packages", async () => {
    const h = harness();
    page(h, { "app/index.html": '<!doctype html><script type="module" src="main.ts"></script>', "app/main.ts": "import data from './data.json'; document.title = data.title;",
      "app/data.json": '{"title":"Trip"}', "app/package.json": "{}", "app/tsconfig.json": "{}", "app/dohc.json": "{}",
      "app/node_modules/x/index.js": "", "app/.cache/x.js": "" });
    const { candidate } = await h.prepare();
    expect(h.capturePaths).toEqual([["app/index.html", "app/data.json", "app/main.ts"]]);
    expect(candidate.dependencies).toEqual(["app/data.json", "app/index.html", "app/main.ts"]);
  });

  it("names a linked file of a type the compiler does not take", async () => {
    const h = harness();
    page(h, { "app/index.html": '<!doctype html><script type="module" src="main.ts"></script>', "app/main.ts": "import './notes.yaml';", "app/notes.yaml": "a: 1" });
    await expect(h.prepare()).rejects.toThrow("app/main.ts imports ./notes.yaml. Published apps can include only JavaScript, TypeScript, JSON, CSS, images, and WOFF2 fonts, not .yaml.");
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
  const declaration = { entryPath: "main.ts", inputs: ["main.ts"], packageMap: {}, dataset: binding };

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

  it("does not accept link read approval from app source", async () => {
    const revision = structuredClone(approved);
    revision.definition.operations[1]!.access = "helper";
    const h = harness(async () => revision);
    h.setDeclaration({ ...declaration, dataset: { ...binding, operationIds: [id(5)], linkReads: [{ operationId: id(5), fieldIds: [id(3)] }] } });
    const { candidate } = await h.prepare();
    expect(candidate.capabilities[0]).not.toHaveProperty("linkReads");
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

it.each(["会议", "Cafe\u0301"])("publishes Unicode source names from disk without renaming %s", root => {
  const h = harness(); h.sources.clear();
  h.sources.set(root + "/index.html", '<!doctype html><script src="' + encodeURIComponent("скрипт.js") + '"></script>');
  h.sources.set(root + "/скрипт.js", 'document.title = "Ready";');
  return expect(h.prepare(root)).resolves.toMatchObject({ candidate: { appRoot: root, entryPath: root + "/index.html" } });
});
