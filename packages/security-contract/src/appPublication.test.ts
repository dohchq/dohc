import { describe, expect, it } from "vitest";
import { parseAppPublicationCandidate, type AppPublicationCandidate } from "./appPublication";

const limits = { maxFiles: 512, maxMetadataBytes: 256 * 1024, maxBundleBytes: 32 * 1024 * 1024 };
const hash = "a".repeat(64);
const identity = (path: string) => ({ path, sha256: hash, byteLength: 1 });
function candidate(): AppPublicationCandidate {
  return { versionId: "main", appRoot: "app", entryPath: "app/main.ts", packageMap: {}, sourceRevision: hash, sourceDigest: hash,
    dependencyLockDigest: hash, bundleDigest: hash, buildDigest: hash,
    compilerIdentity: { recipe: "dohc-closed-app-v2", version: "0.28.1", binarySha256: hash },
    inputs: [identity("app/main.ts"), identity("app/backend.ts"), identity("app/schema.sql")],
    dependencies: ["app/main.ts", "app/backend.ts", "app/schema.sql"],
    files: [{ ...identity("bundle.js"), contentType: "text/javascript; charset=utf-8" },
      { ...identity("backend.js"), contentType: "text/javascript; charset=utf-8" },
      { ...identity("schema.sql"), contentType: "application/sql; charset=utf-8" }],
    capabilities: [{ kind: "app-backend", dataPath: "private/responses.sqlite", backendPath: "backend.js", schemaPath: "schema.sql",
      backendSha256: hash, schemaSha256: hash, schemaVersion: 1,
      operations: [{ name: "submit", access: "link", readOnly: false }], tables: [] }] };
}

describe("backend publication inventory", () => {
  it("accepts backend and schema files with an exact matching capability", () => {
    expect(parseAppPublicationCandidate(candidate(), limits).capabilities).toEqual(candidate().capabilities);
  });

  it.each(["backend.js", "schema.sql"])("refuses missing or mismatched %s", path => {
    const missing = candidate(); missing.files = missing.files.filter(file => file.path !== path);
    expect(() => parseAppPublicationCandidate(missing, limits)).toThrow(/backend files/);
    const mismatch = candidate(); mismatch.files.find(file => file.path === path)!.sha256 = "b".repeat(64);
    expect(() => parseAppPublicationCandidate(mismatch, limits)).toThrow(/backend files/);
  });

  it("refuses backend artifacts without a backend capability", () => {
    const value = candidate(); value.capabilities = [];
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/bundle path/);
  });

  it("refuses combined backend and collection authority", () => {
    const value = candidate();
    value.capabilities.push({ kind: "collection-create", collectionPath: "app/responses", schemaSha256: hash,
      allowedFields: ["name"], requiredFields: [], readFields: [] });
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/capabilities/);
  });

  it("does not allow backend artifacts to replace the browser script", () => {
    const value = candidate(); value.files = value.files.filter(file => file.path !== "bundle.js");
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/script is missing/);
  });

  it("bounds the combined browser and backend output size", () => {
    expect(() => parseAppPublicationCandidate(candidate(), { ...limits, maxBundleBytes: 2 })).toThrow(/bundle bound/);
    const value = candidate(); value.files[2]!.contentType = "text/javascript; charset=utf-8";
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/bundle type/);
  });
});

describe("dataset publication inventory", () => {
  const datasetId = "00000000-0000-4000-8000-000000000001";
  const operationId = "00000000-0000-4000-8000-000000000002";
  function datasetCandidate(): AppPublicationCandidate {
    const value = candidate();
    value.inputs = [identity("app/main.ts")];
    value.dependencies = ["app/main.ts"];
    value.files = value.files.filter(file => file.path === "bundle.js");
    value.capabilities = [{ kind: "dataset", datasetId, revision: 1, revisionSha256: hash, operationIds: [operationId],
      operations: [{ operationId, name: "submit", access: "link", readOnly: false }] }];
    return value;
  }

  it("accepts a frontend-only bundle bound to an independent dataset", () => {
    const value = datasetCandidate();
    expect(parseAppPublicationCandidate(value, limits)).toEqual(value);
  });

  it.each(["backend.js", "schema.sql"])("rejects consumer-provided %s replacement rules", path => {
    const value = datasetCandidate();
    value.files.push(candidate().files.find(file => file.path === path)!);
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/bundle path/);
  });

  it("rejects combined dataset and backend authority", () => {
    const value = datasetCandidate();
    value.capabilities.push(candidate().capabilities[0]!);
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/capabilities/);
  });
});
