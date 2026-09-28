import { describe, expect, it } from "vitest";
import { parseAppPublicationCandidate, type AppPublicationCandidate } from "./appPublication";

const limits = { maxFiles: 512, maxMetadataBytes: 256 * 1024, maxBundleBytes: 32 * 1024 * 1024 };
const hash = "a".repeat(64);
const identity = (path: string) => ({ path, sha256: hash, byteLength: 1 });
function candidate(): AppPublicationCandidate {
  return { versionId: "main", appRoot: "app", entryPath: "app/main.ts", packageMap: {}, sourceRevision: hash, sourceDigest: hash,
    dependencyLockDigest: hash, bundleDigest: hash, buildDigest: hash,
    compilerIdentity: { recipe: "dohc-closed-app-v3", version: "0.28.1", binarySha256: hash },
    inputs: [identity("app/main.ts")], dependencies: ["app/main.ts"],
    files: [{ ...identity("bundle.js"), contentType: "text/javascript; charset=utf-8" }], capabilities: [] };

}

describe("bundle files", () => {
  const page = { ...identity("page.json"), contentType: "application/json; charset=utf-8" };
  const style = { ...identity("bundle.css"), contentType: "text/css; charset=utf-8" };

  it("accepts a page record beside the script and styles", () => {
    const value = { ...candidate(), entryPath: "app/index.html", inputs: [identity("app/index.html")], dependencies: ["app/index.html"] };
    value.files = [...value.files, style, page];
    expect(parseAppPublicationCandidate(value, limits).files.map(file => file.path)).toEqual(["bundle.css", "bundle.js", "page.json"]);
  });

  it.each([
    ["a page record typed as a script", [{ ...page, contentType: "text/javascript; charset=utf-8" }]],
    ["another bundle file", [{ ...identity("page.html"), contentType: "text/html; charset=utf-8" }]],
    ["a duplicate page record", [page, page]],
  ])("rejects %s", (_name, extra) => {
    const value = candidate();
    value.files = [...value.files, ...extra];
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow();
  });
});

it("rejects retired app-owned backend capabilities", () => {
  expect(() => parseAppPublicationCandidate({ ...candidate(), capabilities: [{ kind: "app-backend" }] }, limits)).toThrow();
});

describe("dataset publication inventory", () => {
  const datasetId = "00000000-0000-4000-8000-000000000001";
  const operationId = "00000000-0000-4000-8000-000000000002";
  function datasetCandidate(): AppPublicationCandidate {
    const value = candidate();
    value.inputs = [identity("app/main.ts")];
    value.dependencies = ["app/main.ts"];
    value.files = value.files.filter(file => file.path === "bundle.js");
    value.capabilities = [{ kind: "dataset", name: "Orders", datasetId, revision: 1, revisionSha256: hash, operationIds: [operationId],
      operations: [{ operationId, name: "submit", access: "link", readOnly: false }] }];
    return value;
  }

  it("accepts a frontend-only bundle bound to an independent dataset", () => {
    const value = datasetCandidate();
    expect(parseAppPublicationCandidate(value, limits)).toEqual(value);
  });

  it.each(["backend.js", "schema.sql"])("rejects consumer-provided %s replacement rules", path => {
    const value = datasetCandidate();
    value.files.push({ ...identity(path), contentType: path === "schema.sql" ? "application/sql; charset=utf-8" : "text/javascript; charset=utf-8" });
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/bundle path/);
  });

  it("rejects combined dataset and document collection authority", () => {
    const value = datasetCandidate();
    value.capabilities.push({ kind: "collection-create", collectionPath: "app/responses", schemaSha256: hash, allowedFields: ["name"], requiredFields: [], readFields: [] });
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/capabilities/);
  });
});
